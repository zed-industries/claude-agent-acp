# Library Guide

This package can be used as a CLI or as an embedded library. The library exports are grouped into
four areas.

## Agent runtime

- `ClaudeAcpAgent`: ACP `Agent` implementation backed by the Claude Agent SDK
- `runAcp()`: starts the default stdin/stdout ACP transport
- `toAcpNotifications()` and `streamEventToAcpNotifications()`: convert Claude SDK content and
  partial stream events into ACP session notifications

## Settings and stream helpers

- `SettingsManager`: loads Claude settings, watches them, and exposes merged values
- `loadManagedSettings()` and `applyEnvironmentSettings()`: read enterprise-managed settings and
  project their `env` values into `process.env`
- `nodeToWebReadable()` and `nodeToWebWritable()`: bridge Node streams to the ACP SDK's web-stream
  transport
- `Pushable`: async iterable used internally to queue prompt input

## Invocation directory helpers

- `defaultClaudeConfigDir()`
- `resolveClaudeInvocationPaths()`
- `backupInvocationDirectory()`
- `restoreInvocationDirectory()`

These helpers are useful when you want per-user or per-project Claude state that can be snapshotted
or restored outside the adapter.

## Tool formatting helpers

- `toolInfoFromToolUse()`
- `toolUpdateFromToolResult()`
- `planEntries()`
- `toDisplayPath()`

These are mainly useful if you are extending the adapter or reusing its Claude-to-ACP conversion
logic.

## Minimal embedded usage

`runAcp()` already wires stdin/stdout for you, but embedding `ClaudeAcpAgent` directly gives you
control over logging and transport setup:

```ts
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { ClaudeAcpAgent, nodeToWebReadable, nodeToWebWritable } from "@ni2khanna/claude-agent-acp";

const stream = ndJsonStream(nodeToWebWritable(process.stdout), nodeToWebReadable(process.stdin));

new AgentSideConnection(
  (client) =>
    new ClaudeAcpAgent(client, {
      defaultTools: ["Bash", "Read", "Glob", "Grep", "WebSearch", "WebFetch"],
    }),
  stream,
);
```

`defaultTools` lets you choose the built-in Claude tool profile at agent initialization time. Per-session
`_meta.claudeCode.options.tools` still takes precedence, and `_meta.disableBuiltInTools` still forces `[]`.

The CLI entrypoint does two extra things before calling `runAcp()`:

- it loads enterprise-managed settings and applies any configured environment variables
- it redirects `console.*` output to stderr so stdout remains a clean ACP transport

## Session creation metadata

The adapter reads a small set of `_meta` fields during `newSession`, `loadSession`, `resume`, and
fork operations.

| Field                        | Effect                                                                                                                            |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `_meta.systemPrompt`         | Replaces the default prompt or appends extra instructions when passed as `{ append: string }`.                                    |
| `_meta.disableBuiltInTools`  | Legacy shorthand for `claudeCode.options.tools = []`.                                                                             |
| `_meta.claudeCode.configDir` | Uses `<configDir>` as the invocation root, `<configDir>/.claude` as `CLAUDE_CONFIG_DIR`, and keeps `.claude.json` auth beside it. |
| `_meta.claudeCode.options`   | Forwards Claude SDK options after ACP applies its own transport, tool-permission, replay, executable, and env wiring.             |

## How Claude options are merged

The adapter is permissive about user-supplied Claude SDK options, but a few fields are always owned
by ACP because they define protocol behavior.

ACP-controlled fields:

- `cwd`
- `includePartialMessages`
- `permissionMode`
- `canUseTool`
- `allowDangerouslySkipPermissions`
- the Claude executable path and replay args

Merged fields:

- `hooks`: user hooks are preserved, and the adapter appends a `PostToolUse` hook that can switch
  the session into `plan` mode
- `mcpServers`: user-provided Claude SDK MCP servers and ACP session MCP servers are combined
- `disallowedTools`: user rules are preserved and ACP always adds `AskUserQuestion`

Tool exposure rules:

- default behavior uses Claude's `claude_code` preset
- `disableBuiltInTools: true` becomes `tools: []`
- an explicit `claudeCode.options.tools` value wins over `disableBuiltInTools`

Environment behavior:

- the adapter starts from `process.env`
- user-provided `claudeCode.options.env` overrides those values
- gateway-auth variables are layered in when gateway auth is active
- `CLAUDE_CONFIG_DIR` is always set from the resolved invocation paths

## Settings model

`SettingsManager` merges settings in this precedence order:

1. user settings
2. project settings
3. local settings
4. enterprise managed settings

Supported merged fields today:

- `permissions.defaultMode`
- `model`
- `env`

Permission modes accepted by the adapter:

- `default`
- `acceptEdits`
- `plan`
- `dontAsk`
- `bypassPermissions` when the process is not running as root

Aliases such as `AcceptEdits`, `DontAsk`, and `bypass` are normalized to canonical mode IDs.

Model selection uses Claude's available model list and can resolve fuzzy preferences from settings,
including forms like `opus[1m]`.

## Invocation-specific Claude state

Use `_meta.claudeCode.configDir` when you need Claude auth, memory, and local settings isolated per
tenant, user, or workspace:

```ts
await agent.newSession({
  cwd: "/workspace/acme-app",
  mcpServers: [],
  _meta: {
    claudeCode: {
      configDir: "/var/app-data/claude-users/alice/acme-app",
    },
  },
});
```

Resolved layout:

- invocation root: `/var/app-data/claude-users/alice/acme-app`
- Claude config dir: `/var/app-data/claude-users/alice/acme-app/.claude`
- auth file: `/var/app-data/claude-users/alice/acme-app/.claude.json`

If you need snapshot/restore semantics around that directory, use
`backupInvocationDirectory()` and `restoreInvocationDirectory()`.

## Auth behavior

The adapter can advertise two auth methods depending on client capabilities:

- terminal auth, which launches the bundled Claude CLI with `--cli`
- gateway auth, which maps `_meta.gateway.baseUrl` and `_meta.gateway.headers` into Anthropic
  environment variables

If the process is started with `--hide-claude-auth`, terminal auth is suppressed and only gateway
auth is advertised when the client declares that capability.

## Prompt and notification translation

Incoming ACP prompts are translated as follows:

- `text` stays text
- `resource_link` becomes an `@name`-style link in prompt text
- text `resource` blocks are attached as explicit `<context ...>` payloads
- base64 and URL images are forwarded to Claude
- unsupported blob and audio content is ignored

Outgoing Claude messages are translated into ACP session updates:

- assistant text and thinking stream as message chunks
- `TodoWrite` becomes ACP `plan` entries
- tool calls and tool results become `tool_call` and `tool_call_update`
- Bash tool calls emit terminal metadata when the client supports terminal output

For the exact session lifecycle and notification flow, see [ARCHITECTURE.md](./ARCHITECTURE.md).
