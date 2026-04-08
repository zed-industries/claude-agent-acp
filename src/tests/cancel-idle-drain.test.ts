/**
 * Regression test for: first prompt after cancel returns 0-token end_turn.
 *
 * Root cause: after interrupt(), the SDK generator yields cleanup messages.
 * If the cancelled prompt's loop returns via `session_state_changed: idle`
 * *before* Claude Code's internal state has fully settled, the second
 * prompt's user message is pushed to input but the generator may yield
 * another `session_state_changed: idle` from the lingering interrupt
 * cleanup, terminating the second prompt's loop with zero content.
 *
 * This test models two scenarios to locate the exact failure mode.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  AgentSideConnection,
} from "@agentclientprotocol/sdk";
import type {
  Query,
  SDKMessage,
  SDKResultSuccess,
  SDKSessionStateChangedMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAcpAgent } from "../acp-agent.js";
import { Pushable } from "../utils.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SESSION_ID = "test-session";
const ZERO_USAGE = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

function makeResultMessage(overrides?: Record<string, any>): SDKResultSuccess {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 100,
    duration_api_ms: 80,
    is_error: false,
    num_turns: 1,
    result: "",
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage: ZERO_USAGE,
    modelUsage: [],
    session_id: SESSION_ID,
    ...overrides,
  } as SDKResultSuccess;
}

function makeIdleMessage(): SDKSessionStateChangedMessage {
  return {
    type: "system",
    subtype: "session_state_changed",
    state: "idle",
    uuid: "idle-uuid",
    session_id: SESSION_ID,
  };
}

function createMockClient() {
  return {
    sessionUpdate: vi.fn().mockResolvedValue(undefined),
  } as unknown as AgentSideConnection;
}

function injectSession(
  agent: ClaudeAcpAgent,
  sessionId: string,
  query: Query,
  input: Pushable<SDKUserMessage>,
) {
  (agent.sessions as any)[sessionId] = {
    query,
    input,
    cancelled: false,
    cwd: "/tmp",
    sessionFingerprint: "test",
    settingsManager: { dispose: vi.fn() },
    accumulatedUsage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedReadTokens: 0,
      cachedWriteTokens: 0,
    },
    modes: { currentModeId: "default", availableModes: [] },
    models: { currentModelId: "default", availableModels: [] },
    configOptions: [],
    promptRunning: false,
    pendingMessages: new Map(),
    nextPendingOrder: 0,
    abortController: new AbortController(),
  };
}

const queryStubs = {
  setPermissionMode: vi.fn(),
  setModel: vi.fn(),
  setMaxThinkingTokens: vi.fn(),
  applyFlagSettings: vi.fn(),
  initializationResult: vi.fn(),
  supportedCommands: vi.fn(),
  supportedModels: vi.fn(),
  supportedAgents: vi.fn(),
  mcpServerStatus: vi.fn(),
  getContextUsage: vi.fn(),
  reloadPlugins: vi.fn(),
  accountInfo: vi.fn(),
  rewindFiles: vi.fn(),
  seedReadState: vi.fn(),
  reconnectMcpServer: vi.fn(),
  toggleMcpServer: vi.fn(),
  setMcpServers: vi.fn(),
  streamInput: vi.fn(),
  stopTask: vi.fn(),
  close: vi.fn(),
};

/**
 * Build a mock Query backed by a Pushable. interrupt() pushes a sentinel
 * that the test can use to model the SDK's post-interrupt behaviour.
 */
function createMockQuery(): {
  query: Query;
  feed: Pushable<SDKMessage>;
} {
  const feed = new Pushable<SDKMessage>();
  const iterator = feed[Symbol.asyncIterator]();

  const query = {
    next: () => iterator.next() as Promise<IteratorResult<SDKMessage, void>>,
    return: (v: any) => Promise.resolve({ value: v, done: true as const }),
    throw: (e: any) => Promise.reject(e),
    [Symbol.asyncIterator]() { return this; },
    interrupt: vi.fn(async () => {
      // In the real SDK, interrupt sends a control request to Claude Code.
      // Claude Code then yields result + idle through the message stream.
      // We model this by pushing those messages into the feed.
    }),
    ...queryStubs,
  } as unknown as Query;

  return { query, feed };
}

// ---------------------------------------------------------------------------
// Test: cancelled → cancelled prompt consumes idle → second prompt is clean
// ---------------------------------------------------------------------------

describe("cancel → prompt sequencing", () => {
  let client: AgentSideConnection;
  let agent: ClaudeAcpAgent;

  beforeEach(() => {
    client = createMockClient();
    agent = new ClaudeAcpAgent(client);
  });

  it("normal cancel: idle consumed by first prompt, second prompt works", async () => {
    const { query, feed } = createMockQuery();
    const input = new Pushable<SDKUserMessage>();
    injectSession(agent, SESSION_ID, query, input);

    // 1. First prompt starts, enters loop, blocks on next().
    const p1 = agent.prompt({
      sessionId: SESSION_ID,
      prompt: [{ type: "text", text: "sleep 30" }],
    });
    await new Promise((r) => setTimeout(r, 5));

    // 2. Cancel.
    const cancelP = agent.cancel({ sessionId: SESSION_ID });

    // SDK yields result then idle (normal post-interrupt sequence).
    feed.push(makeResultMessage());
    feed.push(makeIdleMessage());

    await cancelP;
    const r1 = await p1;
    expect(r1.stopReason).toBe("cancelled");

    // 3. Second prompt. Feed a real turn's messages.
    const p2 = agent.prompt({
      sessionId: SESSION_ID,
      prompt: [{ type: "text", text: "hello?" }],
    });
    await new Promise((r) => setTimeout(r, 5));

    feed.push(makeResultMessage({
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    }));
    feed.push(makeIdleMessage());

    const r2 = await p2;
    expect(r2.stopReason).toBe("end_turn");

    const session = (agent.sessions as any)[SESSION_ID];
    expect(session.accumulatedUsage.inputTokens).toBe(100);
  });

  /**
   * Model the race where cancel() returns (interrupt resolved) BEFORE
   * the first prompt's loop has consumed the stale idle. The second
   * prompt() is called immediately, resets `cancelled=false`. The first
   * prompt is still in its loop and sees cancelled=false when processing
   * the result, so it doesn't set stopReason to "cancelled". It continues,
   * consumes idle, and returns "end_turn" — the wrong value for prompt 1.
   * Meanwhile prompt 2 is queued (promptRunning=true).
   *
   * Since prompt 1 returned end_turn, the finally block resolves prompt 2's
   * pending promise. Prompt 2 then enters the loop and gets messages for the
   * REAL second turn. But prompt 1 was supposed to be "cancelled".
   */
  it("race: second prompt resets cancelled before first prompt checks it", async () => {
    const { query, feed } = createMockQuery();
    const input = new Pushable<SDKUserMessage>();
    injectSession(agent, SESSION_ID, query, input);

    // 1. First prompt starts.
    const p1 = agent.prompt({
      sessionId: SESSION_ID,
      prompt: [{ type: "text", text: "sleep 30" }],
    });
    await new Promise((r) => setTimeout(r, 5));

    // 2. Cancel: set cancelled=true, call interrupt() which resolves immediately.
    const cancelP = agent.cancel({ sessionId: SESSION_ID });
    await cancelP;

    // At this point: cancelled=true, interrupt resolved, but the first prompt
    // loop hasn't received any messages yet (feed is empty so far).

    // 3. RACE: second prompt arrives before first prompt processes any message.
    //    This call sets cancelled=false (line 497). Since promptRunning=true,
    //    the second prompt goes into the queueing branch.
    const p2 = agent.prompt({
      sessionId: SESSION_ID,
      prompt: [{ type: "text", text: "hello?" }],
    });

    // Now feed the SDK cleanup messages. The first prompt loop picks them up,
    // but cancelled is false!
    feed.push(makeResultMessage());
    feed.push(makeIdleMessage());

    const r1 = await p1;

    // BUG: first prompt should have returned "cancelled" but cancelled was
    // reset to false by the second prompt() call at line 497.
    // With the bug, r1.stopReason === "end_turn".
    //
    // This assertion documents the expected-correct behaviour:
    expect(r1.stopReason).toBe("cancelled");

    // Second prompt: the first prompt's finally block resolves its pending
    // promise, so it enters the loop. Feed its turn messages.
    await new Promise((r) => setTimeout(r, 5));
    feed.push(makeResultMessage({
      usage: {
        input_tokens: 200,
        output_tokens: 100,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    }));
    feed.push(makeIdleMessage());

    const r2 = await p2;
    expect(r2.stopReason).toBe("end_turn");
    const session = (agent.sessions as any)[SESSION_ID];
    expect(session.accumulatedUsage.inputTokens).toBe(200);
  });
});
