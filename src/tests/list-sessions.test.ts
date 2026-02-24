import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { AgentSideConnection } from "@agentclientprotocol/sdk";
import type { ClaudeAcpAgent as ClaudeAcpAgentType } from "../acp-agent.js";
import { encodeProjectPath } from "../utils.js";

describe("unstable_listSessions", () => {
  let tempDir: string;
  let originalClaudeConfigDir: string | undefined;
  let agent: ClaudeAcpAgentType;
  let ClaudeAcpAgent: typeof ClaudeAcpAgentType;

  // Helper to create a mock AgentSideConnection
  function createMockClient(): AgentSideConnection {
    return {
      sessionUpdate: async () => {},
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      readTextFile: async () => ({ content: "" }),
      writeTextFile: async () => ({}),
    } as unknown as AgentSideConnection;
  }

  // Helper to write a session file
  function writeSessionFile(
    cwd: string,
    sessionId: string,
    options: {
      userMessage?: string;
      userMessageArray?: boolean;
      mtime?: Date;
      malformed?: boolean;
      isAgentFile?: boolean;
      omitCwdFromEntries?: boolean;
    } = {},
  ): void {
    const encodedPath = encodeProjectPath(cwd);
    const projectDir = path.join(tempDir, "projects", encodedPath);
    fs.mkdirSync(projectDir, { recursive: true });

    const filename = options.isAgentFile ? `agent-${sessionId}.jsonl` : `${sessionId}.jsonl`;
    const filePath = path.join(projectDir, filename);

    if (options.malformed) {
      fs.writeFileSync(filePath, "not valid json\n{also bad");
      return;
    }

    const lines: string[] = [];

    // First line with sessionId
    lines.push(JSON.stringify({ sessionId, type: "init" }));

    // User message if provided
    if (options.userMessage) {
      const content = options.userMessageArray
        ? [{ type: "text", text: options.userMessage }]
        : options.userMessage;
      lines.push(
        JSON.stringify({
          type: "user",
          sessionId,
          ...(options.omitCwdFromEntries ? {} : { cwd }),
          message: { content },
        }),
      );
    }

    // Assistant response
    lines.push(
      JSON.stringify({
        type: "assistant",
        sessionId,
        ...(options.omitCwdFromEntries ? {} : { cwd }),
        message: { content: "Hello!" },
      }),
    );

    fs.writeFileSync(filePath, lines.join("\n"));

    // Set modification time if specified
    if (options.mtime) {
      fs.utimesSync(filePath, options.mtime, options.mtime);
    }
  }

  beforeEach(async () => {
    // Create temp directory to isolate tests from real filesystem.
    // We set process.env.CLAUDE_CONFIG_DIR before importing the module so that
    // CLAUDE_CONFIG_DIR is evaluated with our temp directory.
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-test-"));
    originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = tempDir;

    // Reset modules to pick up the new CLAUDE_CONFIG_DIR env var
    vi.resetModules();

    // Dynamic import after setting env var
    const acpAgent = await import("../acp-agent.js");
    ClaudeAcpAgent = acpAgent.ClaudeAcpAgent;

    // Create agent instance
    agent = new ClaudeAcpAgent(createMockClient());
  });

  afterEach(() => {
    // Restore env and cleanup
    if (originalClaudeConfigDir !== undefined) {
      process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
    } else {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns empty array when projects directory does not exist", async () => {
    const result = await agent.unstable_listSessions({});
    expect(result.sessions).toEqual([]);
    expect(result.nextCursor).toBeUndefined();
  });

  it("returns empty array when projects directory is empty", async () => {
    fs.mkdirSync(path.join(tempDir, "projects"), { recursive: true });

    const result = await agent.unstable_listSessions({});
    expect(result.sessions).toEqual([]);
  });

  it("parses session files and returns correct metadata", async () => {
    const cwd = "/Users/test/myproject";
    const sessionId = "sess-123";
    const mtime = new Date("2025-01-15T10:30:00Z");

    writeSessionFile(cwd, sessionId, {
      userMessage: "Hello, can you help me?",
      mtime,
    });

    const result = await agent.unstable_listSessions({});

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      sessionId: "sess-123",
      cwd: "/Users/test/myproject",
      title: "Hello, can you help me?",
    });
    expect(result.sessions[0]!.updatedAt).toBeDefined();
  });

  it("extracts title from array-style user message content", async () => {
    writeSessionFile("/Users/test/project", "sess-456", {
      userMessage: "Fix the bug in auth",
      userMessageArray: true,
    });

    const result = await agent.unstable_listSessions({});

    expect(result.sessions[0]!.title).toBe("Fix the bug in auth");
  });

  it("truncates long titles to 128 characters with ellipsis", async () => {
    const longMessage = "A".repeat(150);
    writeSessionFile("/Users/test/project", "sess-789", {
      userMessage: longMessage,
    });

    const result = await agent.unstable_listSessions({});

    expect(result.sessions[0]!.title).toBe("A".repeat(127) + "…");
  });

  it("replaces newlines with spaces in titles", async () => {
    const messageWithNewlines = "First line\nSecond line\r\nThird line";
    writeSessionFile("/Users/test/project", "sess-newlines", {
      userMessage: messageWithNewlines,
    });

    const result = await agent.unstable_listSessions({});

    expect(result.sessions[0]!.title).toBe("First line Second line Third line");
  });

  it("collapses multiple whitespace characters in titles", async () => {
    const messageWithWhitespace = "Hello    world  \n\n  test";
    writeSessionFile("/Users/test/project", "sess-whitespace", {
      userMessage: messageWithWhitespace,
    });

    const result = await agent.unstable_listSessions({});

    expect(result.sessions[0]!.title).toBe("Hello world test");
  });

  it("filters sessions by cwd parameter", async () => {
    writeSessionFile("/Users/test/projectone", "sess-a", { userMessage: "Project A" });
    writeSessionFile("/Users/test/projecttwo", "sess-b", { userMessage: "Project B" });

    const result = await agent.unstable_listSessions({ cwd: "/Users/test/projectone" });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]!.sessionId).toBe("sess-a");
  });

  it("uses per-entry cwd when filtering even if encoded folder collides", async () => {
    const encodedPath = encodeProjectPath("/Users/test/a-b");
    const projectDir = path.join(tempDir, "projects", encodedPath);
    fs.mkdirSync(projectDir, { recursive: true });

    fs.writeFileSync(
      path.join(projectDir, "sess-a-b.jsonl"),
      [
        JSON.stringify({ sessionId: "sess-a-b", type: "init" }),
        JSON.stringify({
          type: "user",
          sessionId: "sess-a-b",
          cwd: "/Users/test/a-b",
          message: { content: "A-B" },
        }),
      ].join("\n"),
    );

    fs.writeFileSync(
      path.join(projectDir, "sess-a-slash-b.jsonl"),
      [
        JSON.stringify({ sessionId: "sess-a-slash-b", type: "init" }),
        JSON.stringify({
          type: "user",
          sessionId: "sess-a-slash-b",
          cwd: "/Users/test/a/b",
          message: { content: "A/B" },
        }),
      ].join("\n"),
    );

    const result = await agent.unstable_listSessions({ cwd: "/Users/test/a-b" });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]!.sessionId).toBe("sess-a-b");
    expect(result.sessions[0]!.cwd).toBe("/Users/test/a-b");
  });

  it("returns the true cwd for paths containing hyphens", async () => {
    const cwd = "/Users/test/claude-agent-acp";
    writeSessionFile(cwd, "hyphen-session", { userMessage: "Hyphen test" });

    const result = await agent.unstable_listSessions({});

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]!.cwd).toBe(cwd);
    expect(result.sessions[0]!.sessionId).toBe("hyphen-session");
  });

  it("filters hyphenated paths by cwd correctly", async () => {
    writeSessionFile("/Users/test/claude-agent-acp", "hyphen-a", { userMessage: "A" });
    writeSessionFile("/Users/test/other-project", "hyphen-b", { userMessage: "B" });

    const result = await agent.unstable_listSessions({ cwd: "/Users/test/claude-agent-acp" });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]!.sessionId).toBe("hyphen-a");
    expect(result.sessions[0]!.cwd).toBe("/Users/test/claude-agent-acp");
  });

  it("returns all sessions when cwd is not specified", async () => {
    writeSessionFile("/Users/test/projectone", "sess-a", { userMessage: "A" });
    writeSessionFile("/Users/test/projecttwo", "sess-b", { userMessage: "B" });

    const result = await agent.unstable_listSessions({});

    expect(result.sessions).toHaveLength(2);
  });

  it("sorts sessions by updatedAt descending (most recent first)", async () => {
    writeSessionFile("/Users/test/project", "old-session", {
      userMessage: "Old",
      mtime: new Date("2025-01-01T00:00:00Z"),
    });
    writeSessionFile("/Users/test/project", "new-session", {
      userMessage: "New",
      mtime: new Date("2025-01-15T00:00:00Z"),
    });

    const result = await agent.unstable_listSessions({});

    expect(result.sessions[0]!.sessionId).toBe("new-session");
    expect(result.sessions[1]!.sessionId).toBe("old-session");
  });

  it("skips files starting with agent-", async () => {
    writeSessionFile("/Users/test/project", "regular-session", { userMessage: "Regular" });
    writeSessionFile("/Users/test/project", "hidden-session", {
      userMessage: "Hidden",
      isAgentFile: true,
    });

    const result = await agent.unstable_listSessions({});

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]!.sessionId).toBe("regular-session");
  });

  it("skips malformed session files gracefully", async () => {
    writeSessionFile("/Users/test/project", "good-session", { userMessage: "Good" });
    writeSessionFile("/Users/test/project", "bad-session", { malformed: true });

    const result = await agent.unstable_listSessions({});

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]!.sessionId).toBe("good-session");
  });

  it("uses filename as sessionId when not in file content", async () => {
    const cwd = "/Users/test/project";
    const encodedPath = encodeProjectPath(cwd);
    const projectDir = path.join(tempDir, "projects", encodedPath);
    fs.mkdirSync(projectDir, { recursive: true });

    // Write file without sessionId in content (uses filename fallback), but with cwd.
    const filePath = path.join(projectDir, "fallback-id.jsonl");
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({ type: "init" }),
        JSON.stringify({ type: "assistant", cwd, message: { content: "Hi" } }),
      ].join("\n"),
    );

    const result = await agent.unstable_listSessions({});

    expect(result.sessions[0]!.sessionId).toBe("fallback-id");
  });

  it("keeps sessionId stable from filename when later entries have different sessionId", async () => {
    const cwd = "/Users/test/project";
    const encodedPath = encodeProjectPath(cwd);
    const projectDir = path.join(tempDir, "projects", encodedPath);
    fs.mkdirSync(projectDir, { recursive: true });

    const filePath = path.join(projectDir, "stable-id.jsonl");
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({ type: "init", sessionId: "stable-id" }),
        JSON.stringify({
          type: "user",
          sessionId: "stable-id",
          cwd,
          message: { content: "Hello" },
        }),
        JSON.stringify({
          type: "assistant",
          sessionId: "other-id",
          cwd,
          message: { content: "Wrong session id from sidechain" },
        }),
      ].join("\n"),
    );

    const result = await agent.unstable_listSessions({});

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]!.sessionId).toBe("stable-id");
  });

  it("derives cwd from entries for the filename sessionId only", async () => {
    const cwd = "/Users/test/project";
    const encodedPath = encodeProjectPath(cwd);
    const projectDir = path.join(tempDir, "projects", encodedPath);
    fs.mkdirSync(projectDir, { recursive: true });

    const filePath = path.join(projectDir, "target-session.jsonl");
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          type: "user",
          sessionId: "target-session",
          cwd,
          message: { content: "Correct cwd entry" },
        }),
      ].join("\n"),
    );

    const result = await agent.unstable_listSessions({});

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]!.sessionId).toBe("target-session");
    expect(result.sessions[0]!.cwd).toBe(cwd);
  });

  it("keeps scanning after title to find later cwd in same session", async () => {
    const cwd = "/Users/test/project";
    const encodedPath = encodeProjectPath(cwd);
    const projectDir = path.join(tempDir, "projects", encodedPath);
    fs.mkdirSync(projectDir, { recursive: true });

    const filePath = path.join(projectDir, "late-cwd.jsonl");
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({ type: "init", sessionId: "late-cwd" }),
        JSON.stringify({
          type: "user",
          sessionId: "late-cwd",
          message: { content: "Title from first user message" },
        }),
        JSON.stringify({
          type: "assistant",
          sessionId: "late-cwd",
          cwd,
          message: { content: "Assistant entry carries cwd" },
        }),
      ].join("\n"),
    );

    const result = await agent.unstable_listSessions({});

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]!.sessionId).toBe("late-cwd");
    expect(result.sessions[0]!.cwd).toBe(cwd);
    expect(result.sessions[0]!.title).toBe("Title from first user message");
  });

  it("ignores sidechain entries when deriving cwd and title", async () => {
    const cwd = "/Users/test/project";
    const encodedPath = encodeProjectPath(cwd);
    const projectDir = path.join(tempDir, "projects", encodedPath);
    fs.mkdirSync(projectDir, { recursive: true });

    const filePath = path.join(projectDir, "sidechain-metadata.jsonl");
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({ type: "init", sessionId: "sidechain-metadata" }),
        JSON.stringify({
          type: "user",
          sessionId: "sidechain-metadata",
          isSidechain: true,
          cwd: "/Users/test/wrong-project",
          message: { content: "Wrong sidechain title" },
        }),
        JSON.stringify({
          type: "user",
          sessionId: "sidechain-metadata",
          cwd,
          message: { content: "Correct primary title" },
        }),
      ].join("\n"),
    );

    const result = await agent.unstable_listSessions({ cwd });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]!.sessionId).toBe("sidechain-metadata");
    expect(result.sessions[0]!.cwd).toBe(cwd);
    expect(result.sessions[0]!.title).toBe("Correct primary title");
  });

  it("skips entries without cwd when cwd filter is not provided", async () => {
    const cwd = "/Users/test/project";
    const encodedPath = encodeProjectPath(cwd);
    const projectDir = path.join(tempDir, "projects", encodedPath);
    fs.mkdirSync(projectDir, { recursive: true });

    const filePath = path.join(projectDir, "no-cwd.jsonl");
    fs.writeFileSync(filePath, JSON.stringify({ sessionId: "no-cwd", type: "summary" }) + "\n");

    const result = await agent.unstable_listSessions({});

    expect(result.sessions).toHaveLength(0);
  });

  it("returns null title when no user message exists", async () => {
    const cwd = "/Users/test/project";
    const encodedPath = encodeProjectPath(cwd);
    const projectDir = path.join(tempDir, "projects", encodedPath);
    fs.mkdirSync(projectDir, { recursive: true });

    // Write file with only init and assistant message
    const filePath = path.join(projectDir, "no-user.jsonl");
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({ sessionId: "no-user", type: "init" }),
        JSON.stringify({ type: "assistant", cwd, message: { content: "Hi" } }),
      ].join("\n"),
    );

    const result = await agent.unstable_listSessions({});

    expect(result.sessions[0]!.title).toBeNull();
  });

  describe("pagination", () => {
    it("returns nextCursor when there are more results", async () => {
      // Create 60 sessions (more than PAGE_SIZE of 50)
      for (let i = 0; i < 60; i++) {
        writeSessionFile("/Users/test/project", `sess-${i.toString().padStart(3, "0")}`, {
          userMessage: `Session ${i}`,
          mtime: new Date(Date.now() - i * 1000), // Each older by 1 second
        });
      }

      const result = await agent.unstable_listSessions({});

      expect(result.sessions).toHaveLength(50);
      expect(result.nextCursor).toBeDefined();
    });

    it("does not return nextCursor when all results fit in one page", async () => {
      for (let i = 0; i < 10; i++) {
        writeSessionFile("/Users/test/project", `sess-${i}`, { userMessage: `Session ${i}` });
      }

      const result = await agent.unstable_listSessions({});

      expect(result.sessions).toHaveLength(10);
      expect(result.nextCursor).toBeUndefined();
    });

    it("returns next page when cursor is provided", async () => {
      // Create 60 sessions
      for (let i = 0; i < 60; i++) {
        writeSessionFile("/Users/test/project", `sess-${i.toString().padStart(3, "0")}`, {
          userMessage: `Session ${i}`,
          mtime: new Date(Date.now() - i * 1000),
        });
      }

      // Get first page
      const firstPage = await agent.unstable_listSessions({});
      expect(firstPage.sessions).toHaveLength(50);
      expect(firstPage.nextCursor).toBeDefined();

      // Get second page
      const secondPage = await agent.unstable_listSessions({ cursor: firstPage.nextCursor });
      expect(secondPage.sessions).toHaveLength(10);
      expect(secondPage.nextCursor).toBeUndefined();
    });

    it("handles invalid cursor gracefully (starts from beginning)", async () => {
      writeSessionFile("/Users/test/project", "sess-1", { userMessage: "Test" });

      const result = await agent.unstable_listSessions({ cursor: "invalid-base64!" });

      expect(result.sessions).toHaveLength(1);
    });

    it("handles malformed cursor JSON gracefully", async () => {
      writeSessionFile("/Users/test/project", "sess-1", { userMessage: "Test" });

      // Valid base64 but not valid JSON
      const badCursor = Buffer.from("not json").toString("base64");
      const result = await agent.unstable_listSessions({ cursor: badCursor });

      expect(result.sessions).toHaveLength(1);
    });
  });

  describe("Windows path support", () => {
    it("decodes Windows-style paths correctly", async () => {
      // Simulate a Windows path encoded as "C-Users-test-project"
      const windowsCwd = "C:\\Users\\test\\project";
      writeSessionFile(windowsCwd, "win-session", { userMessage: "Windows test" });

      const result = await agent.unstable_listSessions({});

      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0]!.cwd).toBe("C:\\Users\\test\\project");
      expect(result.sessions[0]!.sessionId).toBe("win-session");
    });

    it("filters Windows paths by cwd correctly", async () => {
      writeSessionFile("C:\\Users\\test\\projectone", "win-a", { userMessage: "A" });
      writeSessionFile("C:\\Users\\test\\projecttwo", "win-b", { userMessage: "B" });

      const result = await agent.unstable_listSessions({ cwd: "C:\\Users\\test\\projectone" });

      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0]!.sessionId).toBe("win-a");
    });

    it("handles mixed Unix and Windows paths", async () => {
      writeSessionFile("/Users/test/unixproject", "unix-session", { userMessage: "Unix" });
      writeSessionFile("C:\\Users\\test\\winproject", "win-session", { userMessage: "Windows" });

      const result = await agent.unstable_listSessions({});

      expect(result.sessions).toHaveLength(2);
      const cwds = result.sessions.map((s) => s.cwd);
      expect(cwds).toContain("/Users/test/unixproject");
      expect(cwds).toContain("C:\\Users\\test\\winproject");
    });
  });
});
