# ACP adapter for the Claude Agent SDK

[![npm](https://img.shields.io/npm/v/%40zed-industries%2Fclaude-agent-acp)](https://www.npmjs.com/package/@zed-industries/claude-agent-acp)

Use [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview#branding-guidelines) from [ACP-compatible](https://agentclientprotocol.com) clients such as [Zed](https://zed.dev)!

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

## How to use

### Zed

The latest version of Zed can already use this adapter out of the box.

To use Claude Agent, open the Agent Panel and click "New Claude Agent Thread" from the `+` button menu in the top-right:

https://github.com/user-attachments/assets/ddce66c7-79ac-47a3-ad59-4a6a3ca74903

Read the docs on [External Agent](https://zed.dev/docs/ai/external-agents) support.

### Other clients

Or try it with any of the other [ACP compatible clients](https://agentclientprotocol.com/overview/clients)!

#### Installation

Install the adapter from `npm`:

```bash
npm install -g @zed-industries/claude-agent-acp
```

You can then use `claude-agent-acp` as a regular ACP agent:

```
ANTHROPIC_API_KEY=sk-... claude-agent-acp
```

#### Homebrew

Claude Agent is also available via Homebrew:

`brew install claude-agent-acp`

#### Single-file executable

Pre-built single-file binaries are available on the [Releases](https://github.com/zed-industries/claude-agent-acp/releases) page for Linux, macOS, and Windows.
These binaries bundle everything needed and don't require Node.js.

## License

Apache-2.0
