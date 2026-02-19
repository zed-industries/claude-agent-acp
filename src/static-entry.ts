#!/usr/bin/env node

if (process.argv.includes("--acp")) {
  process.argv = process.argv.filter((arg) => arg !== "--acp");
  await import("./index.js");
} else {
  // Default: run as Claude Code CLI (used by the SDK for sub-agents, terminal auth, etc.)
  // @ts-expect-error -- needed for the static binary
  await import("@anthropic-ai/claude-agent-sdk/cli.js");
}
