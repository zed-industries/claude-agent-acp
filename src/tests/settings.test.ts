import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SettingsManager } from "../settings.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe.skip("SettingsManager", () => {
  let tempDir: string;
  let settingsManager: SettingsManager;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "settings-test-"));
  });

  afterEach(async () => {
    settingsManager?.dispose();
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  describe.skip("permission checking", () => {
    it("should return 'ask' when no settings exist", async () => {
      settingsManager = new SettingsManager(tempDir);
      await settingsManager.initialize();

      const result = settingsManager.checkPermission("mcp__acp__Read", {
        file_path: "/some/file.txt",
      });
      expect(result.decision).toBe("ask");
    });

    it("should return 'ask' for non-ACP tools (permission checks only apply to mcp__acp__* tools)", async () => {
      const claudeDir = path.join(tempDir, ".claude");
      await fs.promises.mkdir(claudeDir, { recursive: true });
      await fs.promises.writeFile(
        path.join(claudeDir, "settings.json"),
        JSON.stringify({
          permissions: {
            deny: ["Read"],
          },
        }),
      );

      settingsManager = new SettingsManager(tempDir);
      await settingsManager.initialize();

      // Non-ACP tools should always return 'ask' regardless of rules
      const result = settingsManager.checkPermission("Read", { file_path: "/some/file.txt" });
      expect(result.decision).toBe("ask");
    });

    it("should allow tool use when matching allow rule exists", async () => {
      const claudeDir = path.join(tempDir, ".claude");
      await fs.promises.mkdir(claudeDir, { recursive: true });
      await fs.promises.writeFile(
        path.join(claudeDir, "settings.json"),
        JSON.stringify({
          permissions: {
            allow: ["Read"],
          },
        }),
      );

      settingsManager = new SettingsManager(tempDir);
      await settingsManager.initialize();

      const result = settingsManager.checkPermission("mcp__acp__Read", {
        file_path: "/some/file.txt",
      });
      expect(result.decision).toBe("allow");
      expect(result.rule).toBe("Read");
    });

    it("should deny tool use when matching deny rule exists", async () => {
      const claudeDir = path.join(tempDir, ".claude");
      await fs.promises.mkdir(claudeDir, { recursive: true });
      await fs.promises.writeFile(
        path.join(claudeDir, "settings.json"),
        JSON.stringify({
          permissions: {
            deny: ["Read(./.env)"],
          },
        }),
      );

      settingsManager = new SettingsManager(tempDir);
      await settingsManager.initialize();

      const result = settingsManager.checkPermission("mcp__acp__Read", {
        file_path: path.join(tempDir, ".env"),
      });
      expect(result.decision).toBe("deny");
      expect(result.rule).toBe("Read(./.env)");
    });

    it("should prioritize deny rules over allow rules", async () => {
      const claudeDir = path.join(tempDir, ".claude");
      await fs.promises.mkdir(claudeDir, { recursive: true });
      await fs.promises.writeFile(
        path.join(claudeDir, "settings.json"),
        JSON.stringify({
          permissions: {
            allow: ["Read"],
            deny: ["Read(./.env)"],
          },
        }),
      );

      settingsManager = new SettingsManager(tempDir);
      await settingsManager.initialize();

      // .env should be denied
      const envResult = settingsManager.checkPermission("mcp__acp__Read", {
        file_path: path.join(tempDir, ".env"),
      });
      expect(envResult.decision).toBe("deny");

      // other files should be allowed
      const otherResult = settingsManager.checkPermission("mcp__acp__Read", {
        file_path: path.join(tempDir, "other.txt"),
      });
      expect(otherResult.decision).toBe("allow");
    });

    it("should handle ACP-prefixed tool names", async () => {
      const claudeDir = path.join(tempDir, ".claude");
      await fs.promises.mkdir(claudeDir, { recursive: true });
      await fs.promises.writeFile(
        path.join(claudeDir, "settings.json"),
        JSON.stringify({
          permissions: {
            allow: ["Read"],
          },
        }),
      );

      settingsManager = new SettingsManager(tempDir);
      await settingsManager.initialize();

      const result = settingsManager.checkPermission("mcp__acp__Read", {
        file_path: "/some/file.txt",
      });
      expect(result.decision).toBe("allow");
    });
  });

  describe("Bash permission rules", () => {
    it("should match exact Bash commands without :* wildcard", async () => {
      const claudeDir = path.join(tempDir, ".claude");
      await fs.promises.mkdir(claudeDir, { recursive: true });
      await fs.promises.writeFile(
        path.join(claudeDir, "settings.json"),
        JSON.stringify({
          permissions: {
            // Per docs: Bash(npm run build) matches the EXACT command "npm run build"
            allow: ["Bash(npm run lint)"],
          },
        }),
      );

      settingsManager = new SettingsManager(tempDir);
      await settingsManager.initialize();

      // Exact match should be allowed
      const exactResult = settingsManager.checkPermission("mcp__acp__Bash", {
        command: "npm run lint",
      });
      expect(exactResult.decision).toBe("allow");

      // Command with extra arguments should NOT match (exact match only)
      const withArgsResult = settingsManager.checkPermission("mcp__acp__Bash", {
        command: "npm run lint --fix",
      });
      expect(withArgsResult.decision).toBe("ask");

      // Similar command should NOT match (exact match only)
      const similarResult = settingsManager.checkPermission("mcp__acp__Bash", {
        command: "npm run linting",
      });
      expect(similarResult.decision).toBe("ask");

      // Different command should not match
      const differentResult = settingsManager.checkPermission("mcp__acp__Bash", {
        command: "npm run test",
      });
      expect(differentResult.decision).toBe("ask");
    });

    it("should match Bash commands with :* wildcard suffix (prefix matching)", async () => {
      const claudeDir = path.join(tempDir, ".claude");
      await fs.promises.mkdir(claudeDir, { recursive: true });
      await fs.promises.writeFile(
        path.join(claudeDir, "settings.json"),
        JSON.stringify({
          permissions: {
            // The :* suffix is a convention to make prefix matching explicit
            allow: ["Bash(npm run:*)"],
          },
        }),
      );

      settingsManager = new SettingsManager(tempDir);
      await settingsManager.initialize();

      // Any command starting with "npm run" should match (prefix matching with :*)
      const lintResult = settingsManager.checkPermission("mcp__acp__Bash", {
        command: "npm run lint",
      });
      expect(lintResult.decision).toBe("allow");

      const testResult = settingsManager.checkPermission("mcp__acp__Bash", {
        command: "npm run test",
      });
      expect(testResult.decision).toBe("allow");

      // Commands with additional args also match
      const withArgsResult = settingsManager.checkPermission("mcp__acp__Bash", {
        command: "npm run test --watch",
      });
      expect(withArgsResult.decision).toBe("allow");

      // Non-matching command
      const installResult = settingsManager.checkPermission("mcp__acp__Bash", {
        command: "npm install",
      });
      expect(installResult.decision).toBe("ask");
    });

    it("should not allow shell operators to bypass prefix matching", async () => {
      const claudeDir = path.join(tempDir, ".claude");
      await fs.promises.mkdir(claudeDir, { recursive: true });
      await fs.promises.writeFile(
        path.join(claudeDir, "settings.json"),
        JSON.stringify({
          permissions: {
            allow: ["Bash(safe-cmd:*)"],
          },
        }),
      );

      settingsManager = new SettingsManager(tempDir);
      await settingsManager.initialize();

      // Normal prefix match should work
      const normalResult = settingsManager.checkPermission("mcp__acp__Bash", {
        command: "safe-cmd --flag",
      });
      expect(normalResult.decision).toBe("allow");

      // Shell operators should NOT be allowed (per docs: Claude Code is aware of shell operators)
      const andResult = settingsManager.checkPermission("mcp__acp__Bash", {
        command: "safe-cmd && malicious-cmd",
      });
      expect(andResult.decision).toBe("ask");

      const orResult = settingsManager.checkPermission("mcp__acp__Bash", {
        command: "safe-cmd || malicious-cmd",
      });
      expect(orResult.decision).toBe("ask");

      const semicolonResult = settingsManager.checkPermission("mcp__acp__Bash", {
        command: "safe-cmd; malicious-cmd",
      });
      expect(semicolonResult.decision).toBe("ask");

      const pipeResult = settingsManager.checkPermission("mcp__acp__Bash", {
        command: "safe-cmd | malicious-cmd",
      });
      expect(pipeResult.decision).toBe("ask");

      const subshellResult = settingsManager.checkPermission("mcp__acp__Bash", {
        command: "safe-cmd $(malicious-cmd)",
      });
      expect(subshellResult.decision).toBe("ask");

      const backtickResult = settingsManager.checkPermission("mcp__acp__Bash", {
        command: "safe-cmd `malicious-cmd`",
      });
      expect(backtickResult.decision).toBe("ask");

      const newlineResult = settingsManager.checkPermission("mcp__acp__Bash", {
        command: "safe-cmd\nmalicious-cmd",
      });
      expect(newlineResult.decision).toBe("ask");
    });

    it("should deny dangerous Bash commands", async () => {
      const claudeDir = path.join(tempDir, ".claude");
      await fs.promises.mkdir(claudeDir, { recursive: true });
      await fs.promises.writeFile(
        path.join(claudeDir, "settings.json"),
        JSON.stringify({
          permissions: {
            deny: ["Bash(curl:*)", "Bash(wget:*)"],
          },
        }),
      );

      settingsManager = new SettingsManager(tempDir);
      await settingsManager.initialize();

      const curlResult = settingsManager.checkPermission("mcp__acp__Bash", {
        command: "curl https://example.com",
      });
      expect(curlResult.decision).toBe("deny");

      const wgetResult = settingsManager.checkPermission("mcp__acp__Bash", {
        command: "wget https://example.com",
      });
      expect(wgetResult.decision).toBe("deny");

      const lsResult = settingsManager.checkPermission("mcp__acp__Bash", { command: "ls -la" });
      expect(lsResult.decision).toBe("ask");
    });
  });

  describe("file path glob matching", () => {
    it("should match exact file paths", async () => {
      const claudeDir = path.join(tempDir, ".claude");
      await fs.promises.mkdir(claudeDir, { recursive: true });
      await fs.promises.writeFile(
        path.join(claudeDir, "settings.json"),
        JSON.stringify({
          permissions: {
            deny: ["Read(./.env)"],
          },
        }),
      );

      settingsManager = new SettingsManager(tempDir);
      await settingsManager.initialize();

      const envResult = settingsManager.checkPermission("mcp__acp__Read", {
        file_path: path.join(tempDir, ".env"),
      });
      expect(envResult.decision).toBe("deny");

      const otherResult = settingsManager.checkPermission("mcp__acp__Read", {
        file_path: path.join(tempDir, ".envrc"),
      });
      expect(otherResult.decision).toBe("ask");
    });

    it("should match glob patterns with single wildcard", async () => {
      const claudeDir = path.join(tempDir, ".claude");
      await fs.promises.mkdir(claudeDir, { recursive: true });
      await fs.promises.writeFile(
        path.join(claudeDir, "settings.json"),
        JSON.stringify({
          permissions: {
            deny: ["Read(./.env.*)"],
          },
        }),
      );

      settingsManager = new SettingsManager(tempDir);
      await settingsManager.initialize();

      const envLocalResult = settingsManager.checkPermission("mcp__acp__Read", {
        file_path: path.join(tempDir, ".env.local"),
      });
      expect(envLocalResult.decision).toBe("deny");

      const envProdResult = settingsManager.checkPermission("mcp__acp__Read", {
        file_path: path.join(tempDir, ".env.production"),
      });
      expect(envProdResult.decision).toBe("deny");

      // Plain .env should not match .env.*
      const plainEnvResult = settingsManager.checkPermission("mcp__acp__Read", {
        file_path: path.join(tempDir, ".env"),
      });
      expect(plainEnvResult.decision).toBe("ask");
    });

    it("should match glob patterns with double wildcard (recursive)", async () => {
      const claudeDir = path.join(tempDir, ".claude");
      await fs.promises.mkdir(claudeDir, { recursive: true });
      await fs.promises.writeFile(
        path.join(claudeDir, "settings.json"),
        JSON.stringify({
          permissions: {
            deny: ["Read(./secrets/**)"],
          },
        }),
      );

      settingsManager = new SettingsManager(tempDir);
      await settingsManager.initialize();

      const secretResult = settingsManager.checkPermission("mcp__acp__Read", {
        file_path: path.join(tempDir, "secrets", "api-key.txt"),
      });
      expect(secretResult.decision).toBe("deny");

      const nestedSecretResult = settingsManager.checkPermission("mcp__acp__Read", {
        file_path: path.join(tempDir, "secrets", "deep", "nested", "key.txt"),
      });
      expect(nestedSecretResult.decision).toBe("deny");

      const otherResult = settingsManager.checkPermission("mcp__acp__Read", {
        file_path: path.join(tempDir, "public", "file.txt"),
      });
      expect(otherResult.decision).toBe("ask");
    });

    it("should handle home directory expansion", async () => {
      const claudeDir = path.join(tempDir, ".claude");
      await fs.promises.mkdir(claudeDir, { recursive: true });
      await fs.promises.writeFile(
        path.join(claudeDir, "settings.json"),
        JSON.stringify({
          permissions: {
            allow: ["Read(~/.zshrc)"],
          },
        }),
      );

      settingsManager = new SettingsManager(tempDir);
      await settingsManager.initialize();

      const zshrcResult = settingsManager.checkPermission("mcp__acp__Read", {
        file_path: path.join(os.homedir(), ".zshrc"),
      });
      expect(zshrcResult.decision).toBe("allow");
    });
  });

  describe("settings merging", () => {
    it("should merge project and local settings", async () => {
      const claudeDir = path.join(tempDir, ".claude");
      await fs.promises.mkdir(claudeDir, { recursive: true });

      // Project settings
      await fs.promises.writeFile(
        path.join(claudeDir, "settings.json"),
        JSON.stringify({
          permissions: {
            allow: ["Read"],
          },
        }),
      );

      // Local settings
      await fs.promises.writeFile(
        path.join(claudeDir, "settings.local.json"),
        JSON.stringify({
          permissions: {
            deny: ["Read(./.env)"],
          },
        }),
      );

      settingsManager = new SettingsManager(tempDir);
      await settingsManager.initialize();

      // Read should be allowed in general
      const readResult = settingsManager.checkPermission("mcp__acp__Read", {
        file_path: path.join(tempDir, "file.txt"),
      });
      expect(readResult.decision).toBe("allow");

      // But .env should be denied (local settings take precedence)
      const envResult = settingsManager.checkPermission("mcp__acp__Read", {
        file_path: path.join(tempDir, ".env"),
      });
      expect(envResult.decision).toBe("deny");
    });

    it("should merge model setting with later sources taking precedence", async () => {
      const claudeDir = path.join(tempDir, ".claude");
      await fs.promises.mkdir(claudeDir, { recursive: true });

      // Project settings with one model
      await fs.promises.writeFile(
        path.join(claudeDir, "settings.json"),
        JSON.stringify({
          model: "claude-3-5-sonnet",
        }),
      );

      settingsManager = new SettingsManager(tempDir);
      await settingsManager.initialize();

      let settings = settingsManager.getSettings();
      expect(settings.model).toBe("claude-3-5-sonnet");

      // Add local settings that override the model
      await fs.promises.writeFile(
        path.join(claudeDir, "settings.local.json"),
        JSON.stringify({
          model: "claude-3-5-haiku",
        }),
      );

      // Re-initialize to pick up local settings
      settingsManager.dispose();
      settingsManager = new SettingsManager(tempDir);
      await settingsManager.initialize();

      settings = settingsManager.getSettings();
      expect(settings.model).toBe("claude-3-5-haiku");
    });
  });

  describe("ask rules", () => {
    it("should return 'ask' for matching ask rules", async () => {
      const claudeDir = path.join(tempDir, ".claude");
      await fs.promises.mkdir(claudeDir, { recursive: true });
      await fs.promises.writeFile(
        path.join(claudeDir, "settings.json"),
        JSON.stringify({
          permissions: {
            ask: ["Bash(git push:*)"],
          },
        }),
      );

      settingsManager = new SettingsManager(tempDir);
      await settingsManager.initialize();

      const result = settingsManager.checkPermission("mcp__acp__Bash", {
        command: "git push origin main",
      });
      expect(result.decision).toBe("ask");
      expect(result.rule).toBe("Bash(git push:*)");
    });
  });

  describe("Edit and Write tools", () => {
    it("should handle Edit tool permissions", async () => {
      const claudeDir = path.join(tempDir, ".claude");
      await fs.promises.mkdir(claudeDir, { recursive: true });
      await fs.promises.writeFile(
        path.join(claudeDir, "settings.json"),
        JSON.stringify({
          permissions: {
            deny: ["Edit(./package-lock.json)"],
          },
        }),
      );

      settingsManager = new SettingsManager(tempDir);
      await settingsManager.initialize();

      const lockFileResult = settingsManager.checkPermission("mcp__acp__Edit", {
        file_path: path.join(tempDir, "package-lock.json"),
      });
      expect(lockFileResult.decision).toBe("deny");

      const otherResult = settingsManager.checkPermission("mcp__acp__Edit", {
        file_path: path.join(tempDir, "package.json"),
      });
      expect(otherResult.decision).toBe("ask");
    });

    it("should handle mcp__acp__Edit and mcp__acp__Write tool names", async () => {
      const claudeDir = path.join(tempDir, ".claude");
      await fs.promises.mkdir(claudeDir, { recursive: true });
      await fs.promises.writeFile(
        path.join(claudeDir, "settings.json"),
        JSON.stringify({
          permissions: {
            allow: ["Edit", "Write"],
          },
        }),
      );

      settingsManager = new SettingsManager(tempDir);
      await settingsManager.initialize();

      const editResult = settingsManager.checkPermission("mcp__acp__Edit", {
        file_path: "/some/file.ts",
      });
      expect(editResult.decision).toBe("allow");

      const writeResult = settingsManager.checkPermission("mcp__acp__Write", {
        file_path: "/some/file.ts",
      });
      expect(writeResult.decision).toBe("allow");
    });
  });

  describe("getSettings", () => {
    it("should return merged settings", async () => {
      const claudeDir = path.join(tempDir, ".claude");
      await fs.promises.mkdir(claudeDir, { recursive: true });
      await fs.promises.writeFile(
        path.join(claudeDir, "settings.json"),
        JSON.stringify({
          permissions: {
            allow: ["Read", "Bash(npm:*)"],
            deny: ["Read(./.env)"],
          },
          env: {
            FOO: "bar",
          },
        }),
      );

      settingsManager = new SettingsManager(tempDir);
      await settingsManager.initialize();

      const settings = settingsManager.getSettings();
      expect(settings.permissions?.allow).toContain("Read");
      expect(settings.permissions?.allow).toContain("Bash(npm:*)");
      expect(settings.permissions?.deny).toContain("Read(./.env)");
      expect(settings.env?.FOO).toBe("bar");
    });
  });

  describe("setCwd", () => {
    it("should reload settings when cwd changes", async () => {
      const claudeDir1 = path.join(tempDir, ".claude");
      await fs.promises.mkdir(claudeDir1, { recursive: true });
      await fs.promises.writeFile(
        path.join(claudeDir1, "settings.json"),
        JSON.stringify({
          permissions: {
            allow: ["Read"],
          },
        }),
      );

      settingsManager = new SettingsManager(tempDir);
      await settingsManager.initialize();

      let result = settingsManager.checkPermission("mcp__acp__Read", { file_path: "/file.txt" });
      expect(result.decision).toBe("allow");

      // Create a new temp directory with different settings
      const tempDir2 = await fs.promises.mkdtemp(path.join(os.tmpdir(), "settings-test-2-"));
      const claudeDir2 = path.join(tempDir2, ".claude");
      await fs.promises.mkdir(claudeDir2, { recursive: true });
      await fs.promises.writeFile(
        path.join(claudeDir2, "settings.json"),
        JSON.stringify({
          permissions: {
            deny: ["Read"],
          },
        }),
      );

      await settingsManager.setCwd(tempDir2);

      result = settingsManager.checkPermission("mcp__acp__Read", { file_path: "/file.txt" });
      expect(result.decision).toBe("deny");

      // Cleanup second temp dir
      await fs.promises.rm(tempDir2, { recursive: true, force: true });
    });
  });

  describe("cross-tool rule isolation", () => {
    // These tests verify the fix in commit d471ccf:
    // Permission rules should only match their intended tool type.
    // A Bash rule should not match Edit/Write/Read operations, and vice versa.

    it("should not apply Bash rules to Edit tool calls", async () => {
      const claudeDir = path.join(tempDir, ".claude");
      await fs.promises.mkdir(claudeDir, { recursive: true });
      await fs.promises.writeFile(
        path.join(claudeDir, "settings.json"),
        JSON.stringify({
          permissions: {
            // This Bash rule has an argument that looks like a glob pattern.
            // Before the fix, it would incorrectly match Edit operations
            // because the argument would be interpreted as a file glob.
            allow: ["Bash(./**:*)"],
          },
        }),
      );

      settingsManager = new SettingsManager(tempDir);
      await settingsManager.initialize();

      // Bash rule should NOT allow Edit operations
      const result = settingsManager.checkPermission("mcp__acp__Edit", {
        file_path: path.join(tempDir, "any-file.txt"),
      });
      expect(result.decision).toBe("ask");
    });

    it("should not apply Bash rules to Write tool calls", async () => {
      const claudeDir = path.join(tempDir, ".claude");
      await fs.promises.mkdir(claudeDir, { recursive: true });
      await fs.promises.writeFile(
        path.join(claudeDir, "settings.json"),
        JSON.stringify({
          permissions: {
            allow: ["Bash(./**:*)"],
          },
        }),
      );

      settingsManager = new SettingsManager(tempDir);
      await settingsManager.initialize();

      const result = settingsManager.checkPermission("mcp__acp__Write", {
        file_path: path.join(tempDir, "any-file.txt"),
      });
      expect(result.decision).toBe("ask");
    });

    it("should not apply Bash rules to Read tool calls", async () => {
      const claudeDir = path.join(tempDir, ".claude");
      await fs.promises.mkdir(claudeDir, { recursive: true });
      await fs.promises.writeFile(
        path.join(claudeDir, "settings.json"),
        JSON.stringify({
          permissions: {
            allow: ["Bash(./**:*)"],
          },
        }),
      );

      settingsManager = new SettingsManager(tempDir);
      await settingsManager.initialize();

      const result = settingsManager.checkPermission("mcp__acp__Read", {
        file_path: path.join(tempDir, "any-file.txt"),
      });
      expect(result.decision).toBe("ask");
    });

    it("should not apply Edit rules to Bash tool calls", async () => {
      const claudeDir = path.join(tempDir, ".claude");
      await fs.promises.mkdir(claudeDir, { recursive: true });
      await fs.promises.writeFile(
        path.join(claudeDir, "settings.json"),
        JSON.stringify({
          permissions: {
            allow: ["Edit"],
          },
        }),
      );

      settingsManager = new SettingsManager(tempDir);
      await settingsManager.initialize();

      const result = settingsManager.checkPermission("mcp__acp__Bash", {
        command: "echo hello",
      });
      expect(result.decision).toBe("ask");
    });

    it("should not apply Read rules to Bash tool calls", async () => {
      const claudeDir = path.join(tempDir, ".claude");
      await fs.promises.mkdir(claudeDir, { recursive: true });
      await fs.promises.writeFile(
        path.join(claudeDir, "settings.json"),
        JSON.stringify({
          permissions: {
            allow: ["Read"],
          },
        }),
      );

      settingsManager = new SettingsManager(tempDir);
      await settingsManager.initialize();

      const result = settingsManager.checkPermission("mcp__acp__Bash", {
        command: "ls -la",
      });
      expect(result.decision).toBe("ask");
    });
  });
});
