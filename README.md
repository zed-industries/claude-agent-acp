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

## Fork Status

This repository is a personal fork of `zed-industries/claude-agent-acp`.

Its purpose is to keep a working branch with features that are not fully available in upstream yet. In particular, this fork documents and carries:

- support for `fast mode` session configuration
- the `effort levels` work derived from Ben Brandt's `Support effort levels` change (`b578b41`)
- the integration work needed to keep both behaviors together in the current fork

## What This Fork Adds

Compared to upstream `main`, this fork is intended to expose additional session configuration controls for ACP clients.

Current fork-specific focus:

- `fast_mode` support in session config options
- synchronization of fast mode state with SDK responses
- tests covering `fast_mode` behavior and model-switch interactions

## Upstream Dependency

This fork depends on upstream work that is not described in the original README.

The `effort levels` behavior included here is derived from Ben Brandt's work on the `support-effort-levels` branch, introduced by the commit:

- `b578b41` - `Support effort levels`

In practice, this means the fork is not only a generic mirror of upstream: it also bundles that derived work from Ben and layers the `fast mode` changes on top.

If upstream merges the corresponding PR or equivalent functionality, this fork can be simplified or brought back closer to upstream.

## Contribution Policy

This project does not require a Contributor License Agreement (CLA). Instead, contributions are accepted under the following terms:

> By contributing to this project, you agree that your contributions will be licensed under the [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0). You affirm that you have the legal right to submit your work, that you are not including code you do not have rights to, and that you understand contributions are made without requiring a Contributor License Agreement (CLA).
