// Export the main agent class and utilities for library usage
export {
  ClaudeAcpAgent,
  runAcp,
  toAcpNotifications,
  streamEventToAcpNotifications,
  type ClaudeAcpAgentOptions,
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
export {
  backupInvocationDirectory,
  defaultClaudeConfigDir,
  resolveClaudeInvocationPaths,
  restoreInvocationDirectory,
  type ClaudeInvocationPaths,
} from "./claude-config.js";
export {
  toolInfoFromToolUse,
  toDisplayPath,
  planEntries,
  toolUpdateFromToolResult,
} from "./tools.js";
export {
  SettingsManager,
  type ClaudeCodeSettings,
  type SettingsManagerOptions,
} from "./settings.js";

// Export types
export type { ClaudePlanEntry } from "./tools.js";
