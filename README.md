# Claude Code ACP Adapter — Edit Review Fork

> A fork of [`zed-industries/claude-agent-acp`](https://github.com/zed-industries/claude-agent-acp) that restores Zed's **Review Changes** diff UI for Claude Code file edits.

## Overview

This adapter connects [Claude Code](https://docs.anthropic.com/en/docs/claude-code) to [Zed](https://zed.dev) via the [Agent Client Protocol (ACP)](https://agentclientprotocol.com). It adds a transparent **PostToolUse intercept** that routes file Write/Edit operations through Zed's buffer system, triggering the native **Review Changes** multibuffer where users can accept or reject each edit inline.

The upstream adapter (v0.18.0+) writes files directly to disk. This fork lets the built-in Edit/Write tools execute normally, then immediately reverts the file and routes the new content through Zed's `fs/write_text_file` ACP API, so every file change gets a diff review.

## How It Works

```
Zed ◄──ACP──► ClaudeAcpAgent ◄──Claude Agent SDK──► Claude API
                    │
                    ├── FileEditInterceptor (PostToolUse hook)
                    │   ├── Edit: revert + route through ACP → Review UI
                    │   └── Write: revert + route through ACP → Review UI
                    │
                    └── PostToolUse onFileRead (caches content for revert)
```

1. Claude calls the **built-in Edit or Write** tool — it executes normally, writing to disk
2. The **PostToolUse hook** fires and calls the `FileEditInterceptor`
3. The interceptor **reverts** the file to its pre-edit state on disk
4. The interceptor **routes** the new content through `writeTextFile` → Zed's Review Changes UI
5. The user **accepts or rejects** the change inline

This works for both main sessions and subagents — since Claude uses its built-in tools directly, there are no MCP tool access issues.

## Background

In v0.18.0 ([PR #316](https://github.com/zed-industries/claude-agent-acp/pull/316)), the upstream repo removed an earlier MCP server that provided this functionality because it had critical bugs:

- **Subagent failures** — MCP tools couldn't be accessed by subagents (Task tool), causing silent write failures
- **Stale reads** — `mcp__acp__Read` returned outdated buffer content
- **Binary file crashes** — Image and binary files broke the ACP text routing
- **Permission bypass** — Custom permissions engine conflicted with Claude Code's `.claude/settings.json`

This fork fixes all of those by using a PostToolUse intercept instead of an MCP server:

| Decision | Rationale |
|----------|-----------|
| **PostToolUse intercept, not MCP** | Built-in tools work everywhere (main session + subagents). No MCP tool access issues. |
| **Write/Edit only** (no Read, no Bash) | Read works fine built-in. Only write operations need ACP routing for the Review UI. |
| **Read-before-edit cache** | Files are cached when Read completes. Cache is used for reverting to the pre-edit state. Consecutive edits work without re-reading. |
| **No system prompt or PreToolUse hook** | Claude uses its built-in tools naturally. No tool redirection needed. |
| **No custom permissions** | Relies on Claude Code's built-in `canUseTool` and settings files. |

## Setup

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Zed](https://zed.dev) (latest)
- An Anthropic API key or Claude Code authentication

### Install and Build

```bash
git clone https://github.com/rohanpatra/claude-code-zed-acp.git
cd claude-code-zed-acp
npm install
npm run build
```

### Configure in Zed

Add to your Zed settings (`~/.config/zed/settings.json`):

```json
{
  "agent_servers": {
    "Claude Code by Rohan Patra": {
      "type": "custom",
      "command": "node",
      "args": ["/absolute/path/to/claude-code-zed-acp/dist/index.js"]
    }
  }
}
```

Restart Zed. The custom agent will appear in the Agent Panel under the `+` menu.

## Features

Everything from the upstream adapter, plus improvements that bring the Zed experience closer to native Claude Code:

- **Edit review** — File edits appear in Zed's Review Changes multibuffer with accept/reject controls
- **Write review** — New file creation also flows through the diff viewer
- **Read-before-edit cache** — Files are cached on Read so the interceptor can revert to the pre-edit state before routing through ACP
- **Subagent compatibility** — Built-in tools work everywhere, fixing silent failures from the previous MCP-based implementation
- **No tool redirection** — Claude uses its built-in Edit/Write tools naturally; the PostToolUse hook handles interception transparently
- **ExitPlanMode bypass option** — When exiting plan mode, users can choose "Yes, and bypass permissions" alongside the existing accept-edits and default options
- **Clean output feed** — User message echoes from the SDK are suppressed, keeping the Zed agent output free of duplicated input

All other upstream features work unchanged:
- Context @-mentions and images
- Tool calls with permission requests
- Interactive and background terminals
- TODO lists and plan mode
- Custom slash commands
- Client MCP servers

## Development

```bash
npm run build          # TypeScript compilation
npm run test:run       # Unit tests
npm run dev            # Build + start
npm run test:integration  # Integration tests (requires RUN_INTEGRATION_TESTS=true)
```

## Keeping Up with Upstream

This fork is designed for easy merges. All changes are additive:

| File | Change | Merge notes |
|------|--------|-------------|
| `src/acp-agent.ts` | `FileEditInterceptor` creation + wiring in `createSession()`, forwarding in `toAcpNotifications`/`streamEventToAcpNotifications`, user message suppression in `prompt()`, `bypassPermissions` option in `canUseTool()` | Keep blocks in same logical positions |
| `src/tools.ts` | Imports, helpers, `FileEditInterceptor` interface + factory at EOF, `onFileRead` option in `createPostToolUseHook` | Additions at end of file; shouldn't conflict |
| `src/lib.ts` | 1 export line | Re-add if upstream changes exports |
| `package.json` | No changes currently | May diverge if deps are added |

See [CLAUDE.md](./CLAUDE.md) for detailed merge instructions and architecture documentation.

## License

Apache-2.0 (same as upstream)
