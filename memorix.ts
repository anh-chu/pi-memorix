/**
 * pi-memorix
 *
 * Bridges Memorix memory hooks into Pi's extension event system.
 * Mirrors what Memorix does via .claude/settings.json hooks, but for Pi.
 *
 * Covered hooks:
 *   session_start          → SessionStart    (load previous context)
 *   before_agent_start     → UserPromptSubmit (inject relevant memories per turn)
 *   session_before_compact → PreCompact      (save context before compaction)
 *   session_shutdown       → Stop            (end session, store summary)
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

export type HookResult =
	| { ok: true; systemMessage: string }
	| { ok: false };

/** Injectable hook runner — swap out in tests to avoid spawning memorix. */
export type HookRunner = (
	eventName: HookEventName,
	payload: Record<string, unknown>,
	timeoutMs?: number,
	signal?: AbortSignal,
) => Promise<HookResult>;

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
function makeSubprocessHookRunner(): HookRunner {
	let memorixUnavailable = false;

	return function runMemorixHook(eventName, payload, timeoutMs = 5000, signal): Promise<HookResult> {
		return new Promise((resolve) => {
			if (memorixUnavailable) return resolve({ ok: false });

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

			try { child.stdin.end(body); } catch { settle({ ok: false }); }
		});
	};
}

/**
 * Condense session entries into a transcript string for the Stop payload.
 */
export function buildTranscript(entries: SessionEntry[]): string {
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
			sections.push(`${role === "user" ? "User" : "Assistant"}: ${texts.join("\n")}`);
		}
	}

	return sections.join("\n\n");
}

// ─── Extension factory ────────────────────────────────────────────────────────

/**
 * Creates the extension function, optionally accepting a custom hook runner.
 * Pass a mock runner in tests to avoid spawning the memorix subprocess.
 *
 *   import { createMemorixExtension } from "./memorix.ts";
 *   createTestSession({ extensionFactories: [createMemorixExtension(mockHook)] })
 */
export function createMemorixExtension(hookRunner?: HookRunner): (pi: ExtensionAPI) => void {
	const runHook: HookRunner = hookRunner ?? makeSubprocessHookRunner();

	return function (pi: ExtensionAPI) {
		let sessionId = "";
		let sessionCwd = process.cwd();
		let pendingStartContext = "";
		let firstTurnDone = false;

		/**
		 * session_start → SessionStart
		 * Loads previous session context, stashes it for the first turn.
		 */
		pi.on("session_start", async (_event, ctx) => {
			sessionCwd = ctx.cwd ?? process.cwd();
			sessionId = ctx.sessionManager.getSessionName() ?? randomUUID();
			pendingStartContext = "";
			firstTurnDone = false;

			try {
				const result = await runHook("SessionStart", { sessionId, cwd: sessionCwd });
				if (result.ok && result.systemMessage.trim()) {
					pendingStartContext = result.systemMessage;
					debug(`SessionStart: loaded ${pendingStartContext.length} chars`);
				}
			} catch (err) {
				debug(`SessionStart error: ${(err as Error).message}`);
			}
		});

		/**
		 * before_agent_start → UserPromptSubmit + first-turn SessionStart flush
		 *
		 * Turn 1: injects stashed SessionStart context into systemPrompt.
		 * Every turn: asks memorix if memories are relevant to this prompt.
		 */
		pi.on("before_agent_start", async (event, ctx) => {
			const additions: string[] = [];

			if (!firstTurnDone && pendingStartContext) {
				additions.push(
					`<memorix-session-context>\n${pendingStartContext}\n</memorix-session-context>`,
				);
				firstTurnDone = true;
				pendingStartContext = "";
			}

			try {
				const result = await runHook(
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
					additions.push(`<memorix-context>\n${result.systemMessage}\n</memorix-context>`);
					debug(`UserPromptSubmit: injected ${result.systemMessage.length} chars`);
				}
			} catch (err) {
				debug(`UserPromptSubmit error: ${(err as Error).message}`);
			}

			if (additions.length === 0) return;
			return { systemPrompt: `${event.systemPrompt}\n\n${additions.join("\n\n")}` };
		});

		/**
		 * session_before_compact → PreCompact
		 * Notifies memorix before /compact. Does not override Pi's compaction.
		 */
		pi.on("session_before_compact", async (_event, ctx) => {
			try {
				await runHook("PreCompact", { sessionId, cwd: ctx.cwd ?? sessionCwd });
				debug("PreCompact: notified memorix");
			} catch (err) {
				debug(`PreCompact error: ${(err as Error).message}`);
			}
		});

		/**
		 * session_shutdown → Stop
		 * Sends a condensed transcript so memorix can store a session summary.
		 * Awaited — Pi waits on this handler before exiting.
		 */
		pi.on("session_shutdown", async (_event, ctx) => {
			let transcript = "";
			try {
				const entries = ctx.sessionManager.getBranch() as SessionEntry[];
				transcript = buildTranscript(entries).slice(0, 4000);
			} catch { /* getBranch may fail on empty sessions */ }

			if (transcript.length < 50) {
				transcript = `Pi session ${sessionId} ended with no substantial conversation.`;
			}

			try {
				await runHook("Stop", {
					sessionId,
					cwd: ctx.cwd ?? sessionCwd,
					transcript,
					content: transcript,
				}, 6000);
				debug("Stop: session saved to memorix");
			} catch (err) {
				debug(`Stop error: ${(err as Error).message}`);
			}
		});

		/** /mem <query> — quick memory search from within Pi */
		pi.registerCommand("mem", {
			description: "Search Memorix memory for this project",
			handler: async (args, ctx) => {
				const query = args.trim();
				if (!query) {
					if (ctx.hasUI) ctx.ui.notify("Usage: /mem <query>", "warning");
					return;
				}
				try {
					const result = await pi.exec("memorix", ["search", query], {
						timeout: 8000,
						cwd: ctx.cwd,
					});
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
	};
}

/** Default export for normal use: `pi -e ~/.pi/agent/extensions/memorix.ts` */
export default createMemorixExtension();
