# pi-memorix

Pi extension that bridges [Memorix](https://github.com/AVIDS2/memorix) memory hooks into Pi's session lifecycle.

Memorix ships Claude Code hooks (via `.claude/settings.json`) that auto-manage session context. Pi has its own extension system — this extension ports those same behaviors so Pi sessions get the same memory continuity.

## What it does

| Pi event | Memorix equivalent | Behavior |
|---|---|---|
| `session_start` | `SessionStart` | Loads previous session context, injects on first turn |
| `before_agent_start` | `UserPromptSubmit` | Fetches relevant memories for each prompt |
| `session_before_compact` | `PreCompact` | Saves context before `/compact` |
| `session_shutdown` | `Stop` | Stores session summary on exit |

Also adds a `/mem <query>` command for quick memory search from within Pi.

`PostToolUse` is intentionally skipped — Memorix's git hooks and the LLM's MCP tool calls (via the CLAUDE.md rules Memorix installs) already handle auto-capture.

## Requirements

- [Pi](https://pi.dev) coding agent
- [Memorix](https://github.com/AVIDS2/memorix) installed globally: `npm install -g memorix`
- `memorix` on PATH in the environment where Pi runs

## Installation

```bash
# Copy to your Pi extensions directory
cp memorix.ts ~/.pi/agent/extensions/memorix.ts

# Load it when starting Pi
pi -e ~/.pi/agent/extensions/memorix.ts
```

Or add it to your Pi config to load automatically.

## Debug mode

```bash
MEMORIX_PI_DEBUG=1 pi -e ~/.pi/agent/extensions/memorix.ts
```

Logs all hook calls and failures to stderr.

## Notes

- Memorix requires a `.git` directory in the project root to detect the project. Outside git repos, hooks are silently skipped.
- All memorix failures are silent by default — Pi never crashes because of this extension.
- The extension caches a `memorixUnavailable` flag after the first `ENOENT` to avoid repeated failed spawn attempts.
