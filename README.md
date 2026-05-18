# pi-memorix

Pi extension that bridges [Memorix](https://github.com/AVIDS2/memorix) memory hooks into Pi's session lifecycle.

Without this extension, Memorix memory tools are only available when the LLM explicitly calls them. This extension wires Memorix into Pi's event lifecycle so memory management is automatic: previous context loads at session start, relevant memories are injected per prompt, and a session summary is saved on exit.

## What it does

| Pi event | Memorix hook | Behavior |
|---|---|---|
| `session_start` | `SessionStart` | Loads previous session context, injects it on the first turn |
| `before_agent_start` | `UserPromptSubmit` | Fetches memories relevant to the current prompt |
| `session_before_compact` | `PreCompact` | Saves context before `/compact` wipes the thread |
| `session_shutdown` | `Stop` | Stores a session summary when Pi exits |

Also adds a `/mem <query>` command for quick memory search from within Pi.

`PostToolUse` is intentionally skipped — Memorix's git hooks and the LLM's own MCP tool calls (via Memorix's CLAUDE.md rules) already cover auto-capture.

## Requirements

- [Pi](https://pi.dev) coding agent
- [Memorix](https://github.com/AVIDS2/memorix) installed and on PATH: `npm install -g memorix`

## Installation

```bash
pi install npm:pi-memorix
```

To try it without making it permanent:

```bash
pi -e npm:pi-memorix
```

Or copy the extension file directly if you prefer:

```bash
cp memorix.ts ~/.pi/agent/extensions/memorix.ts
```

## Usage

Once installed, the extension runs automatically with every Pi session. No configuration needed.

The `/mem` command lets you search project memory without leaving Pi:

```
/mem how does auth work
/mem recent session context
/mem what changed in the API layer
```

## Debug mode

```bash
MEMORIX_PI_DEBUG=1 pi
```

Logs all hook calls, payloads, and failures to stderr.

## Notes

- Memorix requires a `.git` directory in the project root to identify the project. Outside git repos, hooks are silently skipped.
- All Memorix failures are silent by default — Pi never crashes because of this extension.
- If `memorix` is not found on PATH, the extension disables itself after the first failed spawn.
