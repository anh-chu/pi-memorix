/**
 * pi-memorix
 *
 * Bridges Memorix memory hooks into Pi's extension event system.
 * Mirrors what Memorix does via .claude/settings.json hooks, but for Pi.
 *
 * Covered hooks:
 *   session_start          → memorix session start --json (load previous context)
 *   before_agent_start     → UserPromptSubmit (inject memories, visible message)
 *   tool_result            → PostToolUse     (auto-capture writes, edits, bash)
 *   session_before_compact → PreCompact      (save context before compaction)
 *   session_shutdown       → memorix session end --json  (store session summary)
 *
 * Requirements:
 *   - memorix must be on PATH (npm install -g memorix)
 *   - Works in both interactive TUI and RPC/headless Pi modes
 *   - All memorix failures are silent; set MEMORIX_PI_DEBUG=1 to see them
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Load ~/.memorix/.env so the hook subprocess has embedding keys available. */
function loadMemorixDotEnv(): Record<string, string> {
	try {
		const content = readFileSync(join(homedir(), ".memorix", ".env"), "utf8");
		const vars: Record<string, string> = {};
		for (const line of content.split("\n")) {
			const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)/);
			if (m && m[2]) vars[m[1]] = m[2];
		}
		return vars;
	} catch {
		return {};
	}
}

// ─── Types ────────────────────────────────────────────────────────────────────

type HookEventName = "SessionStart" | "UserPromptSubmit" | "PostToolUse" | "PreCompact" | "Stop";

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

/** Runner for memorix session start/end commands. Returns previousContext or "". */
export type SessionRunner = (
	action: "start" | "end",
	params: { sessionId: string; cwd: string; summary?: string },
) => Promise<string>;

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

// ─── Config ──────────────────────────────────────────────────────────────────

/**
 * Optional config file at ~/.pi/agent/memorix.json
 *
 * Example:
 *   { "autoGitHook": true }
 */
interface MemorixConfig {
	/** Auto-install memorix git-hook in new repos on session start. Default: false. */
	autoGitHook?: boolean;
}

function loadConfig(): MemorixConfig {
	try {
		const configPath = join(getAgentDir(), "memorix.json");
		if (existsSync(configPath)) {
			return JSON.parse(readFileSync(configPath, "utf-8")) as MemorixConfig;
		}
	} catch { /* ignore */ }
	return {};
}

/** Returns true if a memorix post-commit hook is already installed in this repo. */
function isGitHookInstalled(repoRoot: string): boolean {
	try {
		const hookPath = join(repoRoot, ".git", "hooks", "post-commit");
		if (!existsSync(hookPath)) return false;
		return readFileSync(hookPath, "utf-8").includes("memorix");
	} catch { return false; }
}

/** Run `memorix git-hook` once in cwd. Returns true on success. */
function installGitHook(cwd: string): Promise<boolean> {
	return new Promise((resolve) => {
		try {
			const child = spawn("memorix", ["git-hook"], {
				cwd,
				stdio: ["ignore", "ignore", "ignore"],
				env: process.env,
			});
			child.on("close", (code) => resolve(code === 0));
			child.on("error", () => resolve(false));
		} catch { resolve(false); }
	});
}

/**
 * Tools Memorix never stores (file_read → "never", memorix internals → "never").
 * Everything else — write, edit, bash — passes through Memorix's own filters.
 */
const SKIP_TOOLS = new Set(["read", "ls", "find", "grep", "glob"]);

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
				child = spawn("memorix", ["hook"], {
					stdio: ["pipe", "pipe", "pipe"],
					env: { ...loadMemorixDotEnv(), ...process.env },
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

function makeSubprocessSessionRunner(): SessionRunner {
	return async function runMemorixSession(action, { sessionId, cwd, summary }) {
		const env = { ...loadMemorixDotEnv(), ...process.env };
		const args = ["session", action, "--json", "--sessionId", sessionId, "--agent", "pi"];
		if (action === "end" && summary) {
			args.push("--summary", summary.slice(0, 2000));
		}
		return new Promise((resolve) => {
			let child: ReturnType<typeof spawn>;
			try {
				child = spawn("memorix", args, {
					stdio: ["pipe", "pipe", "pipe"],
					env,
					cwd,
				});
			} catch {
				return resolve("");
			}

			let stdout = "";
			let settled = false;
			const settle = (val: string) => {
				if (!settled) { settled = true; clearTimeout(timer); resolve(val); }
			};

			const timer = setTimeout(() => {
				debug(`memorix session ${action} timed out`);
				try { child.kill("SIGTERM"); } catch { /* ignore */ }
				settle("");
			}, 10000);

			child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
			child.stderr.on("data", (d: Buffer) => { debug(`memorix session ${action} stderr: ${d.toString().trim()}`); });
			child.on("error", () => settle(""));
			child.on("close", () => {
				try {
					const parsed = JSON.parse(stdout);
					settle(action === "start" ? (parsed.previousContext ?? "") : "");
				} catch {
					settle("");
				}
			});

			if (action === "end") child.stdin.end();
		});
	};
}

// ─── Extension factory ────────────────────────────────────────────────────────

/**
 * Creates the extension function, optionally accepting a custom hook runner.
 * Pass a mock runner in tests to avoid spawning the memorix subprocess.
 *
 *   import { createMemorixExtension } from "./memorix.ts";
 *   createTestSession({ extensionFactories: [createMemorixExtension(mockHook)] })
 */
/** Test-only overrides — not part of the public API. */
export interface _TestOverrides {
	config?: MemorixConfig;
	installGitHook?: (cwd: string) => Promise<boolean>;
	sessionRunner?: SessionRunner;
}

export function createMemorixExtension(hookRunner?: HookRunner, _overrides?: _TestOverrides): (pi: ExtensionAPI) => void {
	const runHook: HookRunner = hookRunner ?? makeSubprocessHookRunner();
	const runSession: SessionRunner = _overrides?.sessionRunner ?? makeSubprocessSessionRunner();
	const _config = () => _overrides?.config ?? loadConfig();
	const _installGitHook = _overrides?.installGitHook ?? installGitHook;

	return function (pi: ExtensionAPI) {
		let sessionId = "";
		let sessionCwd = process.cwd();
		let pendingStartContext = "";
		let firstTurnDone = false;

		/**
		 * session_start → memorix session start --json
		 * Loads rich previous session context (memories, routing hints, evidence).
		 * If autoGitHook is enabled in memorix.json, installs the git hook if missing.
		 */
		pi.on("session_start", async (_event, ctx) => {
			sessionCwd = ctx.cwd ?? process.cwd();
			sessionId = ctx.sessionManager.getSessionName() ?? randomUUID();
			pendingStartContext = "";
			firstTurnDone = false;

			// Auto-install git hook if opted in and not already present
			const config = _config();
			if (config.autoGitHook && existsSync(join(sessionCwd, ".git"))) {
				if (!isGitHookInstalled(sessionCwd)) {
					const ok = await _installGitHook(sessionCwd);
					if (ok) {
						debug(`Auto-installed git hook in ${sessionCwd}`);
						if (ctx.hasUI) ctx.ui.notify("Memorix: git hook installed for this repo", "info");
					} else {
						debug(`Auto-install git hook failed in ${sessionCwd}`);
					}
				}
			}

			try {
				const context = await runSession("start", { sessionId, cwd: sessionCwd });
				if (context.trim()) {
					pendingStartContext = context;
					debug(`SessionStart: loaded ${pendingStartContext.length} chars`);
				} else {
					debug("SessionStart: fired, no context returned");
				}
			} catch (err) {
				debug(`SessionStart error: ${(err as Error).message}`);
			}
		});

		/**
		 * before_agent_start → inject context + UserPromptSubmit capture
		 *
		 * Turn 1: injects stashed session context as a visible message.
		 * Every turn: fires UserPromptSubmit for auto-capture of significant prompts.
		 */
		pi.on("before_agent_start", async (event, ctx) => {
			// Turn 1: inject session context as a visible message
			if (!firstTurnDone && pendingStartContext) {
				const context = pendingStartContext;
				firstTurnDone = true;
				pendingStartContext = "";

				// Fire UserPromptSubmit in background for auto-capture (don't await)
				runHook(
					"UserPromptSubmit",
					{
						sessionId,
						cwd: ctx.cwd ?? sessionCwd,
						prompt: event.prompt,
						userPrompt: event.prompt,
					},
					10000,
				).then((result) => {
					if (result.ok && result.systemMessage.trim()) {
						debug(`UserPromptSubmit: captured ${result.systemMessage.length} chars`);
					} else {
						debug("UserPromptSubmit: fired, no capture");
					}
				}).catch(() => {});

				return {
					message: {
						customType: "memorix-session-context",
						content: context,
						display: true,
					},
					systemPrompt: `${event.systemPrompt}\n\n<memorix-session-context>\n${context}\n</memorix-session-context>`,
				};
			}

			// Subsequent turns: fire UserPromptSubmit for capture only
			runHook(
				"UserPromptSubmit",
				{
					sessionId,
					cwd: ctx.cwd ?? sessionCwd,
					prompt: event.prompt,
					userPrompt: event.prompt,
				},
				10000,
			).then((result) => {
				if (result.ok && result.systemMessage.trim()) {
					debug(`UserPromptSubmit: captured ${result.systemMessage.length} chars`);
				} else {
					debug("UserPromptSubmit: fired, no capture");
				}
			}).catch(() => {});
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
		 * tool_result → PostToolUse
		 * Auto-captures write/edit/bash results, matching Memorix's Claude Code behavior.
		 * Fire-and-forget — never blocks the agent turn or modifies the result.
		 *
		 * Memorix applies its own filters (STORAGE_POLICY, significance, cooldowns),
		 * so we pass everything except tools it never stores (read, ls, etc.).
		 */
		pi.on("tool_result", (event, ctx) => {
			if (SKIP_TOOLS.has(event.toolName) || event.toolName.startsWith("memorix_")) return;

			const text = (event.content as Array<{ type?: string; text?: string }>)
				?.filter((b) => b.type === "text")
				.map((b) => b.text ?? "")
				.join("\n")
				.trim() ?? "";

			// Memorix STORAGE_POLICY minLength for file_modify and command is 50 chars
			if (text.length < 50) return;

			// Strip large content from write input to keep payload lean
			let toolInput: unknown = event.input;
			if (event.toolName === "write" && toolInput && typeof toolInput === "object") {
				const { content: _c, ...rest } = toolInput as Record<string, unknown>;
				toolInput = rest;
			}

			// normalizeClaude reads tool_name (snake_case) from the payload
			runHook(
				"PostToolUse",
				{
					tool_name: event.toolName,
					tool_input: toolInput,
					tool_result: text.slice(0, 2000),
					session_id: sessionId,
					cwd: ctx.cwd ?? sessionCwd,
				},
				4000,
			).catch(() => {});
			// No return — don't modify the tool result
		});

		/**
		 * session_shutdown → memorix session end --json
		 * Ends the memorix session with a transcript summary.
		 * Awaited — Pi waits on this handler before exiting.
		 */
		pi.on("session_shutdown", async (_event, ctx) => {
			let summary = "";
			try {
				const entries = ctx.sessionManager.getBranch() as SessionEntry[];
				summary = buildTranscript(entries).slice(0, 2000);
			} catch { /* getBranch may fail on empty sessions */ }

			if (summary.length < 50) {
				summary = `Pi session ${sessionId} ended with no substantial conversation.`;
			}

			try {
				await runSession("end", { sessionId, cwd: ctx.cwd ?? sessionCwd, summary });
				debug("Stop: session ended in memorix");
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
