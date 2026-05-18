# pi-memorix

Pi extension that bridges [Memorix](https://github.com/AVIDS2/memorix) memory hooks into Pi's session lifecycle.

Without this extension, Memorix memory tools are only available when the LLM explicitly calls them. This extension wires Memorix into Pi's event lifecycle so memory management is automatic: previous context loads at session start, relevant memories are injected per prompt, file writes and commands are captured as observations in real time, and a session summary is saved on exit.

## What it does

| Pi event | Memorix hook | Behavior |
|---|---|---|
| `session_start` | `SessionStart` | Loads previous session context, injects it on the first turn |
| `before_agent_start` | `UserPromptSubmit` | Fetches memories relevant to the current prompt |
| `tool_result` | `PostToolUse` | Auto-captures write/edit/bash results as Memorix observations |
| `session_before_compact` | `PreCompact` | Saves context before `/compact` wipes the thread |
| `session_shutdown` | `Stop` | Stores a session summary when Pi exits |

Also adds a `/mem <query>` command for quick memory search from within Pi.

## Installation

**1. Install Memorix:**

```bash
npm install -g memorix
```

**2. Install this extension:**

```bash
pi install npm:pi-memorix
```

To try it without making it permanent: `pi -e npm:pi-memorix`

**3. Wire the MCP server** so the LLM can call `memorix_search`, `memorix_store`, etc. directly:

Add this entry to `~/.pi/agent/mcp.json` under `mcpServers`:

```json
"memorix": {
  "command": "memorix",
  "args": ["serve"],
  "directTools": true
}
```

**4. (Optional) Enable auto-install of the git hook** so commit-time capture is set up automatically for every repo you open:

Create `~/.pi/agent/memorix.json`:

```json
{ "autoGitHook": true }
```

With this enabled, the extension installs the hook the first time you open a repo that doesn't have it yet. To install manually instead:

```bash
memorix git-hook   # run once per repo
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
