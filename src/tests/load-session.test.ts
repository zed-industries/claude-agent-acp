import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { AgentSideConnection, SessionNotification } from "@agentclientprotocol/sdk";
import type { ClaudeAcpAgent as ClaudeAcpAgentType } from "../acp-agent.js";
import { encodeProjectPath } from "../utils.js";

const { registerHookCallbackSpy } = vi.hoisted(() => ({
  registerHookCallbackSpy: vi.fn(),
}));

vi.mock("../tools.js", async () => {
  const actual = await vi.importActual<typeof import("../tools.js")>("../tools.js");
  return {
    ...actual,
    registerHookCallback: registerHookCallbackSpy,
  };
});

describe("loadSession", () => {
  let tempDir: string;
  let originalClaudeConfigDir: string | undefined;
  let agent: ClaudeAcpAgentType;
  let ClaudeAcpAgent: typeof ClaudeAcpAgentType;
  let sessionUpdates: SessionNotification[];
  let createSessionSpy: ReturnType<typeof vi.fn>;

  // Helper to create a mock AgentSideConnection
  function createMockClient(): AgentSideConnection {
    return {
      sessionUpdate: async (notification: SessionNotification) => {
        sessionUpdates.push(notification);
      },
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      readTextFile: async () => ({ content: "" }),
      writeTextFile: async () => ({}),
    } as unknown as AgentSideConnection;
  }

  function writeSessionFile(
    cwd: string,
    sessionId: string,
    entries: Array<Record<string, unknown> | string>,
  ): void {
    const encodedPath = encodeProjectPath(cwd);
    const projectDir = path.join(tempDir, "projects", encodedPath);
    fs.mkdirSync(projectDir, { recursive: true });

    const filePath = path.join(projectDir, `${sessionId}.jsonl`);
    const lines = entries.map((entry) =>
      typeof entry === "string" ? entry : JSON.stringify(entry),
    );
    fs.writeFileSync(filePath, lines.join("\n"));
  }

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-load-session-"));
    originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = tempDir;
    sessionUpdates = [];
    registerHookCallbackSpy.mockClear();

    vi.resetModules();

    const acpAgent = await import("../acp-agent.js");
    ClaudeAcpAgent = acpAgent.ClaudeAcpAgent;

    agent = new ClaudeAcpAgent(createMockClient());
    createSessionSpy = vi.fn(async () => ({ modes: null, models: null }));
    (agent as unknown as { createSession: typeof createSessionSpy }).createSession =
      createSessionSpy;
  });

  afterEach(() => {
    if (originalClaudeConfigDir !== undefined) {
      process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
    } else {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("throws when the session file does not exist", async () => {
    await expect(
      agent.loadSession({
        cwd: "/Users/test/project",
        sessionId: "missing-session",
        mcpServers: [],
      }),
    ).rejects.toThrow("Session not found");

    expect(createSessionSpy).not.toHaveBeenCalled();
  });

  it("replays history and returns modes/models from createSession", async () => {
    const cwd = "/Users/test/project";
    const sessionId = "session-123";

    writeSessionFile(cwd, sessionId, [
      { type: "summary", summary: "ignored" },
      {
        type: "user",
        sessionId,
        message: { role: "user", content: "Hello" },
      },
      {
        type: "assistant",
        sessionId,
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "Thinking" }],
        },
      },
      {
        type: "assistant",
        sessionId,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hi" }],
        },
      },
      {
        type: "assistant",
        sessionId,
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-1",
              name: "Read",
              input: { file_path: "/tmp/example.txt" },
            },
          ],
        },
      },
      {
        type: "user",
        sessionId,
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok" }],
        },
      },
    ]);

    const result = await agent.loadSession({ cwd, sessionId, mcpServers: [] });

    expect(result).toEqual({ modes: null, models: null });
    expect(createSessionSpy).toHaveBeenCalledWith(
      expect.objectContaining({ cwd, mcpServers: [] }),
      { resume: sessionId },
    );
    expect(registerHookCallbackSpy).not.toHaveBeenCalled();

    expect(sessionUpdates.map((notification) => notification.update.sessionUpdate)).toEqual([
      "user_message_chunk",
      "agent_thought_chunk",
      "agent_message_chunk",
      "tool_call",
      "tool_call_update",
    ]);

    expect(sessionUpdates[0]?.update).toMatchObject({
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "Hello" },
    });
    expect(sessionUpdates[1]?.update).toMatchObject({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "Thinking" },
    });
    expect(sessionUpdates[2]?.update).toMatchObject({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Hi" },
    });
    expect(sessionUpdates[3]?.update).toMatchObject({
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      status: "pending",
    });
    expect(sessionUpdates[4]?.update).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      status: "completed",
    });
  });

  it("skips sidechain, mismatched sessionId, invalid, and unsupported entries", async () => {
    const cwd = "/Users/test/project";
    const sessionId = "session-456";

    writeSessionFile(cwd, sessionId, [
      "{not valid json}",
      { type: "summary", summary: "ignore" },
      {
        type: "user",
        sessionId,
        isSidechain: true,
        message: { role: "user", content: "Sidechain" },
      },
      {
        type: "assistant",
        sessionId: "other-session",
        message: { role: "assistant", content: "Wrong session" },
      },
      {
        type: "assistant",
        sessionId,
        message: { role: "system", content: "Unsupported role" },
      },
      {
        type: "user",
        sessionId,
        message: { role: "user", content: 123 },
      },
      {
        type: "user",
        sessionId,
        message: { role: "user", content: "Keep me" },
      },
    ]);

    await agent.loadSession({ cwd, sessionId, mcpServers: [] });

    expect(sessionUpdates).toHaveLength(1);
    expect(sessionUpdates[0]?.update).toMatchObject({
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "Keep me" },
    });
  });

  it("finds session file when cwd differs from the original session cwd", async () => {
    const originalCwd = "/Users/test/original-project";
    const differentCwd = "/Users/test/different-project";
    const sessionId = "cross-cwd-session";

    // Session was created in originalCwd
    writeSessionFile(originalCwd, sessionId, [
      {
        type: "user",
        sessionId,
        cwd: originalCwd,
        message: { role: "user", content: "Hello from original" },
      },
    ]);

    // Load with a different cwd
    await agent.loadSession({ cwd: differentCwd, sessionId, mcpServers: [] });

    expect(sessionUpdates).toHaveLength(1);
    expect(sessionUpdates[0]?.update).toMatchObject({
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "Hello from original" },
    });
    expect(createSessionSpy).toHaveBeenCalledWith(expect.objectContaining({ cwd: differentCwd }), {
      resume: sessionId,
    });
  });

  it("sends available_commands_update after history replay, not during", async () => {
    const cwd = "/Users/test/project";
    const sessionId = "session-commands";

    // Mock createSession to populate the sessions map with a mock query
    createSessionSpy.mockImplementationOnce(async () => {
      (agent as unknown as { sessions: Record<string, unknown> }).sessions[sessionId] = {
        query: {
          supportedCommands: async () => [{ name: "help", description: "Get help" }],
        },
      };
      return { modes: null, models: null };
    });

    writeSessionFile(cwd, sessionId, [
      {
        type: "user",
        sessionId,
        message: { role: "user", content: "Hello" },
      },
      {
        type: "assistant",
        sessionId,
        message: { role: "assistant", content: [{ type: "text", text: "Hi" }] },
      },
    ]);

    await agent.loadSession({ cwd, sessionId, mcpServers: [] });

    // Flush the setTimeout + async work inside sendAvailableCommandsUpdate
    await new Promise((resolve) => setTimeout(resolve, 10));

    const updateTypes = sessionUpdates.map((n) => n.update.sessionUpdate);

    // available_commands_update should come AFTER all replay notifications
    expect(updateTypes).toEqual([
      "user_message_chunk",
      "agent_message_chunk",
      "available_commands_update",
    ]);
  });

  it("handles Windows-style paths", async () => {
    const cwd = "C:\\Users\\test\\project";
    const sessionId = "win-session";

    writeSessionFile(cwd, sessionId, [
      {
        type: "user",
        sessionId,
        message: { role: "user", content: "Hello" },
      },
    ]);

    await agent.loadSession({ cwd, sessionId, mcpServers: [] });

    expect(sessionUpdates).toHaveLength(1);
    expect(sessionUpdates[0]?.sessionId).toBe(sessionId);
  });
});
