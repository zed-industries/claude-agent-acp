// Export the main agent class and utilities for library usage
export {
  ClaudeAcpAgent,
  runAcp,
  toAcpNotifications,
  streamEventToAcpNotifications,
  type ToolUpdateMeta,
  type NewSessionMeta,
} from "./acp-agent.js";
export {
  loadManagedSettings,
  applyEnvironmentSettings,
  nodeToWebReadable,
  nodeToWebWritable,
  Pushable,
  unreachable,
} from "./utils.js";
export { toolInfoFromToolUse, planEntries, toolUpdateFromToolResult, createPreToolUseHook, buildToolRedirectPrompt, toolRedirects } from "./tools.js";
export { createMcpServer, acpToolNames } from "./mcp-server.js";
export {
  SettingsManager,
  type ClaudeCodeSettings,
  type SettingsManagerOptions,
} from "./settings.js";

// Export types
export type { ClaudePlanEntry } from "./tools.js";
