# claude-code-zed-acp (Fork)

This is a fork of [`zed-industries/claude-agent-acp`](https://github.com/zed-industries/claude-agent-acp) that restores Zed's **Review Changes** diff UI for Claude Code file edits.

## Why This Fork Exists

In v0.18.0 (PR #316), the upstream repo removed an in-process MCP server that previously routed Claude Code's file Write/Edit operations through Zed's ACP filesystem APIs (`fs/write_text_file`). This removal eliminated the "Review Changes" multibuffer UI where users could accept/reject edits inline within Zed.

The MCP server was removed because it had critical bugs:
- Subagents (Task tool) couldn't access MCP tools, causing Write/Edit to silently fail
- `mcp__acp__Read` returned stale buffer content
- Image/binary file handling was broken
- Claude Code's `.claude/settings.json` permissions were bypassed

This fork restores the Review Changes UI using a **PostToolUse intercept** pattern instead of an MCP server, which fixes all of those bugs.

## What This Fork Changes

All changes are additive — no upstream code is modified in a breaking way. The fork makes **small additions** to three existing files.

### Modified: `src/tools.ts`

Additions appended at end of file:

1. **Import** — `fs` from `node:fs`.

2. **`extractReadContent(toolResponse)`** — Extracts file content directly from the Read tool's `tool_response` string, avoiding a redundant ACP round-trip.

3. **`isToolError(toolResponse)`** — Checks if a tool response indicates an error (the response contains `is_error: true`).

4. **`FileEditInterceptor` interface** — Two methods:
   - `onFileRead(filePath, content)` — Caches file content when Read completes.
   - `interceptEditWrite(toolName, toolInput, toolResponse, writeTextFile)` — Reverts the disk write and routes through ACP.

5. **`createFileEditInterceptor(logger)`** — Factory that returns a `FileEditInterceptor`. Contains a `fileContentCache` Map in its closure. The interceptor:
   - Lets the built-in Edit/Write tool execute normally (writing to disk)
   - Determines the new content (from disk for Edit, from `input.content` for Write)
   - Reverts the file to its pre-edit state (or skips revert for uncached files)
   - Routes the new content through `writeTextFile` → Zed's Review Changes UI
   - Updates the cache for consecutive edits

6. **`createPostToolUseHook()` `onFileRead` option** — Extended with an optional `onFileRead(filePath, content)` callback that fires when the built-in Read tool completes, feeding the interceptor's cache via `extractReadContent`.

Key design decisions:
- **PostToolUse intercept, not MCP** — Built-in Edit/Write execute normally, then the PostToolUse hook intercepts, reverts, and routes through ACP. This works for both main sessions and subagents (subagents use built-in tools directly, which the PostToolUse hook can intercept).
- **No system prompt or PreToolUse hook needed** — Claude uses its built-in Edit/Write tools naturally. No tool redirection or MCP tool names to worry about.
- **No `@modelcontextprotocol/sdk` dependency** — The MCP server is gone entirely.
- **Read-before-edit cache** — The `fileContentCache` tracks what the agent last Read. Edits read the new content from disk (already written by the built-in Edit tool). If the file was modified externally since the last Read, the built-in Edit tool will fail on its own (`old_string` not found). Uncached files fall back to reading from disk and skip revert.
- **Cache update after edit** — After a successful ACP route, the cache is updated with the new content so consecutive edits to the same file work without re-reading.

### Modified: `src/acp-agent.ts`

Changes in `createSession()`:

1. **`FileEditInterceptor` creation**: When `clientCapabilities.fs.writeTextFile` is available, calls `createFileEditInterceptor(this.logger)` and stores the result on the session object.

2. **PostToolUse `onFileRead` wiring**: Passes `fileEditInterceptor.onFileRead` to `createPostToolUseHook()` so that when the built-in Read tool completes, `extractReadContent` extracts the file content and caches it.

Changes in `toAcpNotifications()` and `streamEventToAcpNotifications()`:

3. **`fileEditInterceptor` option**: Both functions accept an optional `fileEditInterceptor` in their options. In the `onPostToolUseHook` callback, if the tool is Edit or Write, the interceptor's `interceptEditWrite` is called with `client.writeTextFile` before the normal notification logic runs.

Changes in `prompt()`:

4. **User message echo suppression**: All `user` type messages from the SDK are skipped in the output feed. The SDK echoes back user messages, but these should not appear in Zed's agent output. Content filtering always strips `text` and `thinking` blocks (handled by stream events), regardless of message type.

Changes in `canUseTool()`:

5. **ExitPlanMode `bypassPermissions` option**: When `ALLOW_BYPASS` is true, the ExitPlanMode permission dialog includes a "Yes, and bypass permissions" option. Options are ordered: acceptEdits → bypassPermissions → default → plan. The outcome handler recognizes `bypassPermissions` as a valid mode transition.

New imports at top of file:
```typescript
import { createFileEditInterceptor, type FileEditInterceptor } from "./tools.js";
```

Session type addition:
```typescript
fileEditInterceptor?: FileEditInterceptor;
```

### Modified: `src/lib.ts`

Added exports:
```typescript
export { ..., createFileEditInterceptor, type FileEditInterceptor } from "./tools.js";
```

## How to Merge Upstream Updates

When pulling changes from `zed-industries/claude-agent-acp`:

1. **`src/acp-agent.ts`** — Our changes are isolated insertion blocks:
   - `createFileEditInterceptor` block (~5 lines in `createSession()` after capabilities check)
   - PostToolUse `onFileRead` wiring (~3 lines in the `createPostToolUseHook` options)
   - `fileEditInterceptor` forwarding in `toAcpNotifications` and `streamEventToAcpNotifications`
   - User message echo suppression in `prompt()` (simplified filtering of `message.type === "user"`)
   - ExitPlanMode `bypassPermissions` option in `canUseTool()` (conditional on `ALLOW_BYPASS`)

   If upstream modifies `createSession()`, `prompt()`, or `canUseTool()`, these blocks just need to stay in the same logical positions.

2. **`src/tools.ts`** — Our changes are:
   - `fs` import addition at the top
   - `extractReadContent`, `isToolError`, `FileEditInterceptor`, `createFileEditInterceptor` appended at end of file
   - `onFileRead` option added to `createPostToolUseHook`

   If upstream adds new tool handling, our additions are all at the end of the file and shouldn't conflict.

3. **`src/lib.ts`** — Export lines. Straightforward to re-add if upstream modifies exports.

## Architecture

```
Zed <──ACP (ndjson/stdio)──> ClaudeAcpAgent <──Claude Agent SDK──> Claude API
                                    │
                                    ├── FileEditInterceptor (PostToolUse hook)
                                    │   ├── Edit: read from disk → revert → writeTextFile → Review UI
                                    │   └── Write: revert → writeTextFile → Review UI
                                    │
                                    └── PostToolUse onFileRead (caches content for revert)
```

### Flow: Edit/Write (Main Session and Subagents)
1. Claude calls the built-in Edit or Write tool
2. The tool executes normally, writing to disk
3. PostToolUse hook fires → `interceptEditWrite` is called
4. Interceptor determines the new content (from disk for Edit, from input for Write)
5. Interceptor reverts the file to its pre-edit state on disk
6. Interceptor routes the new content through `writeTextFile` → Zed's Review Changes UI
7. Zed shows the change in **Review Changes** multibuffer with accept/reject controls
8. User accepts or rejects inline
9. Cache is updated with the new content for consecutive edits

### Flow: Uncached File Edit
1. Claude edits a file it never explicitly Read (e.g., found via Grep)
2. No cached content → interceptor reads the new content from disk (already written by built-in tool)
3. No original content to revert to → revert is skipped
4. New content is routed through ACP as usual

## Creating and Updating Releases

GitHub Actions is not enabled on this fork, so releases are created manually via `gh`. Use the `-custom` suffix to distinguish from upstream versions (e.g., `v0.19.2-custom`). Always specify `--repo <owner>/<repo>` (matching this fork's `origin` remote) to avoid hitting the upstream repo.

### New release

```bash
git tag v<version>
git push origin v<version>
gh release create v<version> --title "v<version>" --generate-notes --repo <owner>/<repo>
```

### Updating an existing release to the current commit

This deletes the old release and its remote tag, moves the local tag, and recreates the release at HEAD:

```bash
gh release delete v<version> --yes --cleanup-tag --repo <owner>/<repo>
git tag -d v<version>
git tag v<version> HEAD
git push origin v<version>
gh release create v<version> --title "v<version>" --generate-notes --repo <owner>/<repo>
```

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
