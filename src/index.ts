#!/usr/bin/env node

// Load managed settings and apply environment variables
import { loadManagedSettings, applyEnvironmentSettings } from "./utils.js";
import { claudeCliPath, runAcp } from "./acp-agent.js";

if (process.argv.includes("--cli")) {
  process.argv = process.argv.filter((arg) => arg !== "--cli");
  await import(await claudeCliPath());
} else {
  const managedSettings = loadManagedSettings();
  if (managedSettings) {
    applyEnvironmentSettings(managedSettings);
  }

  // stdout is used to send messages to the client
  // we redirect everything else to stderr to make sure it doesn't interfere with ACP
  console.log = console.error;
  console.info = console.error;
  console.warn = console.error;
  console.debug = console.error;

  process.on("unhandledRejection", (reason, promise) => {
    console.error("Unhandled Rejection at:", promise, "reason:", reason);
  });

  const { connection, agent } = runAcp();

  async function shutdown() {
    await agent.dispose().catch((err) => {
      console.error("Error during cleanup:", err);
    });
    process.exit(0);
  }

  // Exit cleanly when the ACP connection closes (e.g. stdin EOF, transport
  // error). Without this, `process.stdin.resume()` keeps the event loop
  // alive indefinitely, causing orphan process accumulation in oneshot mode.
  connection.closed.then(shutdown);

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Keep process alive while connection is open
  process.stdin.resume();
}
