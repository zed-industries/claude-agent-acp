# claude-code-zed-acp (Fork)

This is a fork of [`zed-industries/claude-agent-acp`](https://github.com/zed-industries/claude-agent-acp) that restores Zed's **Review Changes** diff UI for Claude Code file edits.

## Why This Fork Exists

In v0.18.0 (PR #316), the upstream repo removed an in-process MCP server that previously routed Claude Code's file Write/Edit operations through Zed's ACP filesystem APIs (`fs/write_text_file`). This removal eliminated the "Review Changes" multibuffer UI where users could accept/reject edits inline within Zed.

The MCP server was removed because it had critical bugs:
- Subagents (Task tool) couldn't access MCP tools, causing Write/Edit to silently fail
- `mcp__acp__Read` returned stale buffer content
- Image/binary file handling was broken
- Claude Code's `.claude/settings.json` permissions were bypassed

This fork adds back a simplified MCP server that fixes all of those bugs.

## What This Fork Changes

All changes are additive — no upstream code is modified in a breaking way. The fork adds **one new file** and makes **small additions** to three existing files.

### New File: `src/mcp-server.ts`

An in-process MCP server that registers two tools under the `mcp__acp__` namespace.

`createMcpServer()` returns a `McpServerResult` containing:
- **`server`** — The `McpServer` instance registered with the Claude Agent SDK
- **`onFileRead(filePath)`** — Callback to invoke when Claude reads a file (via PostToolUse on the built-in Read tool). Caches the file content for staleness detection.

Registered tools:
- **`mcp__acp__Write`** — Writes files via `agent.client.writeTextFile()`, which triggers Zed's Review Changes UI. For existing files, enforces read-before-write and staleness checks.
- **`mcp__acp__Edit`** — Reads current content via ACP, enforces read-before-edit and staleness checks, applies `str_replace`, writes via ACP, returns a unified diff. After a successful edit, the cache is updated with the new content so consecutive edits to the same file don't require re-reading.

Key design decisions:
- **No Read tool** — Claude uses its built-in Read tool. Only write operations need ACP routing for the Review UI.
- **No Bash/terminal tools** — These work fine with built-in tools + PostToolUse hooks. Including them in the old MCP server was the root cause of the subagent bug (subagents couldn't access MCP tools).
- **No custom permissions** — Relies entirely on Claude Code's built-in `canUseTool` and `.claude/settings.json`.
- **Internal paths bypass ACP** — Paths under `~/.claude/` (except settings files) go directly to the filesystem so agent state persistence works.
- **Read-before-edit guard** — Enforces that Claude must read a file before editing it, and that the file hasn't changed since the last read. This matches the native Claude Code Edit tool behavior and prevents edits based on stale context. The guard is powered by a `fileContentCache` inside the MCP server closure, populated via a PostToolUse hook on the built-in Read tool. After a successful edit/write, the cache is updated with the new content so consecutive edits don't require re-reading.
- **Edit uniqueness check** — Throws if `old_string` matches multiple times (unless `replace_all` is set), matching the built-in Edit tool behavior.
- Uses `diff.createPatch()` from the `diff` npm package for unified diff output (same as the old v0.17.1 server).

### Modified: `src/acp-agent.ts`

Three additions in `createSession()`:

1. **MCP server registration**: When `clientCapabilities.fs.writeTextFile` is available, creates and registers the in-process MCP server as `mcpServers["acp"]` with `type: "sdk"`. The `onFileRead` callback from the MCP server is captured and wired to the PostToolUse hook. Placed before client-provided MCP servers so they can override if needed.

2. **System prompt append**: Calls `buildToolRedirectPrompt()` to programmatically generate instructions from `toolRedirects`, telling Claude to use `mcp__acp__Edit`/`mcp__acp__Write` from the start of the session. Ensures Claude uses the correct tools on the first edit without a failed attempt.

3. **PreToolUse hook registration**: Derives the matcher pattern from `Object.keys(toolRedirects).join("|")` and registers `createPreToolUseHook()` as a safety net. If Claude ignores the system prompt and tries the built-in Edit/Write, the hook denies it with a redirect message.

4. **PostToolUse `onFileRead` wiring**: Passes the MCP server's `onFileRead` callback to `createPostToolUseHook()` so that when the built-in Read tool completes, the file content is cached for staleness detection.

New imports at top of file:
```typescript
import { createPreToolUseHook, buildToolRedirectPrompt, toolRedirects } from "./tools.js";
import { createMcpServer } from "./mcp-server.js";
```

### Modified: `src/tools.ts`

Additions:

1. **`import { acpToolNames } from "./mcp-server.js"`** — Imports the MCP tool name constants.

2. **`toolInfoFromToolUse()` cases** — Added `acpToolNames.write` and `acpToolNames.edit` as fallthrough cases alongside `"Write"` and `"Edit"` so MCP tool calls get proper diff/location rendering in Zed's UI.

3. **`toolUpdateFromToolResult()` cases** — Added `acpToolNames.write` and `acpToolNames.edit` alongside `"Write"` and `"Edit"` so MCP tool results return `{}` (handled by hooks).

4. **`toolRedirects`** — A `Record<string, string>` mapping built-in tool names to their `mcp__acp__` equivalents. Single source of truth consumed by the system prompt builder, the PreToolUse hook, and the hook matcher pattern.

5. **`buildToolRedirectPrompt()`** — Programmatically generates a system prompt append string from `toolRedirects`. Adding a new tool redirect only requires adding an entry to `toolRedirects`.

6. **`createPreToolUseHook()`** — A `HookCallback` that looks up `toolRedirects[tool_name]` and denies with a redirect message if found. Uses strict equality on `tool_name` so it won't accidentally match `mcp__acp__Write`.

7. **`createPostToolUseHook()` `onFileRead` option** — Extended with an optional `onFileRead` callback that fires when the built-in Read tool completes. This feeds the MCP server's `fileContentCache` so Edit/Write can enforce read-before-edit and detect stale content.

### Modified: `src/lib.ts`

Added exports:
```typescript
export { ..., createPreToolUseHook, buildToolRedirectPrompt, toolRedirects } from "./tools.js";
export { createMcpServer, acpToolNames } from "./mcp-server.js";
```

### Modified: `package.json`

Added runtime dependencies:
- `@modelcontextprotocol/sdk` — For `McpServer` class used by the in-process MCP server
- `diff` — For `diff.createPatch()` in the Edit tool
- `@types/diff` (devDependency) — TypeScript types for diff

## How to Merge Upstream Updates

When pulling changes from `zed-industries/claude-agent-acp`:

1. **`src/mcp-server.ts`** — This file doesn't exist upstream, so it will never conflict.

2. **`src/acp-agent.ts`** — Our changes are three isolated insertion blocks:
   - MCP server registration block (~10 lines after `const mcpServers = {}`)
   - System prompt append block (~5 lines after the `systemPrompt` config)
   - PreToolUse hook block (~12 lines inside the `hooks: {}` config)

   If upstream modifies `createSession()`, these blocks just need to stay in the same logical positions. The MCP server block goes after the `mcpServers` variable declaration. The system prompt block goes after the existing `systemPrompt` handling. The PreToolUse block goes inside the `hooks` object alongside `PostToolUse`.

3. **`src/tools.ts`** — Our changes are:
   - One import line at the top
   - Three `case` fallthrough additions in switch statements (adding `acpToolNames.write`/`acpToolNames.edit` next to `"Write"`/`"Edit"`)
   - `toolRedirects`, `buildToolRedirectPrompt`, and `createPreToolUseHook` appended at end of file

   If upstream adds new tool handling in `toolInfoFromToolUse` or `toolUpdateFromToolResult`, just ensure the `acpToolNames` cases stay paired with their built-in equivalents.

4. **`src/lib.ts`** — Export lines. Straightforward to re-add if upstream modifies exports.

5. **`package.json`** — Keep `@modelcontextprotocol/sdk`, `diff`, and `@types/diff` as dependencies.

## Architecture

```
Zed <──ACP (ndjson/stdio)──> ClaudeAcpAgent <──Claude Agent SDK──> Claude API
                                    │
                                    ├── MCP Server (in-process, type: "sdk")
                                    │   ├── mcp__acp__Write → fs/write_text_file → Zed buffer → Review UI
                                    │   └── mcp__acp__Edit  → fs/read + transform + fs/write → Review UI
                                    │
                                    ├── System Prompt Append (from toolRedirects)
                                    │   └── "ALWAYS use mcp__acp__Edit instead of Edit, ..."
                                    │
                                    └── PreToolUse Hook (safety net, from toolRedirects)
                                        └── Denies built-in Write/Edit → redirects to mcp__acp__ tools
```

### Flow: Main Session Edit
1. System prompt tells Claude to use `mcp__acp__Edit` / `mcp__acp__Write`
2. Claude calls `mcp__acp__Edit` directly (no failed attempt)
3. MCP server reads file via ACP, applies str_replace, writes via `fs/write_text_file`
4. Zed shows the change in **Review Changes** multibuffer with accept/reject controls
5. User accepts or rejects inline

### Flow: Subagent Edit (Fallback)
1. Subagent tries built-in Write/Edit
2. PreToolUse hook may or may not propagate to subagents
3. If it doesn't propagate → built-in tool works directly on disk (no review UI, but no failure)
4. PostToolUse hook (unchanged from upstream) sends diff info to Zed for display

## Testing

```bash
npm run build          # TypeScript compilation
npm run test:run       # Unit tests (95 tests)
npm run test:integration  # Integration tests (requires RUN_INTEGRATION_TESTS=true)
```

## Setup in Zed

Build, then point Zed's settings to the built output:

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
