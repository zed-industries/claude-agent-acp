import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { minimatch } from "minimatch";
import { ACP_TOOL_NAME_PREFIX, acpToolNames } from "./tools.js";
import { CLAUDE_CONFIG_DIR } from "./acp-agent.js";

/**
 * Permission rule format examples:
 * - "Read" - matches all Read tool calls
 * - "Read(./.env)" - matches specific path
 * - "Read(./.env.*)" - glob pattern
 * - "Read(./secrets/**)" - recursive glob
 * - "Bash(npm run lint)" - exact command prefix
 * - "Bash(npm run:*)" - command prefix with wildcard
 *
 * Docs: https://code.claude.com/docs/en/iam#tool-specific-permission-rules
 */

export interface PermissionSettings {
  allow?: string[];
  deny?: string[];
  ask?: string[];
  additionalDirectories?: string[];
  defaultMode?: string;
}

export interface ClaudeCodeSettings {
  permissions?: PermissionSettings;
  env?: Record<string, string>;
  model?: string;
}

export type PermissionDecision = "allow" | "deny" | "ask";

export interface PermissionCheckResult {
  decision: PermissionDecision;
  rule?: string;
  source?: "allow" | "deny" | "ask";
}

interface ParsedRule {
  toolName: string;
  argument?: string;
  isWildcard?: boolean;
}

/**
 * Shell operators that can be used for command chaining/injection
 * These should cause a prefix match to fail to prevent bypasses like:
 * - "safe-cmd && malicious-cmd"
 * - "safe-cmd; malicious-cmd"
 * - "safe-cmd | malicious-cmd"
 * - "safe-cmd || malicious-cmd"
 * - "$(malicious-cmd)"
 * - "`malicious-cmd`"
 */
const SHELL_OPERATORS = ["&&", "||", ";", "|", "$(", "`", "\n"];

/**
 * Checks if a string contains shell operators that could allow command chaining
 */
function containsShellOperator(str: string): boolean {
  return SHELL_OPERATORS.some((op) => str.includes(op));
}

/*
 * Tools that modify files. Per Claude Code docs:
 * "Edit rules apply to all built-in tools that edit files."
 * This means an Edit(...) rule should match Write, MultiEdit, etc.
 */
const FILE_EDITING_TOOLS = [acpToolNames.edit, acpToolNames.write];

/**
 * Functions to extract the relevant argument from tool input for permission matching
 */
const TOOL_ARG_ACCESSORS: Record<string, (input: unknown) => string | undefined> = {
  mcp__acp__Read: (input) => (input as { file_path?: string })?.file_path,
  mcp__acp__Edit: (input) => (input as { file_path?: string })?.file_path,
  mcp__acp__Write: (input) => (input as { file_path?: string })?.file_path,
  mcp__acp__Bash: (input) => (input as { command?: string })?.command,
};

/**
 * Parses a permission rule string into its components
 * Examples:
 *   "Read" -> { toolName: "Read" }
 *   "Read(./.env)" -> { toolName: "Read", argument: "./.env" }
 *   "Bash(npm run:*)" -> { toolName: "Bash", argument: "npm run", isWildcard: true }
 */
function parseRule(rule: string): ParsedRule {
  const match = rule.match(/^(\w+)(?:\((.+)\))?$/);
  if (!match) {
    return { toolName: rule };
  }

  const [, toolName, argument] = match;

  if (argument && argument.endsWith(":*")) {
    return {
      toolName,
      argument: argument.slice(0, -2),
      isWildcard: true,
    };
  }

  return { toolName, argument };
}

/**
 * Normalizes a path for comparison:
 * - Expands ~ to home directory
 * - Resolves relative paths against cwd
 * - Normalizes path separators
 */
function normalizePath(filePath: string, cwd: string): string {
  if (filePath.startsWith("~/")) {
    filePath = path.join(os.homedir(), filePath.slice(2));
  } else if (filePath.startsWith("./")) {
    filePath = path.join(cwd, filePath.slice(2));
  } else if (!path.isAbsolute(filePath)) {
    filePath = path.join(cwd, filePath);
  }
  // Convert backslashes to forward slashes for minimatch compatibility on Windows
  return path.normalize(filePath).replace(/\\/g, "/");
}

/**
 * Checks if a file path matches a glob pattern
 */
function matchesGlob(pattern: string, filePath: string, cwd: string): boolean {
  const normalizedPattern = normalizePath(pattern, cwd);
  const normalizedPath = normalizePath(filePath, cwd);

  return minimatch(normalizedPath, normalizedPattern, {
    dot: true,
    matchBase: false,
    nocase: process.platform === "win32",
  });
}

/**
 * Checks if a tool invocation matches a parsed permission rule
 */
function matchesRule(rule: ParsedRule, toolName: string, toolInput: unknown, cwd: string): boolean {
  // Per Claude Code docs:
  // - "Edit rules apply to all built-in tools that edit files."
  // - "Claude will make a best-effort attempt to apply Read rules to all built-in tools
  //    that read files like Grep, Glob, and LS."
  const ruleAppliesToTool =
    (rule.toolName === "Bash" && toolName === acpToolNames.bash) ||
    (rule.toolName === "Edit" && FILE_EDITING_TOOLS.includes(toolName));

  if (!ruleAppliesToTool) {
    return false;
  }

  if (!rule.argument) {
    return true;
  }

  const argAccessor = TOOL_ARG_ACCESSORS[toolName];
  if (!argAccessor) {
    return true;
  }

  const actualArg = argAccessor(toolInput);
  if (!actualArg) {
    return false;
  }

  if (toolName === acpToolNames.bash) {
    // Per Claude Code docs: https://code.claude.com/docs/en/iam#tool-specific-permission-rules
    // - Bash(npm run build) matches the EXACT command "npm run build"
    // - Bash(npm run test:*) matches commands STARTING WITH "npm run test"
    // The :* suffix enables prefix matching, without it the match is exact
    //
    // Also from docs: "Claude Code is aware of shell operators (like &&) so a prefix match
    // rule like Bash(safe-cmd:*) won't give it permission to run the command safe-cmd && other-cmd"
    if (rule.isWildcard) {
      if (!actualArg.startsWith(rule.argument)) {
        return false;
      }
      // Check that the matched prefix isn't followed by shell operators that could
      // allow command chaining/injection
      const remainder = actualArg.slice(rule.argument.length);
      if (containsShellOperator(remainder)) {
        return false;
      }
      return true;
    }
    return actualArg === rule.argument;
  }

  // For file-based tools (Read, Edit, Write), use glob matching
  return matchesGlob(rule.argument, actualArg, cwd);
}

/**
 * Reads and parses a JSON settings file, returning an empty object if not found or invalid
 */
async function loadSettingsFile(filePath: string | null): Promise<ClaudeCodeSettings> {
  if (!filePath) {
    return {};
  }

  try {
    const content = await fs.promises.readFile(filePath, "utf-8");
    return JSON.parse(content) as ClaudeCodeSettings;
  } catch {
    return {};
  }
}

/**
 * Gets the enterprise settings path based on the current platform
 */
export function getManagedSettingsPath(): string {
  switch (process.platform) {
    case "darwin":
      return "/Library/Application Support/ClaudeCode/managed-settings.json";
    case "linux":
      return "/etc/claude-code/managed-settings.json";
    case "win32":
      return "C:\\Program Files\\ClaudeCode\\managed-settings.json";
    default:
      return "/etc/claude-code/managed-settings.json";
  }
}

export interface SettingsManagerOptions {
  onChange?: () => void;
  logger?: { log: (...args: any[]) => void; error: (...args: any[]) => void };
}

/**
 * Manages Claude Code settings from multiple sources with proper precedence.
 *
 * Settings are loaded from (in order of increasing precedence):
 * 1. User settings (~/.claude/settings.json)
 * 2. Project settings (<cwd>/.claude/settings.json)
 * 3. Local project settings (<cwd>/.claude/settings.local.json)
 * 4. Enterprise managed settings (platform-specific path)
 *
 * The manager watches all settings files for changes and automatically reloads.
 */
export class SettingsManager {
  private cwd: string;
  private userSettings: ClaudeCodeSettings = {};
  private projectSettings: ClaudeCodeSettings = {};
  private localSettings: ClaudeCodeSettings = {};
  private enterpriseSettings: ClaudeCodeSettings = {};
  private mergedSettings: ClaudeCodeSettings = {};
  private watchers: fs.FSWatcher[] = [];
  private onChange?: () => void;
  private logger: { log: (...args: any[]) => void; error: (...args: any[]) => void };
  private initialized = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(cwd: string, options?: SettingsManagerOptions) {
    this.cwd = cwd;
    this.onChange = options?.onChange;
    this.logger = options?.logger ?? console;
  }

  /**
   * Initialize the settings manager by loading all settings and setting up file watchers
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await this.loadAllSettings();
    this.setupWatchers();
    this.initialized = true;
  }

  /**
   * Returns the path to the user settings file
   */
  private getUserSettingsPath(): string {
    return path.join(CLAUDE_CONFIG_DIR, "settings.json");
  }

  /**
   * Returns the path to the project settings file
   */
  private getProjectSettingsPath(): string {
    return path.join(this.cwd, ".claude", "settings.json");
  }

  /**
   * Returns the path to the local project settings file
   */
  private getLocalSettingsPath(): string {
    return path.join(this.cwd, ".claude", "settings.local.json");
  }

  /**
   * Loads settings from all sources
   */
  private async loadAllSettings(): Promise<void> {
    const [userSettings, projectSettings, localSettings, enterpriseSettings] = await Promise.all([
      loadSettingsFile(this.getUserSettingsPath()),
      loadSettingsFile(this.getProjectSettingsPath()),
      loadSettingsFile(this.getLocalSettingsPath()),
      loadSettingsFile(getManagedSettingsPath()),
    ]);

    this.userSettings = userSettings;
    this.projectSettings = projectSettings;
    this.localSettings = localSettings;
    this.enterpriseSettings = enterpriseSettings;

    this.mergeSettings();
  }

  /**
   * Merges all settings sources with proper precedence.
   * For permissions, rules from all sources are combined.
   * Deny rules always take precedence during permission checks.
   */
  private mergeSettings(): void {
    const allSettings = [
      this.userSettings,
      this.projectSettings,
      this.localSettings,
      this.enterpriseSettings,
    ];

    const merged: ClaudeCodeSettings = {
      permissions: {
        allow: [],
        deny: [],
        ask: [],
      },
    };

    for (const settings of allSettings) {
      if (settings.permissions) {
        if (settings.permissions.allow) {
          merged.permissions!.allow!.push(...settings.permissions.allow);
        }
        if (settings.permissions.deny) {
          merged.permissions!.deny!.push(...settings.permissions.deny);
        }
        if (settings.permissions.ask) {
          merged.permissions!.ask!.push(...settings.permissions.ask);
        }
        if (settings.permissions.additionalDirectories) {
          merged.permissions!.additionalDirectories = [
            ...(merged.permissions!.additionalDirectories || []),
            ...settings.permissions.additionalDirectories,
          ];
        }
        if (settings.permissions.defaultMode) {
          merged.permissions!.defaultMode = settings.permissions.defaultMode;
        }
      }

      if (settings.env) {
        merged.env = { ...merged.env, ...settings.env };
      }

      if (settings.model) {
        merged.model = settings.model;
      }
    }

    this.mergedSettings = merged;
  }

  /**
   * Sets up file watchers for all settings files
   */
  private setupWatchers(): void {
    const paths = [
      this.getUserSettingsPath(),
      this.getProjectSettingsPath(),
      this.getLocalSettingsPath(),
      getManagedSettingsPath(),
    ];

    for (const filePath of paths) {
      if (!filePath) continue;

      try {
        const dir = path.dirname(filePath);
        const filename = path.basename(filePath);

        if (fs.existsSync(dir)) {
          const watcher = fs.watch(dir, (eventType, changedFilename) => {
            if (changedFilename === filename) {
              this.handleSettingsChange();
            }
          });

          watcher.on("error", (error) => {
            this.logger.error(`Settings watcher error for ${filePath}:`, error);
          });

          this.watchers.push(watcher);
        }
      } catch (error) {
        this.logger.error(`Failed to set up watcher for ${filePath}:`, error);
      }
    }
  }

  /**
   * Handles settings file changes with debouncing to avoid rapid reloads
   */
  private handleSettingsChange(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(async () => {
      this.debounceTimer = null;
      try {
        await this.loadAllSettings();
        this.onChange?.();
      } catch (error) {
        this.logger.error("Failed to reload settings:", error);
      }
    }, 100);
  }

  /**
   * Checks if a tool invocation is allowed based on the loaded settings.
   *
   * @param toolName - The tool name (can be ACP-prefixed like mcp__acp__Read or plain like Read)
   * @param toolInput - The tool input object
   * @returns The permission decision and matching rule info
   */
  checkPermission(toolName: string, toolInput: unknown): PermissionCheckResult {
    if (!toolName.startsWith(ACP_TOOL_NAME_PREFIX)) {
      return { decision: "ask" };
    }

    const permissions = this.mergedSettings.permissions;

    if (!permissions) {
      return { decision: "ask" };
    }

    // Check deny rules first (highest priority)
    for (const rule of permissions.deny || []) {
      const parsed = parseRule(rule);
      if (matchesRule(parsed, toolName, toolInput, this.cwd)) {
        return { decision: "deny", rule, source: "deny" };
      }
    }

    // Check allow rules
    for (const rule of permissions.allow || []) {
      const parsed = parseRule(rule);
      if (matchesRule(parsed, toolName, toolInput, this.cwd)) {
        return { decision: "allow", rule, source: "allow" };
      }
    }

    // Check ask rules
    for (const rule of permissions.ask || []) {
      const parsed = parseRule(rule);
      if (matchesRule(parsed, toolName, toolInput, this.cwd)) {
        return { decision: "ask", rule, source: "ask" };
      }
    }

    // No matching rule - default to ask
    return { decision: "ask" };
  }

  /**
   * Returns the current merged settings
   */
  getSettings(): ClaudeCodeSettings {
    return this.mergedSettings;
  }

  /**
   * Returns the current working directory
   */
  getCwd(): string {
    return this.cwd;
  }

  /**
   * Updates the working directory and reloads project-specific settings
   */
  async setCwd(cwd: string): Promise<void> {
    if (this.cwd === cwd) {
      return;
    }

    this.dispose();
    this.cwd = cwd;
    this.initialized = false;
    await this.initialize();
  }

  /**
   * Disposes of file watchers and cleans up resources
   */
  dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];
    this.initialized = false;
  }
}
