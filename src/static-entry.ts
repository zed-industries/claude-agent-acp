if (process.argv.includes("--cli")) {
  process.argv = process.argv.filter((arg) => arg !== "--cli");
  // @ts-expect-error -- no types
  await import("@anthropic-ai/claude-agent-sdk/cli.js");
} else {
  await import("./index.js");
}
