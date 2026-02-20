import { describe, expect, it, Mock, vi } from "vitest";
import { ClaudeAcpAgent } from "../acp-agent.js";
import { AgentSideConnection } from "@agentclientprotocol/sdk";

describe("authorization", () => {
  async function createAgentMock(): Promise<[ClaudeAcpAgent, Mock]> {
    const mockQuery = vi.hoisted(() =>
      vi.fn(() => ({
        initializationResult: vi.fn().mockResolvedValue({
          models: [{ value: "id", displayName: "name", description: "description" }],
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

  it("uses gateway env after gateway auth", async () => {
    const [agent, mockQuery] = await createAgentMock();

    const initializeResponse = await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: {},
    });
    expect(initializeResponse.authMethods).toContainEqual(
      expect.objectContaining({ id: "gateway" }),
    );

    await agent.authenticate({
      methodId: "gateway",
      _meta: { gateway: { baseUrl: "https://gateway.example", headers: { "x-api-key": "test" } } },
    });

    await agent.newSession({
      cwd: "testRoot",
      mcpServers: [],
      _meta: {
        claudeCode: {
          options: {
            env: {
              userEnv: "userEnv",
            },
          },
        },
      },
    });

    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          env: {
            ANTHROPIC_AUTH_TOKEN: "",
            ANTHROPIC_BASE_URL: "https://gateway.example",
            ANTHROPIC_CUSTOM_HEADERS: "x-api-key: test",
            userEnv: "userEnv",
          },
        }),
      }),
    );
  });
});
