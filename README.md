# Claude Code ACP Adapter — Edit Review Fork

> A fork of [`zed-industries/claude-agent-acp`](https://github.com/zed-industries/claude-agent-acp) that restores Zed's **Review Changes** diff UI for Claude Code file edits.

## Overview

This adapter connects [Claude Code](https://docs.anthropic.com/en/docs/claude-code) to [Zed](https://zed.dev) via the [Agent Client Protocol (ACP)](https://agentclientprotocol.com). It adds an in-process MCP server that routes file Write/Edit operations through Zed's buffer system, triggering the native **Review Changes** multibuffer where users can accept or reject each edit inline.

The upstream adapter (v0.18.0+) writes files directly to disk. This fork intercepts those writes and sends them through Zed's `fs/write_text_file` ACP API instead, so every file change gets a diff review.

## How It Works

```
Zed ◄──ACP──► ClaudeAcpAgent ◄──Claude Agent SDK──► Claude API
                    │
                    ├── MCP Server (in-process)
                    │   ├── mcp__acp__Write → Zed buffer → Review UI
                    │   └── mcp__acp__Edit  → read + transform + write → Review UI
                    │
                    ├── System Prompt (instructs Claude to use MCP tools)
                    │
                    └── PreToolUse Hook (safety net redirect)
```

1. A **system prompt append** (generated from a `toolRedirects` map) tells Claude to use `mcp__acp__Edit` and `mcp__acp__Write` instead of the built-in equivalents
2. An **in-process MCP server** handles those tools by routing writes through Zed's ACP filesystem APIs
3. A **PreToolUse hook** acts as a safety net — if Claude still tries the built-in Edit/Write, the hook denies it with a redirect message

All three are driven by a single `toolRedirects` record in `src/tools.ts`. Adding a new tool redirect only requires adding one entry.

## Background

In v0.18.0 ([PR #316](https://github.com/zed-industries/claude-agent-acp/pull/316)), the upstream repo removed an earlier MCP server that provided this functionality because it had critical bugs:

- **Subagent failures** — Bash/terminal MCP tools couldn't be accessed by subagents (Task tool), causing silent write failures
- **Stale reads** — `mcp__acp__Read` returned outdated buffer content
- **Binary file crashes** — Image and binary files broke the ACP text routing
- **Permission bypass** — Custom permissions engine conflicted with Claude Code's `.claude/settings.json`

This fork fixes all of those by taking a narrower approach, while also bringing the Zed editing experience closer to the native Claude Code interface:

| Decision | Rationale |
|----------|-----------|
| **Write/Edit only** (no Read, no Bash) | Read works fine built-in. Bash MCP tools were the root cause of the subagent bug. |
| **Read-before-edit guard** | Matches native Claude Code behavior: files must be read before editing, and edits are rejected if the file changed since the last read. Prevents edits based on stale context. |
| **System prompt + PreToolUse hook** (not `disallowedTools`) | `disallowedTools` propagates to subagents and blocks their writes. The hook is a local safety net. |
| **No custom permissions** | Relies on Claude Code's built-in `canUseTool` and settings files. |
| **Internal paths bypass ACP** | `~/.claude/` paths (except settings) go direct to filesystem for agent state persistence. |

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
- **Read-before-edit enforcement** — Like native Claude Code, files must be read before editing. Edits are rejected if the file has been modified since the last read, preventing changes based on stale context. The previous Zed MCP server (v0.17.1) did not have this guard.
- **Subagent compatibility** — Subagents (Task tool) fall back to built-in tools gracefully, fixing silent failures from the previous implementation
- **Zero failed calls** — System prompt guides Claude to the correct tools from the first edit, with a PreToolUse hook as a safety net

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
| `src/mcp-server.ts` | **New file** | Never conflicts with upstream |
| `src/acp-agent.ts` | 3 insertion blocks in `createSession()` | Keep blocks in same logical positions |
| `src/tools.ts` | 1 import, 3 case fallthroughs, 3 functions at EOF | Keep `acpToolNames` cases paired with builtins |
| `src/lib.ts` | 2 export lines | Re-add if upstream changes exports |
| `package.json` | `@modelcontextprotocol/sdk`, `diff` deps | Keep these dependencies |

See [CLAUDE.md](./CLAUDE.md) for detailed merge instructions and architecture documentation.

## License

Apache-2.0 (same as upstream)
