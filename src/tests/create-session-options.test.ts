import { describe, it, expect, beforeEach, vi } from "vitest";
import { AgentSideConnection, SessionNotification } from "@agentclientprotocol/sdk";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeAcpAgent as ClaudeAcpAgentType, NewSessionMeta } from "../acp-agent.js";
import * as nodefs from "node:fs";

// Default: no JSONL files exist anywhere.
// We preserve the actual `promises` export so SettingsManager (which uses
// fs.promises.readFile) continues to work in the other test suites.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    readdirSync: vi.fn().mockReturnValue([]),
    // Default: no session file content (no cwd recoverable from JSONL).
    readFileSync: vi.fn().mockReturnValue(""),
  };
});

let capturedOptions: Options | undefined;
vi.mock("@anthropic-ai/claude-agent-sdk", async () => {
  const actual = await vi.importActual<typeof import("@anthropic-ai/claude-agent-sdk")>(
    "@anthropic-ai/claude-agent-sdk",
  );
  return {
    ...actual,
    query: (args: { prompt: unknown; options: Options }) => {
      capturedOptions = args.options;
      return {
        initializationResult: async () => ({
          models: [
            { value: "claude-sonnet-4-5", displayName: "Claude Sonnet", description: "Fast" },
          ],
        }),
        setModel: async () => {},
        supportedCommands: async () => [],
        [Symbol.asyncIterator]: async function* () {},
      };
    },
  };
});

vi.mock("../tools.js", async () => {
  const actual = await vi.importActual<typeof import("../tools.js")>("../tools.js");
  return {
    ...actual,
    registerHookCallback: vi.fn(),
  };
});

describe("createSession options merging", () => {
  let agent: ClaudeAcpAgentType;
  let ClaudeAcpAgent: typeof ClaudeAcpAgentType;

  function createMockClient(): AgentSideConnection {
    return {
      sessionUpdate: async (_notification: SessionNotification) => {},
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      readTextFile: async () => ({ content: "" }),
      writeTextFile: async () => ({}),
    } as unknown as AgentSideConnection;
  }

  beforeEach(async () => {
    capturedOptions = undefined;

    vi.resetModules();
    const acpAgent = await import("../acp-agent.js");
    ClaudeAcpAgent = acpAgent.ClaudeAcpAgent;

    agent = new ClaudeAcpAgent(createMockClient());
  });

  it("merges user-provided disallowedTools with ACP internal list", async () => {
    await agent.newSession({
      cwd: "/test",
      mcpServers: [],
      _meta: {
        claudeCode: {
          options: {
            disallowedTools: ["WebSearch", "WebFetch"],
          },
        },
      },
    });

    // User-provided tools should be present
    expect(capturedOptions!.disallowedTools).toContain("WebSearch");
    expect(capturedOptions!.disallowedTools).toContain("WebFetch");
    // ACP's internal disallowed tool should also be present
    expect(capturedOptions!.disallowedTools).toContain("AskUserQuestion");
  });

  it("works when user provides no disallowedTools", async () => {
    await agent.newSession({
      cwd: "/test",
      mcpServers: [],
    });

    expect(capturedOptions!.disallowedTools).toContain("AskUserQuestion");
  });

  it("works when user provides empty disallowedTools", async () => {
    await agent.newSession({
      cwd: "/test",
      mcpServers: [],
      _meta: {
        claudeCode: {
          options: {
            disallowedTools: [],
          },
        },
      },
    });

    expect(capturedOptions!.disallowedTools).toContain("AskUserQuestion");
  });

  it("sets tools to empty array when disableBuiltInTools is true", async () => {
    await agent.newSession({
      cwd: "/test",
      mcpServers: [],
      _meta: {
        disableBuiltInTools: true,
        claudeCode: {
          options: {
            disallowedTools: ["CustomTool"],
          },
        },
      },
    });

    // disableBuiltInTools removes all built-in tools from context
    expect(capturedOptions!.tools).toEqual([]);
    // User-provided and ACP disallowedTools still apply
    expect(capturedOptions!.disallowedTools).toContain("CustomTool");
    expect(capturedOptions!.disallowedTools).toContain("AskUserQuestion");
  });

  it("merges user-provided hooks with ACP hooks", async () => {
    const userPreToolUseHook = { hooks: [{ command: "echo pre" }] };

    await agent.newSession({
      cwd: "/test",
      mcpServers: [],
      _meta: {
        claudeCode: {
          options: {
            hooks: {
              PreToolUse: [userPreToolUseHook],
              PostToolUse: [{ hooks: [{ command: "echo user-post" }] }],
            },
          },
        },
      },
    });

    // User's PreToolUse hooks should be preserved
    expect(capturedOptions!.hooks?.PreToolUse).toEqual([userPreToolUseHook]);
    // PostToolUse should contain both user and ACP hooks
    expect(capturedOptions!.hooks?.PostToolUse).toHaveLength(2);
  });

  it("inherits HOME and PATH from process.env when no env is provided", async () => {
    await agent.newSession({
      cwd: "/test",
      mcpServers: [],
    });

    expect(capturedOptions?.env?.HOME).toBe(process.env.HOME);
    expect(capturedOptions?.env?.PATH).toBe(process.env.PATH);
  });

  it("merges user-provided env vars on top of process.env", async () => {
    await agent.newSession({
      cwd: "/test",
      mcpServers: [],
      _meta: {
        claudeCode: {
          options: {
            env: {
              CUSTOM_VAR: "custom-value",
            },
          },
        },
      },
    });

    expect(capturedOptions?.env?.HOME).toBe(process.env.HOME);
    expect(capturedOptions?.env?.PATH).toBe(process.env.PATH);
    expect(capturedOptions?.env?.CUSTOM_VAR).toBe("custom-value");
  });

  it("allows user-provided env vars to override process.env entries", async () => {
    await agent.newSession({
      cwd: "/test",
      mcpServers: [],
      _meta: {
        claudeCode: {
          options: {
            env: {
              HOME: "/custom/home",
            },
          },
        },
      },
    });

    expect(capturedOptions?.env?.HOME).toBe("/custom/home");
  });

  it("defaults tools to claude_code preset when not provided", async () => {
    await agent.newSession({
      cwd: "/test",
      mcpServers: [],
    });

    expect(capturedOptions!.tools).toEqual({ type: "preset", preset: "claude_code" });
  });

  it("passes through user-provided tools string array", async () => {
    await agent.newSession({
      cwd: "/test",
      mcpServers: [],
      _meta: {
        claudeCode: {
          options: {
            tools: ["Read", "Glob"],
          },
        },
      },
    });

    expect(capturedOptions!.tools).toEqual(["Read", "Glob"]);
  });

  it("explicit tools array takes precedence over disableBuiltInTools", async () => {
    await agent.newSession({
      cwd: "/test",
      mcpServers: [],
      _meta: {
        disableBuiltInTools: true,
        claudeCode: {
          options: {
            tools: ["Read", "Glob"],
          },
        },
      },
    });

    expect(capturedOptions!.tools).toEqual(["Read", "Glob"]);
  });

  it("passes through empty tools array to disable all built-in tools", async () => {
    await agent.newSession({
      cwd: "/test",
      mcpServers: [],
      _meta: {
        claudeCode: {
          options: {
            tools: [],
          },
        },
      },
    });

    expect(capturedOptions!.tools).toEqual([]);
  });

  it("merges user-provided mcpServers with ACP mcpServers", async () => {
    await agent.newSession({
      cwd: "/test",
      mcpServers: [
        {
          name: "acp-server",
          command: "node",
          args: ["acp-server.js"],
          env: [],
        },
      ],
      _meta: {
        claudeCode: {
          options: {
            mcpServers: {
              "user-server": {
                type: "stdio",
                command: "node",
                args: ["server.js"],
              },
            },
          },
        },
      },
    });

    // User-provided MCP server should be present
    expect(capturedOptions!.mcpServers).toHaveProperty("user-server");
    // ACP-provided MCP server should also be present
    expect(capturedOptions!.mcpServers).toHaveProperty("acp-server");
  });
});

describe("UUID extraction from ACP session keys", () => {
  const BARE_UUID = "abc12345-0000-0000-0000-000000000000";
  const ACP_KEY = `agent:claude:acp:${BARE_UUID}`;

  let agent: ClaudeAcpAgentType;
  let ClaudeAcpAgent: typeof ClaudeAcpAgentType;

  function createMockClient(): AgentSideConnection {
    return {
      sessionUpdate: async (_notification: SessionNotification) => {},
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      readTextFile: async () => ({ content: "" }),
      writeTextFile: async () => ({}),
    } as unknown as AgentSideConnection;
  }

  beforeEach(async () => {
    capturedOptions = undefined;
    vi.mocked(nodefs.existsSync).mockReturnValue(false);
    vi.mocked(nodefs.readdirSync).mockReturnValue([]);

    vi.resetModules();
    const acpAgent = await import("../acp-agent.js");
    ClaudeAcpAgent = acpAgent.ClaudeAcpAgent;
    agent = new ClaudeAcpAgent(createMockClient());
  });

  it("strips ACP key prefix so resume option uses bare UUID", async () => {
    // When resume is triggered via _meta with a full ACP key, the options.resume
    // passed to Claude SDK must be the bare UUID only.
    await agent.newSession({
      cwd: "/test",
      mcpServers: [],
      _meta: {
        claudeCode: {
          options: {
            resume: ACP_KEY,
          },
        },
      } as NewSessionMeta,
    });

    expect(capturedOptions!.resume).toBe(BARE_UUID);
  });

  it("leaves bare UUID unchanged when passed as resume", async () => {
    await agent.newSession({
      cwd: "/test",
      mcpServers: [],
      _meta: {
        claudeCode: {
          options: {
            resume: BARE_UUID,
          },
        },
      } as NewSessionMeta,
    });

    expect(capturedOptions!.resume).toBe(BARE_UUID);
  });
});

describe("file-existence-based resume flags", () => {
  const BARE_UUID = "deadbeef-0000-0000-0000-000000000001";
  const ACP_KEY = `agent:claude:acp:${BARE_UUID}`;

  let agent: ClaudeAcpAgentType;
  let ClaudeAcpAgent: typeof ClaudeAcpAgentType;
  let CLAUDE_CONFIG_DIR: string;

  function createMockClient(): AgentSideConnection {
    return {
      sessionUpdate: async (_notification: SessionNotification) => {},
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      readTextFile: async () => ({ content: "" }),
      writeTextFile: async () => ({}),
    } as unknown as AgentSideConnection;
  }

  beforeEach(async () => {
    capturedOptions = undefined;
    // Reset all fs mocks to "nothing found" defaults
    vi.mocked(nodefs.existsSync).mockReturnValue(false);
    vi.mocked(nodefs.readdirSync).mockReturnValue([]);
    vi.mocked(nodefs.readFileSync).mockReturnValue("");

    vi.resetModules();
    const acpAgent = await import("../acp-agent.js");
    ClaudeAcpAgent = acpAgent.ClaudeAcpAgent;
    CLAUDE_CONFIG_DIR = acpAgent.CLAUDE_CONFIG_DIR;
    agent = new ClaudeAcpAgent(createMockClient());
  });

  it("when JSONL at expected path: options.resume=UUID, options.sessionId unset", async () => {
    // Simulate: file exists at expected path
    const expectedPath = `${CLAUDE_CONFIG_DIR}/projects/-test/${BARE_UUID}.jsonl`;
    vi.mocked(nodefs.existsSync).mockImplementation((p) => p === expectedPath);

    await agent.newSession({
      cwd: "/test",
      mcpServers: [],
      _meta: {
        claudeCode: {
          options: { resume: ACP_KEY },
        },
      } as NewSessionMeta,
    });

    expect(capturedOptions!.resume).toBe(BARE_UUID);
    expect(capturedOptions!.sessionId).toBeUndefined();
  });

  it("when JSONL not found anywhere: options.sessionId=UUID set to trigger resourceNotFound", async () => {
    // All existsSync calls return false (default mock)
    vi.mocked(nodefs.existsSync).mockReturnValue(false);
    vi.mocked(nodefs.readdirSync).mockReturnValue([]);

    await agent.newSession({
      cwd: "/test",
      mcpServers: [],
      _meta: {
        claudeCode: {
          options: { resume: ACP_KEY },
        },
      } as NewSessionMeta,
    });

    expect(capturedOptions!.sessionId).toBe(BARE_UUID);
  });

  it("when JSONL found in different project dir: reads cwd from JSONL, options.sessionId unset", async () => {
    const altDir = "-tmp";
    const altPath = `${CLAUDE_CONFIG_DIR}/projects/${altDir}/${BARE_UUID}.jsonl`;
    const altCwd = "/tmp";

    // Simulate JSONL content: queue-operation lines (no cwd), then a message line with cwd.
    const jsonlContent = [
      JSON.stringify({ type: "queue-operation", operation: "enqueue", sessionId: BARE_UUID }),
      JSON.stringify({ type: "queue-operation", operation: "dequeue", sessionId: BARE_UUID }),
      JSON.stringify({ type: "user", cwd: altCwd, sessionId: BARE_UUID }),
    ].join("\n");

    vi.mocked(nodefs.readdirSync).mockReturnValue([
      { name: altDir, isDirectory: () => true } as any,
    ]);
    vi.mocked(nodefs.existsSync).mockImplementation((p) => p === altPath);
    vi.mocked(nodefs.readFileSync).mockImplementation((p) => {
      if (p === altPath) return jsonlContent;
      return "";
    });

    await agent.newSession({
      cwd: "/test",
      mcpServers: [],
      _meta: {
        claudeCode: {
          options: { resume: ACP_KEY },
        },
      } as NewSessionMeta,
    });

    // cwd should be the value read from the JSONL, not a lossy dir-name decode.
    expect(capturedOptions!.cwd).toBe(altCwd);
    // sessionId should NOT be set (--resume only)
    expect(capturedOptions!.sessionId).toBeUndefined();
  });

  it("recovers hyphenated cwd correctly via JSONL (would be wrong with dir-name decode)", async () => {
    // /home/user/my-project encodes to -home-user-my-project.
    // Dir-name decode: '-home-user-my-project'.replace(/-/g, '/') = '/home/user/my/project' — WRONG.
    // JSONL-based recovery returns the actual cwd unchanged.
    const altDir = "-home-user-my-project";
    const altPath = `${CLAUDE_CONFIG_DIR}/projects/${altDir}/${BARE_UUID}.jsonl`;
    const actualCwd = "/home/user/my-project";

    const jsonlContent = [
      JSON.stringify({ type: "queue-operation", operation: "enqueue", sessionId: BARE_UUID }),
      JSON.stringify({ type: "user", cwd: actualCwd, sessionId: BARE_UUID }),
    ].join("\n");

    vi.mocked(nodefs.readdirSync).mockReturnValue([
      { name: altDir, isDirectory: () => true } as any,
    ]);
    vi.mocked(nodefs.existsSync).mockImplementation((p) => p === altPath);
    vi.mocked(nodefs.readFileSync).mockImplementation((p) => {
      if (p === altPath) return jsonlContent;
      return "";
    });

    await agent.newSession({
      cwd: "/test",
      mcpServers: [],
      _meta: {
        claudeCode: {
          options: { resume: ACP_KEY },
        },
      } as NewSessionMeta,
    });

    // Must be the original hyphenated path, not the lossy-decoded '/home/user/my/project'.
    expect(capturedOptions!.cwd).toBe(actualCwd);
    expect(capturedOptions!.sessionId).toBeUndefined();
  });

  it("falls back to dir-name decode when JSONL has no cwd lines, using existsSync to validate", async () => {
    // Simulates old-format JSONL or empty file: no cwd field found.
    // Falls back to lossy decode and checks existsSync on the decoded path.
    const altDir = "-tmp";
    const altPath = `${CLAUDE_CONFIG_DIR}/projects/${altDir}/${BARE_UUID}.jsonl`;
    const decodedCwd = "/tmp"; // '-tmp'.replace(/-/g, '/') = '/tmp' — correct for this simple case

    vi.mocked(nodefs.readdirSync).mockReturnValue([
      { name: altDir, isDirectory: () => true } as any,
    ]);
    // existsSync: the alt JSONL exists, and the decoded path /tmp also exists
    vi.mocked(nodefs.existsSync).mockImplementation((p) => p === altPath || p === decodedCwd);
    // readFileSync returns content with no cwd field
    vi.mocked(nodefs.readFileSync).mockReturnValue(
      JSON.stringify({ type: "queue-operation", operation: "enqueue", sessionId: BARE_UUID }),
    );

    await agent.newSession({
      cwd: "/test",
      mcpServers: [],
      _meta: {
        claudeCode: {
          options: { resume: ACP_KEY },
        },
      } as NewSessionMeta,
    });

    expect(capturedOptions!.cwd).toBe(decodedCwd);
    expect(capturedOptions!.sessionId).toBeUndefined();
  });
});

describe("proposedSessionId in _meta", () => {
  let agent: ClaudeAcpAgentType;
  let ClaudeAcpAgent: typeof ClaudeAcpAgentType;

  function createMockClient(): AgentSideConnection {
    return {
      sessionUpdate: async (_notification: SessionNotification) => {},
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      readTextFile: async () => ({ content: "" }),
      writeTextFile: async () => ({}),
    } as unknown as AgentSideConnection;
  }

  beforeEach(async () => {
    capturedOptions = undefined;

    vi.resetModules();
    const acpAgent = await import("../acp-agent.js");
    ClaudeAcpAgent = acpAgent.ClaudeAcpAgent;

    agent = new ClaudeAcpAgent(createMockClient());
  });

  it("uses proposedSessionId from _meta when provided", async () => {
    const proposedId = "11111111-1111-1111-1111-111111111111";

    const result = await agent.newSession({
      cwd: "/test",
      mcpServers: [],
      // Type cast needed because NewSessionRequest._meta is typed as
      // { [key: string]: unknown }, so we cast to NewSessionMeta to satisfy
      // the value type while retaining full type safety for the meta shape.
      _meta: {
        claudeCode: {
          options: {
            proposedSessionId: proposedId,
          },
        },
      } as NewSessionMeta,
    });

    expect(result.sessionId).toBe(proposedId);
    expect(capturedOptions!.sessionId).toBe(proposedId);
  });

  it("generates a random session ID when proposedSessionId is absent", async () => {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    const result = await agent.newSession({
      cwd: "/test",
      mcpServers: [],
    });

    expect(result.sessionId).toMatch(uuidRegex);
    expect(capturedOptions!.sessionId).toBe(result.sessionId);
  });
});
