# ACP adapter for the Claude Agent SDK

[![npm](https://img.shields.io/npm/v/%40agentclientprotocol%2Fclaude-agent-acp)](https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp)

Use [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview#branding-guidelines) from [ACP-compatible](https://agentclientprotocol.com) clients!

This package exposes Claude Code as an ACP agent and adds the adapter behavior ACP clients
expect:

- prompt queueing per session
- ACP session config options for mode and model
- permission mediation for Claude tools
- invocation-specific Claude auth, memory, and settings directories
- merged MCP server, hook, tool, and disallowed-tool configuration
- prompt translation for text, resources, and images
- tool-call notifications, including terminal metadata for `Bash`

Learn more about the [Agent Client Protocol](https://agentclientprotocol.com/).

## Contribution Policy

This project does not require a Contributor License Agreement (CLA). Instead, contributions are accepted under the following terms:

> By contributing to this project, you agree that your contributions will be licensed under the [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0). You affirm that you have the legal right to submit your work, that you are not including code you do not have rights to, and that you understand contributions are made without requiring a Contributor License Agreement (CLA).
