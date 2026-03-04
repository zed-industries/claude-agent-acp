import { describe, expect, it, Mock, vi, afterEach, beforeEach } from "vitest";
import { ClaudeAcpAgent } from "../acp-agent.js";
import { AgentSideConnection } from "@agentclientprotocol/sdk";

describe("alternative auth bypass", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  });

  async function createAgentMockWithSubscription(): Promise<[ClaudeAcpAgent, Mock]> {
    const mockQuery = vi.hoisted(() =>
      vi.fn(() => ({
        initializationResult: vi.fn().mockResolvedValue({
          models: [{ value: "id", displayName: "name", description: "description" }],
          account: { subscriptionType: "pro" },
        }),
        setModel: vi.fn(),
        supportedCommands: vi.fn().mockResolvedValue([]),
      })),
    );

    vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
      query: mockQuery,
    }));

    const connectionMock = {
      sessionUpdate: async (_: any) => {},
    } as AgentSideConnection;

    const agent = new ClaudeAcpAgent(connectionMock);

    return [agent, mockQuery];
  }

  it("allows session with CLAUDE_CODE_USE_FOUNDRY even with subscriptionType", async () => {
    const [agent] = await createAgentMockWithSubscription();
    vi.stubGlobal("process", {
      ...process,
      argv: ["--hide-claude-auth"],
      env: { ...process.env, CLAUDE_CODE_USE_FOUNDRY: "1" },
    });

    await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: { auth: { _meta: { gateway: true } } } as any,
    });

    // Should not throw - Foundry auth should bypass subscriptionType check
    await expect(
      agent.newSession({
        cwd: "testRoot",
        mcpServers: [],
      }),
    ).resolves.toBeDefined();
  });

  it("allows session with ANTHROPIC_API_KEY even with subscriptionType", async () => {
    const [agent] = await createAgentMockWithSubscription();
    vi.stubGlobal("process", {
      ...process,
      argv: ["--hide-claude-auth"],
      env: { ...process.env, ANTHROPIC_API_KEY: "sk-test" },
    });

    await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: { auth: { _meta: { gateway: true } } } as any,
    });

    // Should not throw - API key auth should bypass subscriptionType check
    await expect(
      agent.newSession({
        cwd: "testRoot",
        mcpServers: [],
      }),
    ).resolves.toBeDefined();
  });

  it("allows session with CLAUDE_CODE_USE_BEDROCK even with subscriptionType", async () => {
    const [agent] = await createAgentMockWithSubscription();
    vi.stubGlobal("process", {
      ...process,
      argv: ["--hide-claude-auth"],
      env: { ...process.env, CLAUDE_CODE_USE_BEDROCK: "1" },
    });

    await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: { auth: { _meta: { gateway: true } } } as any,
    });

    // Should not throw - Bedrock auth should bypass subscriptionType check
    await expect(
      agent.newSession({
        cwd: "testRoot",
        mcpServers: [],
      }),
    ).resolves.toBeDefined();
  });

  it("allows session with gateway auth even with subscriptionType", async () => {
    const [agent] = await createAgentMockWithSubscription();
    vi.stubGlobal("process", {
      ...process,
      argv: ["--hide-claude-auth"],
    });

    await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: { auth: { _meta: { gateway: true } } } as any,
    });

    await agent.authenticate({
      methodId: "gateway",
      _meta: { gateway: { baseUrl: "https://gateway.example", headers: { "x-api-key": "test" } } },
    });

    // Should not throw - gateway auth should bypass subscriptionType check
    await expect(
      agent.newSession({
        cwd: "testRoot",
        mcpServers: [],
      }),
    ).resolves.toBeDefined();
  });
});
