# ADR-001: Tools Whitelist Pass-Through

## Status

Accepted

## Date

2026-03-06

## Context

The ACP adapter creates Claude Code sessions via the `@anthropic-ai/claude-agent-sdk`. When creating a session, the SDK accepts a `tools` option that controls which built-in tools are registered in the model's context:

- `{ type: "preset", preset: "claude_code" }` — all ~15 built-in tools (Read, Write, Edit, Bash, Glob, Grep, etc.)
- `["Read", "Glob"]` — only the listed tools
- `[]` — no built-in tools

### Problem

The ACP adapter hard-coded `tools: { type: "preset", preset: "claude_code" }`, ignoring any value the caller provided via `_meta.claudeCode.options.tools`. This caused two problems:

1. **Wasted context tokens** — All ~15 tool schemas were always sent to the model, even when the caller only needed a subset (e.g., Read and Glob for a review-only workflow) or none at all (MCP-only sessions).

2. **Rejected tool call round trips** — When `disableBuiltInTools: true` was used, the tools were still registered in the model's context (the flag only added them to `disallowedTools`). The model would see the tool schemas, attempt to call them, get rejected, and waste a round trip.

Additionally, the existing `disableBuiltInTools` flag had a design flaw: it maintained a hard-coded list of 14 tool names to blocklist. If the SDK added a new built-in tool, `disableBuiltInTools` wouldn't cover it — the new tool would leak through.

### Alternatives Considered

1. **Keep `disableBuiltInTools` as-is, only add `tools` pass-through**
   - Rejected: Leaves the conflicting behavior where both `tools: ["Read"]` and `disableBuiltInTools: true` could be set, with `disableBuiltInTools` blocklisting the tools that `tools` explicitly whitelisted.

2. **Add `allowedTools` pass-through alongside `tools`**
   - Rejected: `allowedTools` controls permission auto-approval (skip the "do you approve?" prompt), not tool availability. It doesn't address the token waste or rejected call problems. Different concern, unnecessary scope.

3. **Expand the `disableBuiltInTools` blocklist whenever the SDK adds tools**
   - Rejected: Maintenance burden, always one step behind the SDK.

4. **Semantic tool permission groups at the ACP protocol level**
   - Considered: Instead of passing agent-specific tool names (e.g., `["Read", "Glob"]`), define semantic capability groups that all ACP agents understand:
     - `read` — file reading, search, glob (Claude: Read, Glob, Grep; other agents: their equivalents)
     - `write` — file creation and editing (Claude: Write, Edit; others: their equivalents)
     - `execute` — command execution (Claude: Bash; others: their equivalents)
     - `all` — full access
   - A generic ACP client could then tell any agent "you are in read-only mode" without knowing the agent's internal tool names. This decouples the permission model from agent implementation details.
   - Deferred: This belongs in the ACP protocol specification, not in a Claude-specific `_meta` extension. The current change solves the immediate problem (token waste, rejected calls) within the existing Claude SDK contract. The semantic groups idea should be proposed as an ACP spec enhancement.
   - **Action item:** File an issue on the [ACP protocol repository](https://github.com/agentclientprotocol/agent-client-protocol) proposing standardized tool capability groups as part of the protocol.

### SDK Contract Validation

The `tools` option is documented in the [Claude Agent SDK TypeScript reference](https://platform.claude.com/docs/en/agent-sdk/typescript) as:

```typescript
tools?: string[] | { type: 'preset'; preset: 'claude_code' };
```

> Tool configuration. Pass an array of tool names or use the preset to get Claude Code's default tools.

The type `string[]` includes `[]` (empty array) with no minimum length constraint. Passing an empty array to disable all built-in tools is a valid use of the SDK contract, not a workaround.

## Decision

### 1. Pass through `tools` from caller metadata

The `tools` field now uses the caller-provided value if present, falling back to the `claude_code` preset:

```typescript
tools: userProvidedOptions?.tools ?? { type: "preset", preset: "claude_code" },
```

### 2. Reimplement `disableBuiltInTools` as `tools: []`

Instead of pushing 14 tool names into `disallowedTools`, `disableBuiltInTools: true` now resolves to `tools: []`. This removes tools from the model's context entirely rather than registering them and then blocking them.

### 3. Explicit `tools` takes precedence over `disableBuiltInTools`

Resolution order:

```
_meta.claudeCode.options.tools  →  use it (explicit whitelist)
_meta.disableBuiltInTools: true →  tools: [] (legacy shorthand)
neither                         →  { type: "preset", preset: "claude_code" } (default)
```

This makes `disableBuiltInTools` a backward-compatible legacy shorthand. Callers should prefer the `tools` array going forward.

## Consequences

### Positive

1. **Token savings** — Callers can expose only the tools they need. A session with `tools: ["Read", "Glob"]` sends 2 tool schemas instead of 15.
2. **No rejected round trips** — Tools not in the `tools` array never enter the model's context, so the model can't attempt to call them.
3. **Future-proof** — `tools: []` removes all built-in tools regardless of what the SDK adds later. No hard-coded list to maintain.
4. **Non-breaking** — Callers that don't provide `tools` get identical behavior (full `claude_code` preset). `disableBuiltInTools: true` still works.

### Negative

1. **Two ways to disable tools** — Both `tools: []` and `disableBuiltInTools: true` achieve the same result. The latter is kept only for backward compatibility.

### Neutral

1. **`disableBuiltInTools` is effectively deprecated** — It still works but is now a less flexible alias for `tools: []`.

## Usage Examples

```typescript
// Review-only session: model can only read files
await agent.newSession({
  cwd: "/project",
  mcpServers: [],
  _meta: {
    claudeCode: {
      options: {
        tools: ["Read", "Glob"],
      }
    }
  }
});

// MCP-only session: no built-in tools, only custom MCP servers
await agent.newSession({
  cwd: "/project",
  mcpServers: [{ name: "my-server", command: "node", args: ["server.js"], env: [] }],
  _meta: {
    claudeCode: {
      options: {
        tools: [],
        mcpServers: { "my-mcp": { type: "stdio", command: "node", args: ["mcp.js"] } },
      }
    }
  }
});

// Legacy: still works, now equivalent to tools: []
await agent.newSession({
  cwd: "/project",
  mcpServers: [],
  _meta: { disableBuiltInTools: true }
});
```

## Files Modified

| File | Change |
|------|--------|
| `src/acp-agent.ts` | `tools` pass-through (line 1275), `disableBuiltInTools` reimplemented as `tools: []` (lines 1222-1230), JSDoc updated (line 151) |
| `src/tests/create-session-options.test.ts` | 4 new tests: default preset, explicit array, empty array, `tools` overrides `disableBuiltInTools` |

## Test Coverage

| Test | Verifies |
|------|----------|
| `defaults tools to claude_code preset when not provided` | Backward compatibility — no `tools` = full preset |
| `passes through user-provided tools string array` | Whitelist: `["Read", "Glob"]` arrives as-is |
| `passes through empty tools array to disable all built-in tools` | `tools: []` disables everything |
| `explicit tools array takes precedence over disableBuiltInTools` | Resolution priority: explicit `tools` wins over `disableBuiltInTools` |
| `sets tools to empty array when disableBuiltInTools is true` | Legacy flag now produces `tools: []` instead of blocklist |
