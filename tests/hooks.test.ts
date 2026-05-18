import { describe, it, expect, afterEach } from "vitest";
import { createTestSession, when, calls, says, type TestSession } from "@marcfargas/pi-test-harness";
import { createMemorixExtension, buildTranscript, type HookResult, type HookRunner } from "../memorix.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

type HookCall = { name: string; payload: Record<string, unknown> };

/** Creates a mock hook runner that records calls and returns configurable responses. */
function makeMockHook(
	responses: Partial<Record<string, string | (() => string)>> = {},
): { hook: HookRunner; calls: HookCall[] } {
	const calls: HookCall[] = [];
	const hook: HookRunner = async (name, payload) => {
		calls.push({ name, payload });
		const response = responses[name];
		const systemMessage = typeof response === "function" ? response() : (response ?? "");
		return { ok: true, systemMessage };
	};
	return { hook, calls };
}

/** Creates a mock hook runner that always fails. */
function makeFailingHook(): { hook: HookRunner; calls: HookCall[] } {
	const calls: HookCall[] = [];
	const hook: HookRunner = async (name, payload) => {
		calls.push({ name, payload });
		return { ok: false };
	};
	return { hook, calls };
}

const MOCK_TOOLS = {
	bash: "ok",
	read: "ok",
	write: "ok",
	edit: "ok",
};

// ─── session_start → SessionStart ────────────────────────────────────────────

describe("session_start → SessionStart", () => {
	let t: TestSession;
	afterEach(() => t?.dispose());

	it("calls SessionStart when the session is created", async () => {
		const { hook, calls } = makeMockHook();

		t = await createTestSession({
			extensionFactories: [createMemorixExtension(hook)],
			mockTools: MOCK_TOOLS,
		});

		const start = calls.find((c) => c.name === "SessionStart");
		expect(start, "SessionStart hook should have been called").toBeDefined();
	});

	it("passes cwd and sessionId to SessionStart", async () => {
		const { hook, calls } = makeMockHook();

		t = await createTestSession({
			extensionFactories: [createMemorixExtension(hook)],
			mockTools: MOCK_TOOLS,
		});

		const start = calls.find((c) => c.name === "SessionStart")!;
		expect(typeof start.payload.cwd).toBe("string");
		expect((start.payload.cwd as string).length).toBeGreaterThan(0);
		expect(typeof start.payload.sessionId).toBe("string");
		expect((start.payload.sessionId as string).length).toBeGreaterThan(0);
	});

	it("stashes SessionStart context and injects it on the first turn", async () => {
		const CONTEXT = "Previous session: fixed the auth bug in api/login.ts";
		const injectedSystemPrompts: string[] = [];

		// Capture what systemPrompt the extension returned on before_agent_start
		const hook: HookRunner = async (name) => {
			if (name === "SessionStart") return { ok: true, systemMessage: CONTEXT };
			return { ok: true, systemMessage: "" };
		};

		// Wrap the extension to spy on the systemPrompt it produces
		const baseExtFactory = createMemorixExtension(hook);
		const spyExtFactory = (pi: Parameters<typeof baseExtFactory>[0]) => {
			baseExtFactory(pi);
			pi.on("before_agent_start", async (event) => {
				injectedSystemPrompts.push(event.systemPrompt);
			});
		};

		t = await createTestSession({
			extensionFactories: [spyExtFactory],
			mockTools: MOCK_TOOLS,
		});

		await t.run(when("Hello", [says("Hi there.")]));

		// The FIRST turn should contain the stashed context
		const firstPrompt = injectedSystemPrompts[0] ?? "";
		expect(firstPrompt).toContain("memorix-session-context");
		expect(firstPrompt).toContain(CONTEXT);
	});

	it("only injects SessionStart context on the first turn, not subsequent turns", async () => {
		const CONTEXT = "Previous session context";
		const injectedSystemPrompts: string[] = [];

		const hook: HookRunner = async (name) => {
			if (name === "SessionStart") return { ok: true, systemMessage: CONTEXT };
			return { ok: true, systemMessage: "" };
		};

		const baseExtFactory = createMemorixExtension(hook);
		const spyExtFactory = (pi: Parameters<typeof baseExtFactory>[0]) => {
			baseExtFactory(pi);
			pi.on("before_agent_start", async (event) => {
				injectedSystemPrompts.push(event.systemPrompt);
			});
		};

		t = await createTestSession({
			extensionFactories: [spyExtFactory],
			mockTools: MOCK_TOOLS,
		});

		await t.run(
			when("First prompt", [says("Response 1.")]),
			when("Second prompt", [says("Response 2.")]),
		);

		expect(injectedSystemPrompts).toHaveLength(2);
		// First turn has session context
		expect(injectedSystemPrompts[0]).toContain(CONTEXT);
		// Second turn does NOT repeat it
		expect(injectedSystemPrompts[1]).not.toContain("memorix-session-context");
	});
});

// ─── before_agent_start → UserPromptSubmit ────────────────────────────────────

describe("before_agent_start → UserPromptSubmit", () => {
	let t: TestSession;
	afterEach(() => t?.dispose());

	it("calls UserPromptSubmit on every agent turn", async () => {
		const { hook, calls } = makeMockHook();

		t = await createTestSession({
			extensionFactories: [createMemorixExtension(hook)],
			mockTools: MOCK_TOOLS,
		});

		await t.run(
			when("First question", [says("Answer 1.")]),
			when("Second question", [says("Answer 2.")]),
		);

		const submits = calls.filter((c) => c.name === "UserPromptSubmit");
		expect(submits).toHaveLength(2);
	});

	it("passes the user's prompt text to UserPromptSubmit", async () => {
		const { hook, calls } = makeMockHook();

		t = await createTestSession({
			extensionFactories: [createMemorixExtension(hook)],
			mockTools: MOCK_TOOLS,
		});

		await t.run(when("What is the capital of France?", [says("Paris.")]));

		const submit = calls.find((c) => c.name === "UserPromptSubmit")!;
		expect(submit.payload.prompt).toBe("What is the capital of France?");
	});

	it("injects UserPromptSubmit context into systemPrompt", async () => {
		const MEMORY = "Key fact: the API uses JWT tokens";
		const injectedSystemPrompts: string[] = [];

		const hook: HookRunner = async (name) => {
			if (name === "UserPromptSubmit") return { ok: true, systemMessage: MEMORY };
			return { ok: true, systemMessage: "" };
		};

		const baseExtFactory = createMemorixExtension(hook);
		const spyExtFactory = (pi: Parameters<typeof baseExtFactory>[0]) => {
			baseExtFactory(pi);
			pi.on("before_agent_start", async (event) => {
				injectedSystemPrompts.push(event.systemPrompt);
			});
		};

		t = await createTestSession({
			extensionFactories: [spyExtFactory],
			mockTools: MOCK_TOOLS,
		});

		await t.run(when("How does auth work?", [says("It uses JWT.")]));

		const prompt = injectedSystemPrompts[0] ?? "";
		expect(prompt).toContain("memorix-context");
		expect(prompt).toContain(MEMORY);
	});

	it("does not inject into systemPrompt when UserPromptSubmit returns empty", async () => {
		const injectedSystemPrompts: string[] = [];

		const hook: HookRunner = async () => ({ ok: true, systemMessage: "" });

		const baseExtFactory = createMemorixExtension(hook);
		const spyExtFactory = (pi: Parameters<typeof baseExtFactory>[0]) => {
			baseExtFactory(pi);
			pi.on("before_agent_start", async (event) => {
				injectedSystemPrompts.push(event.systemPrompt);
			});
		};

		t = await createTestSession({
			extensionFactories: [spyExtFactory],
			mockTools: MOCK_TOOLS,
		});

		await t.run(when("A question", [says("An answer.")]));

		const prompt = injectedSystemPrompts[0] ?? "";
		expect(prompt).not.toContain("memorix-context");
	});
});

// ─── tool_result → PostToolUse ──────────────────────────────────────────────────

describe("tool_result → PostToolUse", () => {
	let t: TestSession;
	afterEach(() => t?.dispose());

	it("fires PostToolUse after write tool with sufficient output", async () => {
		const { hook, calls: hookCalls } = makeMockHook();

		t = await createTestSession({
			extensionFactories: [createMemorixExtension(hook)],
			mockTools: {
				...MOCK_TOOLS,
				write: "File written successfully to path/to/file.ts with 1234 bytes of content",
			},
		});

		await t.run(when("Write a file", [
			calls("write", { path: "path/to/file.ts", content: "export const x = 1;" }),
			says("Done."),
		]));

		// Give fire-and-forget a tick to settle
		await new Promise((r) => setTimeout(r, 50));

		const postTool = hookCalls.find((c) => c.name === "PostToolUse");
		expect(postTool, "PostToolUse should fire after write").toBeDefined();
		expect(postTool?.payload.tool_name).toBe("write");
	});

	it("fires PostToolUse after bash tool", async () => {
		const { hook, calls: hookCalls } = makeMockHook();

		t = await createTestSession({
			extensionFactories: [createMemorixExtension(hook)],
			mockTools: {
				...MOCK_TOOLS,
				bash: "Compiled successfully. Output: dist/index.js (12.4 kB). Build complete with 0 errors.",
			},
		});

		await t.run(when("Run a build", [
			calls("bash", { command: "npm run build" }),
			says("Build succeeded."),
		]));

		await new Promise((r) => setTimeout(r, 50));

		const postTool = hookCalls.find((c) => c.name === "PostToolUse");
		expect(postTool).toBeDefined();
		expect(postTool?.payload.tool_name).toBe("bash");
	});

	it("skips PostToolUse for read tool", async () => {
		const { hook, calls: hookCalls } = makeMockHook();

		t = await createTestSession({
			extensionFactories: [createMemorixExtension(hook)],
			mockTools: {
				...MOCK_TOOLS,
				read: "file contents here with lots of text that clearly exceeds the fifty char minimum",
			},
		});

		await t.run(when("Read a file", [
			calls("read", { path: "README.md" }),
			says("I see the contents."),
		]));

		await new Promise((r) => setTimeout(r, 50));

		expect(hookCalls.filter((c) => c.name === "PostToolUse")).toHaveLength(0);
	});

	it("skips PostToolUse when output is below 50 chars", async () => {
		const { hook, calls: hookCalls } = makeMockHook();

		t = await createTestSession({
			extensionFactories: [createMemorixExtension(hook)],
			mockTools: { ...MOCK_TOOLS, write: "ok" },
		});

		await t.run(when("Write a small file", [
			calls("write", { path: "x.ts", content: "x" }),
			says("Done."),
		]));

		await new Promise((r) => setTimeout(r, 50));

		expect(hookCalls.filter((c) => c.name === "PostToolUse")).toHaveLength(0);
	});

	it("fires PostToolUse even on tool errors (Memorix filters significance)", async () => {
		const { hook, calls: hookCalls } = makeMockHook();

		t = await createTestSession({
			extensionFactories: [createMemorixExtension(hook)],
			mockTools: {
				...MOCK_TOOLS,
				bash: {
					content: [{ type: "text", text: "Error: command not found and many other details here" }],
					isError: true,
				},
			},
			propagateErrors: false,
		});

		await t.run(when("Run failing command", [
			calls("bash", { command: "nonexistent" }),
			says("That failed."),
		]));

		await new Promise((r) => setTimeout(r, 50));

		// Claude Code plugin fires PostToolUse for errors too; Memorix filters significance
		const postToolCalls = hookCalls.filter((c) => c.name === "PostToolUse");
		expect(postToolCalls.length).toBeGreaterThan(0);
		expect(postToolCalls[0]?.payload.tool_name).toBe("bash");
	});
});

// ─── session_before_compact → PreCompact ─────────────────────────────────────

describe("session_before_compact → PreCompact", () => {
	let t: TestSession;
	afterEach(() => t?.dispose());

	it("calls PreCompact when compact is triggered", async () => {
		const { hook, calls } = makeMockHook();

		// Register an extra command to trigger compact from within the session
		const baseExtFactory = createMemorixExtension(hook);
		const withCompactTrigger = (pi: Parameters<typeof baseExtFactory>[0]) => {
			baseExtFactory(pi);
			pi.registerCommand("trigger-compact", {
				description: "test helper: trigger compaction",
				handler: async (_args, ctx) => { await ctx.compact(); },
			});
		};

		t = await createTestSession({
			extensionFactories: [withCompactTrigger],
			mockTools: MOCK_TOOLS,
		});

		// Run a turn first so there's something to compact
		await t.run(when("Tell me something", [says("Something.")]));

		// Trigger compact via the helper command
		// Extension commands are handled before the playbook, so no need for run()
		await t.session.prompt("/trigger-compact");

		const compact = calls.find((c) => c.name === "PreCompact");
		expect(compact, "PreCompact hook should have been called").toBeDefined();
	});
});

// ─── Resilience ───────────────────────────────────────────────────────────────

describe("resilience — memorix failures never crash Pi", () => {
	let t: TestSession;
	afterEach(() => t?.dispose());

	it("session creates and runs normally when all hooks fail", async () => {
		const { hook } = makeFailingHook();

		t = await createTestSession({
			extensionFactories: [createMemorixExtension(hook)],
			mockTools: MOCK_TOOLS,
		});

		// Should not throw
		await t.run(when("Hello", [says("Hi.")]));

		expect(t.events.messages.length).toBeGreaterThan(0);
	});

	it("session creates and runs normally when hooks throw", async () => {
		const hook: HookRunner = async () => {
			throw new Error("memorix crashed");
		};

		t = await createTestSession({
			extensionFactories: [createMemorixExtension(hook)],
			mockTools: MOCK_TOOLS,
		});

		await expect(
			t.run(when("Hello", [says("Hi.")])),
		).resolves.not.toThrow();
	});

	it("does not inject anything into systemPrompt when hooks fail", async () => {
		const { hook } = makeFailingHook();
		const injectedSystemPrompts: string[] = [];

		const baseExtFactory = createMemorixExtension(hook);
		const spyExtFactory = (pi: Parameters<typeof baseExtFactory>[0]) => {
			baseExtFactory(pi);
			pi.on("before_agent_start", async (event) => {
				injectedSystemPrompts.push(event.systemPrompt);
			});
		};

		t = await createTestSession({
			extensionFactories: [spyExtFactory],
			mockTools: MOCK_TOOLS,
		});

		await t.run(when("Hello", [says("Hi.")]));

		const prompt = injectedSystemPrompts[0] ?? "";
		// Check that our wrapper tags were NOT added (the base system prompt may
		// legitimately contain "memorix" from AGENTS.md skill descriptions)
		expect(prompt).not.toContain("memorix-context");
		expect(prompt).not.toContain("memorix-session-context");
	});

	it("handles whitespace-only systemMessage gracefully", async () => {
		const hook: HookRunner = async () => ({ ok: true, systemMessage: "   \n  " });
		const injectedSystemPrompts: string[] = [];

		const baseExtFactory = createMemorixExtension(hook);
		const spyExtFactory = (pi: Parameters<typeof baseExtFactory>[0]) => {
			baseExtFactory(pi);
			pi.on("before_agent_start", async (event) => {
				injectedSystemPrompts.push(event.systemPrompt);
			});
		};

		t = await createTestSession({
			extensionFactories: [spyExtFactory],
			mockTools: MOCK_TOOLS,
		});

		await t.run(when("Hello", [says("Hi.")]));

		expect(injectedSystemPrompts[0]).not.toContain("memorix-context");
		expect(injectedSystemPrompts[0]).not.toContain("memorix-session-context");
	});
});

// ─── buildTranscript (unit) ───────────────────────────────────────────────────

describe("buildTranscript", () => {
	it("extracts user and assistant text from session entries", () => {
		const entries = [
			{
				type: "message",
				message: {
					role: "user",
					content: [{ type: "text", text: "How do I fix the bug?" }],
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "You need to check the null case." }],
				},
			},
		];

		const result = buildTranscript(entries);
		expect(result).toContain("User: How do I fix the bug?");
		expect(result).toContain("Assistant: You need to check the null case.");
	});

	it("ignores non-message entries", () => {
		const entries = [
			{ type: "tool_result", message: undefined },
			{
				type: "message",
				message: { role: "user", content: [{ type: "text", text: "Hello" }] },
			},
		];

		const result = buildTranscript(entries);
		expect(result).toBe("User: Hello");
	});

	it("handles string content (not array)", () => {
		const entries = [
			{
				type: "message",
				message: { role: "user", content: "Plain string message" },
			},
		];

		const result = buildTranscript(entries);
		expect(result).toBe("User: Plain string message");
	});

	it("skips entries with empty text blocks", () => {
		const entries = [
			{
				type: "message",
				message: {
					role: "user",
					content: [
						{ type: "tool_use", text: undefined },
						{ type: "text", text: "   " },
					],
				},
			},
		];

		const result = buildTranscript(entries);
		expect(result).toBe("");
	});

	it("returns empty string for empty entries", () => {
		expect(buildTranscript([])).toBe("");
	});
});
