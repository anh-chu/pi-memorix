/**
 * pi-memorix
 *
 * Bridges Memorix memory hooks into Pi's extension event system.
 * Mirrors what Memorix does via .claude/settings.json hooks, but for Pi.
 *
 * Covered hooks:
 *   session_start         → SessionStart  (load previous context)
 *   before_agent_start    → UserPromptSubmit (inject relevant memories per turn)
 *   session_before_compact→ PreCompact    (save context before compaction)
 *   session_shutdown      → Stop          (end session, store summary)
 *
 * PostToolUse is intentionally skipped — Memorix's git hooks and the LLM's
 * own MCP tool calls (via CLAUDE.md rules) already cover auto-capture.
 *
 * Requirements:
 *   - memorix must be on PATH (npm install -g memorix)
 *   - Works in both interactive TUI and RPC/headless Pi modes
 *   - All memorix failures are silent; set MEMORIX_PI_DEBUG=1 to see them
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

// ─── Types ────────────────────────────────────────────────────────────────────

type HookEventName = "SessionStart" | "UserPromptSubmit" | "PreCompact" | "Stop";

type HookResult =
	| { ok: true; systemMessage: string }
	| { ok: false };

type ContentBlock = {
	type?: string;
	text?: string;
};

type SessionEntry = {
	type: string;
	message?: {
		role?: string;
		content?: unknown;
	};
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const debug = (msg: string) => {
	if (process.env.MEMORIX_PI_DEBUG) {
		console.error(`[memorix-pi] ${msg}`);
	}
};

/**
 * Call `memorix hook` as a subprocess, piping JSON to stdin.
 * Returns the systemMessage from stdout, or { ok: false } on any failure.
 */
function runMemorixHook(
	eventName: HookEventName,
	payload: Record<string, unknown>,
	timeoutMs = 5000,
	signal?: AbortSignal,
): Promise<HookResult> {
	return new Promise((resolve) => {
		if (memorixUnavailable) {
			return resolve({ ok: false });
		}

		let child: ReturnType<typeof spawn>;
		try {
			child = spawn("memorix", ["hook", "--agent", "pi"], {
				stdio: ["pipe", "pipe", "pipe"],
				env: process.env,
			});
		} catch {
			memorixUnavailable = true;
			return resolve({ ok: false });
		}

		let stdout = "";
		let settled = false;

		const settle = (result: HookResult) => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				resolve(result);
			}
		};

		const timer = setTimeout(() => {
			debug(`${eventName} timed out after ${timeoutMs}ms`);
			try { child.kill("SIGTERM"); } catch { /* ignore */ }
			settle({ ok: false });
		}, timeoutMs);

		signal?.addEventListener("abort", () => {
			try { child.kill("SIGTERM"); } catch { /* ignore */ }
			settle({ ok: false });
		}, { once: true });

		child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });

		child.stderr.on("data", (d: Buffer) => {
			debug(`memorix stderr: ${d.toString().trim()}`);
		});

		child.on("error", (err: NodeJS.ErrnoException) => {
			if (err.code === "ENOENT") {
				memorixUnavailable = true;
				debug("memorix not found on PATH — hooks disabled");
			} else {
				debug(`spawn error: ${err.message}`);
			}
			settle({ ok: false });
		});

		child.on("close", () => {
			try {
				const parsed = stdout.trim() ? JSON.parse(stdout) : {};
				const systemMessage: string =
					parsed.systemMessage ??
					parsed.hookSpecificOutput?.additionalContext ??
					"";
				settle({ ok: true, systemMessage: String(systemMessage) });
			} catch {
				debug(`${eventName} — failed to parse stdout: ${stdout.slice(0, 200)}`);
				settle({ ok: false });
			}
		});

		const body = JSON.stringify({
			hookEventName: eventName,
			hook_event_name: eventName,
			...payload,
		});

		try {
			child.stdin.end(body);
		} catch {
			settle({ ok: false });
		}
	});
}

/**
 * Condense session entries into a transcript string for the Stop payload.
 * Borrowed from the summarize.ts example pattern.
 */
function buildTranscript(entries: SessionEntry[]): string {
	const sections: string[] = [];

	for (const entry of entries) {
		if (entry.type !== "message" || !entry.message?.role) continue;

		const role = entry.message.role;
		if (role !== "user" && role !== "assistant") continue;

		const content = entry.message.content;
		const texts: string[] = [];

		if (typeof content === "string") {
			texts.push(content);
		} else if (Array.isArray(content)) {
			for (const block of content as ContentBlock[]) {
				if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
					texts.push(block.text.trim());
				}
			}
		}

		if (texts.length > 0) {
			const label = role === "user" ? "User" : "Assistant";
			sections.push(`${label}: ${texts.join("\n")}`);
		}
	}

	return sections.join("\n\n");
}

// ─── Module-scoped state ─────────────────────────────────────────────────────

let memorixUnavailable = false; // cached on first ENOENT — avoids repeated spawn attempts
let sessionId = "";
let sessionCwd = process.cwd();
let pendingStartContext = ""; // context from SessionStart, injected on first before_agent_start
let firstTurnDone = false;

// ─── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	/**
	 * session_start → SessionStart
	 *
	 * Runs on Pi startup, /new, /resume, /reload, /fork.
	 * Loads previous session context and stashes it for injection on the first turn.
	 */
	pi.on("session_start", async (_event, ctx) => {
		sessionCwd = ctx.cwd ?? process.cwd();
		sessionId = ctx.sessionManager.getSessionName() ?? randomUUID();
		pendingStartContext = "";
		firstTurnDone = false;

		try {
			const result = await runMemorixHook("SessionStart", {
				sessionId,
				cwd: sessionCwd,
			});

			if (result.ok && result.systemMessage.trim()) {
				pendingStartContext = result.systemMessage;
				debug(`SessionStart: loaded ${pendingStartContext.length} chars of context`);
			}
		} catch (err) {
			debug(`SessionStart error: ${(err as Error).message}`);
		}
	});

	/**
	 * before_agent_start → UserPromptSubmit (+ first-turn SessionStart flush)
	 *
	 * Fires before each agent turn. Does two things:
	 *  1. On the first turn only: injects the SessionStart context into systemPrompt.
	 *  2. Every turn: asks memorix if memories are relevant to the current prompt.
	 *
	 * Both injections use the systemPrompt return so they're ephemeral (not persisted
	 * in the session entry list).
	 */
	pi.on("before_agent_start", async (event, ctx) => {
		const additions: string[] = [];

		// First-turn flush
		if (!firstTurnDone && pendingStartContext) {
			additions.push(
				`<memorix-session-context>\n${pendingStartContext}\n</memorix-session-context>`,
			);
			firstTurnDone = true;
			pendingStartContext = "";
		}

		// Per-prompt lookup
		try {
			const result = await runMemorixHook(
				"UserPromptSubmit",
				{
					sessionId,
					cwd: ctx.cwd ?? sessionCwd,
					prompt: event.prompt,
					userPrompt: event.prompt,
				},
				4000,
			);

			if (result.ok && result.systemMessage.trim()) {
				additions.push(
					`<memorix-context>\n${result.systemMessage}\n</memorix-context>`,
				);
				debug(`UserPromptSubmit: injected ${result.systemMessage.length} chars`);
			}
		} catch (err) {
			debug(`UserPromptSubmit error: ${(err as Error).message}`);
		}

		if (additions.length === 0) return;

		return {
			systemPrompt: `${event.systemPrompt}\n\n${additions.join("\n\n")}`,
		};
	});

	/**
	 * session_before_compact → PreCompact
	 *
	 * Fires before /compact. Tells memorix to save current context.
	 * We don't override Pi's compaction — just notify memorix.
	 */
	pi.on("session_before_compact", async (_event, ctx) => {
		try {
			await runMemorixHook("PreCompact", {
				sessionId,
				cwd: ctx.cwd ?? sessionCwd,
			});
			debug("PreCompact: notified memorix");
		} catch (err) {
			debug(`PreCompact error: ${(err as Error).message}`);
		}
		// Return nothing — let Pi handle compaction normally.
	});

	/**
	 * session_shutdown → Stop
	 *
	 * Fires on exit (quit, /new, /resume, /reload, /fork).
	 * Sends a condensed transcript so memorix can store a session summary.
	 * Must be awaited — Pi waits on this handler before exiting.
	 */
	pi.on("session_shutdown", async (_event, ctx) => {
		let transcript = "";
		try {
			const entries = ctx.sessionManager.getBranch() as SessionEntry[];
			transcript = buildTranscript(entries).slice(0, 4000);
		} catch { /* getBranch may fail if session is empty */ }

		// Memorix requires 50+ chars of content to store a session observation.
		if (transcript.length < 50) {
			transcript = `Pi session ${sessionId} ended. No substantial conversation content.`;
		}

		try {
			await runMemorixHook(
				"Stop",
				{
					sessionId,
					cwd: ctx.cwd ?? sessionCwd,
					transcript,
					content: transcript,
				},
				6000,
			);
			debug("Stop: session saved to memorix");
		} catch (err) {
			debug(`Stop error: ${(err as Error).message}`);
		}
	});

	/**
	 * /mem <query> — quick memory search from within Pi
	 */
	pi.registerCommand("mem", {
		description: "Search Memorix memory for this project",
		handler: async (args, ctx) => {
			const query = args.trim();
			if (!query) {
				if (ctx.hasUI) ctx.ui.notify("Usage: /mem <query>", "warning");
				return;
			}

			try {
				const result = await pi.exec(
					"memorix",
					["search", query],
					{ timeout: 8000, cwd: ctx.cwd },
				);

				const output = result.stdout.trim();
				if (ctx.hasUI) {
					ctx.ui.notify(output || "No results.", "info");
				} else {
					console.log(output || "No results.");
				}
			} catch (err) {
				if (ctx.hasUI) {
					ctx.ui.notify(`memorix search failed: ${(err as Error).message}`, "error");
				}
			}
		},
	});
}
