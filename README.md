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

**3. (Optional) Wire the MCP server** so the LLM can also call `memorix_search`, `memorix_store`, etc. directly:

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

## Bootstrapping an existing repo

For repos with existing history, seed Memorix from past commits before the git hook takes over:

```bash
memorix ingest log             # last 10 commits
memorix ingest log --count 50  # go further back
```

Run once per repo. The git hook handles new commits from that point on.

## Usage

Once installed, the extension runs automatically with every Pi session. Steps 3 and 4 are optional — the extension's lifecycle hooks work without them. The MCP server (step 3) adds the ability for the LLM to call `memorix_search` and `memorix_store` directly on top of the automatic capture.

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

Logs all hook activity to stderr. To verify hooks are firing:

```
[memorix-pi] SessionStart: loaded 1234 chars
[memorix-pi] PostToolUse — memorix stored observation
[memorix-pi] Auto-installed git hook in /your/repo
[memorix-pi] Stop: session saved to memorix
```

To see what was stored after a session:

```bash
cd your-repo && memorix recent
```

## Maintenance

```bash
# Health check — project identity, data, conflicts
memorix doctor

# Preview and remove low-quality auto-captured noise
memorix cleanup --dry
memorix cleanup --force

# Inspect what's expiring; archive old memories
memorix retention

# Project info and rules sync status
memorix status
```

## Notes

- Memorix requires a `.git` directory in the project root to identify the project. Outside git repos, hooks are silently skipped.
- All Memorix failures are silent by default — Pi never crashes because of this extension.
- If `memorix` is not found on PATH, the extension disables itself after the first failed spawn.
