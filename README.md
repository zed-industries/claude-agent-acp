# ACP adapter for the Claude Agent SDK

[![npm](https://img.shields.io/npm/v/%40agentclientprotocol%2Fclaude-agent-acp)](https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp)

Use [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview#branding-guidelines) from [ACP-compatible](https://agentclientprotocol.com) clients!

This tool implements an ACP agent by using the official [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview), supporting:

- Context @-mentions
- Images
- Tool calls (with permission requests)
- Following
- Edit review
- TODO lists
- Interactive (and background) terminals
- Custom [Slash commands](https://docs.anthropic.com/en/docs/claude-code/slash-commands)
- Client MCP servers

Learn more about the [Agent Client Protocol](https://agentclientprotocol.com/).

## Environment Variables

### `CLAUDE_CODE_EXECUTABLE`

Override the Claude Code executable used by the ACP agent. By default, the agent uses the CLI bundled with `@anthropic-ai/claude-agent-sdk`. Set this variable to point to a custom Claude Code installation.

When set without `CLAUDE_CODE_CUSTOM_AUTH`, the agent still uses the standard ACP authentication flow (Claude Subscription / Anthropic Console / Gateway).

### `CLAUDE_CODE_CUSTOM_AUTH`

Enable wrapper mode for use with Claude Code wrappers that handle authentication internally (e.g. enterprise SSO, API gateway). When enabled:

- All ACP-level authentication prompts are skipped
- The wrapper is expected to provide its own authentication

**Requires `CLAUDE_CODE_EXECUTABLE` to be set.** The agent will throw an error on startup if `CLAUDE_CODE_CUSTOM_AUTH` is set without `CLAUDE_CODE_EXECUTABLE`.

## Contribution Policy

This project does not require a Contributor License Agreement (CLA). Instead, contributions are accepted under the following terms:

> By contributing to this project, you agree that your contributions will be licensed under the [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0). You affirm that you have the legal right to submit your work, that you are not including code you do not have rights to, and that you understand contributions are made without requiring a Contributor License Agreement (CLA).
