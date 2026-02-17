import { describe, it, expect } from "vitest";
import { AgentSideConnection } from "@agentclientprotocol/sdk";
import { ImageBlockParam, ToolResultBlockParam } from "@anthropic-ai/sdk/resources";
import {
  BetaMCPToolResultBlock,
  BetaTextBlock,
  BetaWebSearchResultBlock,
  BetaWebSearchToolResultBlock,
  BetaBashCodeExecutionToolResultBlock,
  BetaBashCodeExecutionResultBlock,
} from "@anthropic-ai/sdk/resources/beta.mjs";
import { toAcpNotifications, ToolUseCache, Logger } from "../acp-agent.js";

describe("rawOutput in tool call updates", () => {
  const mockClient = {} as AgentSideConnection;
  const mockLogger: Logger = { log: () => {}, error: () => {} };

  it("should include rawOutput with string content for tool_result", () => {
    const toolUseCache: ToolUseCache = {
      toolu_123: {
        type: "tool_use",
        id: "toolu_123",
        name: "Bash",
        input: { command: "echo hello" },
      },
    };

    const toolResult: ToolResultBlockParam = {
      type: "tool_result",
      tool_use_id: "toolu_123",
      content: "hello\n",
      is_error: false,
    };

    const notifications = toAcpNotifications(
      [toolResult],
      "assistant",
      "test-session",
      toolUseCache,
      mockClient,
      mockLogger,
    );

    expect(notifications).toHaveLength(1);
    expect(notifications[0].update).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_123",
      status: "completed",
      rawOutput: "hello\n",
    });
  });

  it("should include rawOutput with array content for tool_result", () => {
    const toolUseCache: ToolUseCache = {
      toolu_456: {
        type: "tool_use",
        id: "toolu_456",
        name: "Read",
        input: { file_path: "/test/file.txt" },
      },
    };

    // ToolResultBlockParam content can be string or array of TextBlockParam
    const toolResult: ToolResultBlockParam = {
      type: "tool_result",
      tool_use_id: "toolu_456",
      content: [{ type: "text", text: "Line 1\nLine 2\nLine 3" }],
      is_error: false,
    };

    const notifications = toAcpNotifications(
      [toolResult],
      "assistant",
      "test-session",
      toolUseCache,
      mockClient,
      mockLogger,
    );

    expect(notifications).toHaveLength(1);
    expect(notifications[0].update).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_456",
      status: "completed",
      rawOutput: [{ type: "text", text: "Line 1\nLine 2\nLine 3" }],
    });
  });

  it("should include rawOutput for mcp_tool_result with string content", () => {
    const toolUseCache: ToolUseCache = {
      toolu_789: {
        type: "tool_use",
        id: "toolu_789",
        name: "mcp__server__tool",
        input: { query: "test" },
      },
    };

    // BetaMCPToolResultBlock content can be string or Array<BetaTextBlock>
    const toolResult: BetaMCPToolResultBlock = {
      type: "mcp_tool_result",
      tool_use_id: "toolu_789",
      content: '{"result": "success", "data": [1, 2, 3]}',
      is_error: false,
    };

    const notifications = toAcpNotifications(
      [toolResult],
      "assistant",
      "test-session",
      toolUseCache,
      mockClient,
      mockLogger,
    );

    expect(notifications).toHaveLength(1);
    expect(notifications[0].update).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_789",
      status: "completed",
      rawOutput: '{"result": "success", "data": [1, 2, 3]}',
    });
  });

  it("should include rawOutput for mcp_tool_result with array content", () => {
    const toolUseCache: ToolUseCache = {
      toolu_abc: {
        type: "tool_use",
        id: "toolu_abc",
        name: "mcp__server__search",
        input: { term: "test" },
      },
    };

    // BetaTextBlock requires citations field
    const arrayContent: BetaTextBlock[] = [
      { type: "text", text: "Result 1", citations: null },
      { type: "text", text: "Result 2", citations: null },
    ];

    const toolResult: BetaMCPToolResultBlock = {
      type: "mcp_tool_result",
      tool_use_id: "toolu_abc",
      content: arrayContent,
      is_error: false,
    };

    const notifications = toAcpNotifications(
      [toolResult],
      "assistant",
      "test-session",
      toolUseCache,
      mockClient,
      mockLogger,
    );

    expect(notifications).toHaveLength(1);
    expect(notifications[0].update).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_abc",
      status: "completed",
      rawOutput: arrayContent,
    });
  });

  it("should include rawOutput for web_search_tool_result", () => {
    const toolUseCache: ToolUseCache = {
      toolu_web: {
        type: "tool_use",
        id: "toolu_web",
        name: "WebSearch",
        input: { query: "test search" },
      },
    };

    // BetaWebSearchResultBlock from SDK
    const searchResults: BetaWebSearchResultBlock[] = [
      {
        type: "web_search_result",
        url: "https://example.com",
        title: "Example",
        encrypted_content: "encrypted content here",
        page_age: "2 days ago",
      },
    ];

    const toolResult: BetaWebSearchToolResultBlock = {
      type: "web_search_tool_result",
      tool_use_id: "toolu_web",
      content: searchResults,
    };

    const notifications = toAcpNotifications(
      [toolResult],
      "assistant",
      "test-session",
      toolUseCache,
      mockClient,
      mockLogger,
    );

    expect(notifications).toHaveLength(1);
    expect(notifications[0].update).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_web",
      status: "completed",
      rawOutput: searchResults,
    });
  });

  it("should include rawOutput for bash_code_execution_tool_result", () => {
    const toolUseCache: ToolUseCache = {
      toolu_bash: {
        type: "tool_use",
        id: "toolu_bash",
        name: "Bash",
        input: { command: "ls -la" },
      },
    };

    // BetaBashCodeExecutionResultBlock from SDK
    const bashResult: BetaBashCodeExecutionResultBlock = {
      type: "bash_code_execution_result",
      stdout: "file1.txt\nfile2.txt",
      stderr: "",
      return_code: 0,
      content: [],
    };

    const toolResult: BetaBashCodeExecutionToolResultBlock = {
      type: "bash_code_execution_tool_result",
      tool_use_id: "toolu_bash",
      content: bashResult,
    };

    const notifications = toAcpNotifications(
      [toolResult],
      "assistant",
      "test-session",
      toolUseCache,
      mockClient,
      mockLogger,
    );

    expect(notifications).toHaveLength(1);
    expect(notifications[0].update).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_bash",
      status: "completed",
      rawOutput: bashResult,
    });
  });

  it("should set status to failed when is_error is true", () => {
    const toolUseCache: ToolUseCache = {
      toolu_err: {
        type: "tool_use",
        id: "toolu_err",
        name: "Bash",
        input: { command: "invalid_command" },
      },
    };

    const toolResult: ToolResultBlockParam = {
      type: "tool_result",
      tool_use_id: "toolu_err",
      content: "command not found: invalid_command",
      is_error: true,
    };

    const notifications = toAcpNotifications(
      [toolResult],
      "assistant",
      "test-session",
      toolUseCache,
      mockClient,
      mockLogger,
    );

    expect(notifications).toHaveLength(1);
    expect(notifications[0].update).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_err",
      status: "failed",
      rawOutput: "command not found: invalid_command",
    });
  });

  it("should not emit tool_call_update for TodoWrite (emits plan instead)", () => {
    const toolUseCache: ToolUseCache = {
      toolu_todo: {
        type: "tool_use",
        id: "toolu_todo",
        name: "TodoWrite",
        input: { todos: [{ content: "Test task", status: "pending" }] },
      },
    };

    const toolResult: ToolResultBlockParam = {
      type: "tool_result",
      tool_use_id: "toolu_todo",
      content: "Todos updated successfully",
      is_error: false,
    };

    const notifications = toAcpNotifications(
      [toolResult],
      "assistant",
      "test-session",
      toolUseCache,
      mockClient,
      mockLogger,
    );

    // TodoWrite should not emit tool_call_update - it emits plan updates instead
    expect(notifications).toHaveLength(0);
  });

  it("should convert Read tool base64 image content to ACP image format", () => {
    const toolUseCache: ToolUseCache = {
      toolu_img: {
        type: "tool_use",
        id: "toolu_img",
        name: "Read",
        input: { file_path: "/test/image.png" },
      },
    };

    const imageBlock: ImageBlockParam = {
      type: "image",
      source: { type: "base64", data: "iVBORw0KGgo=", media_type: "image/png" },
    };

    const toolResult: ToolResultBlockParam = {
      type: "tool_result",
      tool_use_id: "toolu_img",
      content: [imageBlock],
      is_error: false,
    };

    const notifications = toAcpNotifications(
      [toolResult],
      "assistant",
      "test-session",
      toolUseCache,
      mockClient,
      mockLogger,
    );

    expect(notifications).toHaveLength(1);
    expect(notifications[0].update).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_img",
      status: "completed",
      content: [
        {
          type: "content",
          content: { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
        },
      ],
    });
  });

  it("should handle Read tool with mixed text and image content", () => {
    const toolUseCache: ToolUseCache = {
      toolu_mix: {
        type: "tool_use",
        id: "toolu_mix",
        name: "Read",
        input: { file_path: "/test/image.png" },
      },
    };

    const imageBlock: ImageBlockParam = {
      type: "image",
      source: { type: "base64", data: "iVBORw0KGgo=", media_type: "image/png" },
    };

    const toolResult: ToolResultBlockParam = {
      type: "tool_result",
      tool_use_id: "toolu_mix",
      content: [{ type: "text", text: "File preview:" }, imageBlock],
      is_error: false,
    };

    const notifications = toAcpNotifications(
      [toolResult],
      "assistant",
      "test-session",
      toolUseCache,
      mockClient,
      mockLogger,
    );

    expect(notifications).toHaveLength(1);
    expect(notifications[0].update).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_mix",
      status: "completed",
      content: [
        {
          type: "content",
          content: { type: "text", text: "```\nFile preview:\n```" },
        },
        {
          type: "content",
          content: { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
        },
      ],
    });
  });
});
