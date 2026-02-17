import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "child_process";

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)(
  "TypeScript declaration files integration",
  () => {
    let tempDir: string;
    let tarballPath: string;
    const projectRoot = path.resolve(__dirname, "../..");

    // Base configuration templates
    const basePackageJson = {
      name: "ts-declaration-test",
      version: "1.0.0",
      type: "module",
      dependencies: {},
      devDependencies: {
        typescript: "5.9.3",
        "@types/node": "25.0.3",
      },
    };

    const baseTsConfig = {
      compilerOptions: {
        target: "ES2020",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        lib: ["ES2020"],
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true, // Skip checking dependency internals, focus on our types
        noEmit: true,
        declaration: false,
      },
      include: ["*.ts"],
    };

    // Build and pack the package once for all tests
    beforeAll(async () => {
      // Step 1: Clean dist folder to ensure fresh build
      const distPath = path.join(projectRoot, "dist");
      await fs.promises.rm(distPath, { recursive: true, force: true });
      console.log("Cleaned dist folder");

      console.log("Building package...");

      // Step 2: Build the package
      const buildResult = spawnSync("npm", ["run", "build"], {
        cwd: projectRoot,
        stdio: "pipe",
        encoding: "utf-8",
      });

      if (buildResult.status !== 0) {
        throw new Error(`Build failed: ${buildResult.stderr || buildResult.stdout}`);
      }

      console.log("Packing package...");

      // Step 3: Pack to create tarball
      const packResult = spawnSync("npm", ["pack", "--pack-destination", os.tmpdir()], {
        cwd: projectRoot,
        stdio: "pipe",
        encoding: "utf-8",
      });

      if (packResult.status !== 0) {
        throw new Error(`Pack failed: ${packResult.stderr || packResult.stdout}`);
      }

      // Get the tarball filename from stdout (npm pack outputs the filename)
      const tarballName = packResult.stdout.trim().split("\n").pop();
      if (!tarballName) {
        throw new Error("Failed to get tarball name from npm pack output");
      }
      tarballPath = path.join(os.tmpdir(), tarballName);

      console.log(`Tarball created at: ${tarballPath}`);
    }, 60000); // 60 second timeout for build

    // Clean up the tarball after all tests
    afterAll(async () => {
      if (tarballPath && fs.existsSync(tarballPath)) {
        await fs.promises.unlink(tarballPath);
        console.log("Cleaned up tarball");
      }
    });

    // Create fresh temp directory for each test
    beforeEach(async () => {
      tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ts-declaration-test-"));
    });

    // Clean up temp directory after each test
    afterEach(async () => {
      if (tempDir) {
        await fs.promises.rm(tempDir, { recursive: true, force: true });
      }
    });

    // Helper function to set up a test TypeScript project
    async function setupTestProject(
      packageJson: object = basePackageJson,
      tsconfig: object = baseTsConfig,
    ): Promise<void> {
      // Write package.json
      await fs.promises.writeFile(
        path.join(tempDir, "package.json"),
        JSON.stringify(packageJson, null, 2),
      );

      // Write tsconfig.json
      await fs.promises.writeFile(
        path.join(tempDir, "tsconfig.json"),
        JSON.stringify(tsconfig, null, 2),
      );

      // Install all dependencies (TypeScript, @types/node, and the tarball)
      console.log(`Installing dependencies in ${tempDir}...`);
      const installResult = spawnSync("npm", ["install", tarballPath], {
        cwd: tempDir,
        stdio: "pipe",
        encoding: "utf-8",
        timeout: 60000, // 60 second timeout
      });

      if (installResult.status !== 0) {
        throw new Error(`npm install failed: ${installResult.stderr || installResult.stdout}`);
      }
    }

    // Helper function to run TypeScript type checking
    function runTypeCheck(srcDir: string = tempDir): {
      success: boolean;
      output: string;
    } {
      const result = spawnSync("npx", ["tsc", "--noEmit"], {
        cwd: srcDir,
        stdio: "pipe",
        encoding: "utf-8",
        timeout: 30000, // 30 second timeout
      });

      return {
        success: result.status === 0,
        output: result.stdout + result.stderr,
      };
    }

    // Helper function to write a test TypeScript file
    async function writeTestFile(filename: string, content: string): Promise<void> {
      await fs.promises.writeFile(path.join(tempDir, filename), content);
    }

    // Test 1: Main exports import verification
    it("should successfully type-check main exports", async () => {
      await setupTestProject();

      await writeTestFile(
        "test-main-exports.ts",
        `
import {
  ClaudeAcpAgent,
  runAcp,
  toAcpNotifications,
  streamEventToAcpNotifications,
  SettingsManager,
  createMcpServer,
  loadManagedSettings,
  applyEnvironmentSettings,
  nodeToWebReadable,
  nodeToWebWritable,
  Pushable,
  unreachable,
  toolInfoFromToolUse,
  planEntries,
  toolUpdateFromToolResult,
  createPreToolUseHook,
  toolNames,
} from "@zed-industries/claude-agent-acp";

// Type-only imports
import type {
  ToolUpdateMeta,
  NewSessionMeta,
  ClaudeCodeSettings,
  PermissionSettings,
  PermissionDecision,
  PermissionCheckResult,
  SettingsManagerOptions,
  ClaudePlanEntry,
} from "@zed-industries/claude-agent-acp";

// Verify exports exist and have expected types
const _runAcp: typeof runAcp = runAcp;
const _createMcpServer: typeof createMcpServer = createMcpServer;
const _toolNames: typeof toolNames = toolNames;
`,
      );

      const result = runTypeCheck();
      if (!result.success) {
        console.error("TypeScript errors:", result.output);
      }
      expect(result.success).toBe(true);
    }, 120000);

    // Test 2: Deep imports verification (backwards compatibility)
    it("should successfully type-check deep imports", async () => {
      await setupTestProject();

      await writeTestFile(
        "test-deep-imports.ts",
        `
// Deep import from dist/tools.js
import {
  acpToolNames,
  EDIT_TOOL_NAMES,
  ACP_TOOL_NAME_PREFIX,
  toolInfoFromToolUse,
  planEntries,
} from "@zed-industries/claude-agent-acp/dist/tools.js";

// Deep import from dist/settings.js
import {
  SettingsManager,
  getManagedSettingsPath,
} from "@zed-industries/claude-agent-acp/dist/settings.js";

// Deep import from dist/utils.js
import {
  Pushable,
  nodeToWebReadable,
  nodeToWebWritable,
  loadManagedSettings,
} from "@zed-industries/claude-agent-acp/dist/utils.js";

// Verify types work
const prefix: string = ACP_TOOL_NAME_PREFIX;
const editTools: readonly string[] = EDIT_TOOL_NAMES;
`,
      );

      const result = runTypeCheck();
      if (!result.success) {
        console.error("TypeScript errors:", result.output);
      }
      expect(result.success).toBe(true);
    }, 120000);

    // Test 3: SettingsManager type shape verification
    it("should verify SettingsManager has correct type shape", async () => {
      await setupTestProject();

      await writeTestFile(
        "test-settings-manager.ts",
        `
import {
  SettingsManager,
  ClaudeCodeSettings,
  PermissionCheckResult,
  SettingsManagerOptions
} from "@zed-industries/claude-agent-acp";

// Test constructor signature
const options: SettingsManagerOptions = {
  onChange: () => {},
  logger: { log: console.log, error: console.error },
};
declare const cwd: string;
const manager = new SettingsManager(cwd, options);

// Test method signatures
async function testMethods() {
  // initialize returns Promise<void>
  await manager.initialize();

  // checkPermission returns PermissionCheckResult
  const result: PermissionCheckResult = manager.checkPermission(
    "mcp__acp__Read",
    { file_path: "/some/path" }
  );

  // Verify decision type
  const decision: "allow" | "deny" | "ask" = result.decision;
  const rule: string | undefined = result.rule;
  const source: "allow" | "deny" | "ask" | undefined = result.source;

  // getSettings returns ClaudeCodeSettings
  const settings: ClaudeCodeSettings = manager.getSettings();

  // getCwd returns string
  const currentCwd: string = manager.getCwd();

  // setCwd returns Promise<void>
  await manager.setCwd("/new/path");

  // dispose returns void
  manager.dispose();
}
`,
      );

      const result = runTypeCheck();
      if (!result.success) {
        console.error("TypeScript errors:", result.output);
      }
      expect(result.success).toBe(true);
    }, 120000);

    // Test 4: ClaudeAcpAgent instantiation and type verification
    it("should verify ClaudeAcpAgent has correct type shape", async () => {
      await setupTestProject();

      await writeTestFile(
        "test-claude-acp-agent.ts",
        `
import { ClaudeAcpAgent } from "@zed-industries/claude-agent-acp";
import type { AgentSideConnection } from "@agentclientprotocol/sdk";

// ClaudeAcpAgent should be a class that can be instantiated
declare const mockConnection: AgentSideConnection;
declare const mockLogger: { log: (...args: any[]) => void; error: (...args: any[]) => void };

// Test constructor - accepts AgentSideConnection and optional logger
const agent = new ClaudeAcpAgent(mockConnection, mockLogger);

// Verify it has sessions property
const sessions: Record<string, any> = agent.sessions;

// Verify it has client property
const client: AgentSideConnection = agent.client;

// Verify it has logger property
const logger = agent.logger;
`,
      );

      const result = runTypeCheck();
      if (!result.success) {
        console.error("TypeScript errors:", result.output);
      }
      expect(result.success).toBe(true);
    }, 120000);

    // Test 5: Type-only exports work correctly
    it("should verify type-only exports are usable", async () => {
      await setupTestProject();

      await writeTestFile(
        "test-type-exports.ts",
        `
import type {
  ClaudeCodeSettings,
  PermissionSettings,
  PermissionDecision,
  PermissionCheckResult,
  SettingsManagerOptions,
  ClaudePlanEntry,
  ToolUpdateMeta,
  NewSessionMeta,
} from "@zed-industries/claude-agent-acp";

// Test ClaudeCodeSettings shape
const settings: ClaudeCodeSettings = {
  permissions: {
    allow: ["Read"],
    deny: ["Read(./.env)"],
    ask: ["Bash"],
    additionalDirectories: ["/extra"],
    defaultMode: "default",
  },
  env: {
    API_KEY: "secret",
  },
};

// Test PermissionSettings shape
const perms: PermissionSettings = {
  allow: ["Read"],
  deny: ["Write"],
};

// Test PermissionDecision
const decisions: PermissionDecision[] = ["allow", "deny", "ask"];

// Test ClaudePlanEntry shape
const planEntry: ClaudePlanEntry = {
  content: "Do something",
  status: "pending",
  activeForm: "Doing something",
};

// Test valid status values
const validStatuses: ClaudePlanEntry["status"][] = [
  "pending",
  "in_progress",
  "completed",
];

// Test ToolUpdateMeta shape
const toolMeta: ToolUpdateMeta = {
  claudeCode: {
    toolName: "Read",
    toolResponse: { success: true },
  },
};

// Test NewSessionMeta shape
const sessionMeta: NewSessionMeta = {
  claudeCode: {
    options: {},
  },
};
`,
      );

      const result = runTypeCheck();
      if (!result.success) {
        console.error("TypeScript errors:", result.output);
      }
      expect(result.success).toBe(true);
    }, 120000);

    // Test 6: Function signatures verification
    it("should verify function signatures are correct", async () => {
      await setupTestProject();

      await writeTestFile(
        "test-function-signatures.ts",
        `
import {
  runAcp,
  createMcpServer,
  toolInfoFromToolUse,
  planEntries,
  createPreToolUseHook,
  loadManagedSettings,
  applyEnvironmentSettings,
  SettingsManager,
} from "@zed-industries/claude-agent-acp";

import type { ClaudeCodeSettings } from "@zed-industries/claude-agent-acp";

// runAcp should be a function with no parameters that returns void
const runAcpType: () => void = runAcp;

// toolInfoFromToolUse should accept any and return object with title and kind
const info = toolInfoFromToolUse({ name: "Read", input: {} });
const title: string = info.title;
const kind: string = info.kind;

// planEntries should accept todos array and return array
const entries = planEntries({
  todos: [
    { content: "test", status: "pending", activeForm: "testing" }
  ]
});
// entries should be an array
const entriesArray: any[] = entries;

// createPreToolUseHook should accept SettingsManager and optional logger
declare const settingsManager: SettingsManager;
const hook = createPreToolUseHook(settingsManager, console);

// loadManagedSettings should return ClaudeCodeSettings | null
const managedSettings: ClaudeCodeSettings | null = loadManagedSettings();

// applyEnvironmentSettings should accept ClaudeCodeSettings and return void
const applyResult: void = applyEnvironmentSettings({ permissions: {} });
`,
      );

      const result = runTypeCheck();
      if (!result.success) {
        console.error("TypeScript errors:", result.output);
      }
      expect(result.success).toBe(true);
    }, 120000);

    // Test 7: Pushable generic class verification
    it("should verify Pushable class works correctly", async () => {
      await setupTestProject();

      await writeTestFile(
        "test-pushable.ts",
        `
import { Pushable } from "@zed-industries/claude-agent-acp";

// Pushable should be a generic class
const pushable = new Pushable<string>();

// Should have push method
pushable.push("test");

// Should have end method
pushable.end();

// Should implement AsyncIterable
async function consume() {
  for await (const item of pushable) {
    const str: string = item;
  }
}

// Generic type parameter should work
const numPushable = new Pushable<number>();
numPushable.push(42);

interface MyType { id: number; name: string; }
const customPushable = new Pushable<MyType>();
customPushable.push({ id: 1, name: "test" });
`,
      );

      const result = runTypeCheck();
      if (!result.success) {
        console.error("TypeScript errors:", result.output);
      }
      expect(result.success).toBe(true);
    }, 120000);

    // Test 8: Verify incorrect types fail
    it("should fail type-check with incorrect types", async () => {
      await setupTestProject();

      await writeTestFile(
        "test-invalid-types.ts",
        `
import { SettingsManager, ClaudeCodeSettings } from "@zed-industries/claude-agent-acp";

// This should fail - SettingsManager constructor requires string cwd
// @ts-expect-error - Testing that wrong argument type fails
const badManager = new SettingsManager(123);

// This should fail - ClaudeCodeSettings permissions must be an object
const badSettings: ClaudeCodeSettings = {
  // @ts-expect-error - Testing that wrong type fails
  permissions: "not-an-object",
};
`,
      );

      // This test should PASS because we expect tsc to catch these errors
      // with @ts-expect-error directives
      const result = runTypeCheck();
      if (!result.success) {
        // If it fails, it means @ts-expect-error didn't catch the error
        // which could mean the types are too permissive
        console.error("TypeScript errors (expected @ts-expect-error to catch):", result.output);
      }
      expect(result.success).toBe(true);
    }, 120000);
  },
);
