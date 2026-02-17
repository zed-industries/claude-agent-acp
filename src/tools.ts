import {
  ContentBlock,
  PlanEntry,
  ToolCallContent,
  ToolCallLocation,
  ToolKind,
} from "@agentclientprotocol/sdk";
import { SYSTEM_REMINDER } from "./mcp-server.js";
import * as diff from "diff";
import {
  ImageBlockParam,
  TextBlockParam,
  ToolResultBlockParam,
  WebSearchResultBlock,
  WebSearchToolResultBlockParam,
  WebSearchToolResultError,
} from "@anthropic-ai/sdk/resources";
import {
  BetaBashCodeExecutionToolResultBlockParam,
  BetaBashCodeExecutionResultBlock,
  BetaBashCodeExecutionToolResultError,
  BetaCodeExecutionToolResultBlockParam,
  BetaCodeExecutionResultBlock,
  BetaCodeExecutionToolResultError,
  BetaRequestMCPToolResultBlockParam,
  BetaTextEditorCodeExecutionToolResultBlockParam,
  BetaTextEditorCodeExecutionViewResultBlock,
  BetaTextEditorCodeExecutionCreateResultBlock,
  BetaTextEditorCodeExecutionStrReplaceResultBlock,
  BetaTextEditorCodeExecutionToolResultError,
  BetaToolResultBlockParam,
  BetaToolSearchToolResultBlockParam,
  BetaToolReferenceBlock,
  BetaToolSearchToolSearchResultBlock,
  BetaToolSearchToolResultError,
  BetaWebFetchToolResultBlockParam,
  BetaWebFetchBlock,
  BetaWebFetchToolResultErrorBlock,
  BetaWebSearchToolResultBlockParam,
  BetaImageBlockParam,
} from "@anthropic-ai/sdk/resources/beta.mjs";

const acpUnqualifiedToolNames = {
  read: "Read",
  edit: "Edit",
  write: "Write",
  bash: "Bash",
  killShell: "KillShell",
  bashOutput: "BashOutput",
};

export const ACP_TOOL_NAME_PREFIX = "mcp__acp__";
export const acpToolNames = {
  read: ACP_TOOL_NAME_PREFIX + acpUnqualifiedToolNames.read,
  edit: ACP_TOOL_NAME_PREFIX + acpUnqualifiedToolNames.edit,
  write: ACP_TOOL_NAME_PREFIX + acpUnqualifiedToolNames.write,
  bash: ACP_TOOL_NAME_PREFIX + acpUnqualifiedToolNames.bash,
  killShell: ACP_TOOL_NAME_PREFIX + acpUnqualifiedToolNames.killShell,
  bashOutput: ACP_TOOL_NAME_PREFIX + acpUnqualifiedToolNames.bashOutput,
};

export const EDIT_TOOL_NAMES = [acpToolNames.edit, acpToolNames.write];

/**
 * Union of all possible content types that can appear in tool results from the Anthropic SDK.
 * These are transformed to valid ACP ContentBlock types by toValidAcpContent().
 */
type ToolResultContent =
  | TextBlockParam
  | ImageBlockParam
  | BetaImageBlockParam
  | BetaToolReferenceBlock
  | BetaToolSearchToolSearchResultBlock
  | BetaToolSearchToolResultError
  | WebSearchResultBlock
  | WebSearchToolResultError
  | BetaWebFetchBlock
  | BetaWebFetchToolResultErrorBlock
  | BetaCodeExecutionResultBlock
  | BetaCodeExecutionToolResultError
  | BetaBashCodeExecutionResultBlock
  | BetaBashCodeExecutionToolResultError
  | BetaTextEditorCodeExecutionViewResultBlock
  | BetaTextEditorCodeExecutionCreateResultBlock
  | BetaTextEditorCodeExecutionStrReplaceResultBlock
  | BetaTextEditorCodeExecutionToolResultError;
import { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { Logger } from "./acp-agent.js";
import { SettingsManager } from "./settings.js";

interface ToolInfo {
  title: string;
  kind: ToolKind;
  content: ToolCallContent[];
  locations?: ToolCallLocation[];
}

interface ToolUpdate {
  title?: string;
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
}

export function toolInfoFromToolUse(toolUse: any): ToolInfo {
  const name = toolUse.name;
  const input = toolUse.input;

  switch (name) {
    case "Task":
      return {
        title: input?.description ? input.description : "Task",
        kind: "think",
        content:
          input && input.prompt
            ? [
                {
                  type: "content",
                  content: { type: "text", text: input.prompt },
                },
              ]
            : [],
      };

    case "NotebookRead":
      return {
        title: input?.notebook_path ? `Read Notebook ${input.notebook_path}` : "Read Notebook",
        kind: "read",
        content: [],
        locations: input?.notebook_path ? [{ path: input.notebook_path }] : [],
      };

    case "NotebookEdit":
      return {
        title: input?.notebook_path ? `Edit Notebook ${input.notebook_path}` : "Edit Notebook",
        kind: "edit",
        content:
          input && input.new_source
            ? [
                {
                  type: "content",
                  content: { type: "text", text: input.new_source },
                },
              ]
            : [],
        locations: input?.notebook_path ? [{ path: input.notebook_path }] : [],
      };

    case "Bash":
    case acpToolNames.bash:
      return {
        title: input?.command ? "`" + input.command.replaceAll("`", "\\`") + "`" : "Terminal",
        kind: "execute",
        content:
          input && input.description
            ? [
                {
                  type: "content",
                  content: { type: "text", text: input.description },
                },
              ]
            : [],
      };

    case "BashOutput":
    case acpToolNames.bashOutput:
      return {
        title: "Tail Logs",
        kind: "execute",
        content: [],
      };

    case "KillShell":
    case acpToolNames.killShell:
      return {
        title: "Kill Process",
        kind: "execute",
        content: [],
      };

    case acpToolNames.read: {
      let limit = "";
      if (input.limit) {
        limit =
          " (" + ((input.offset ?? 0) + 1) + " - " + ((input.offset ?? 0) + input.limit) + ")";
      } else if (input.offset) {
        limit = " (from line " + (input.offset + 1) + ")";
      }
      return {
        title: "Read " + (input.file_path ?? "File") + limit,
        kind: "read",
        locations: input.file_path
          ? [
              {
                path: input.file_path,
                line: input.offset ?? 0,
              },
            ]
          : [],
        content: [],
      };
    }

    case "Read":
      return {
        title: "Read File",
        kind: "read",
        content: [],
        locations: input.file_path
          ? [
              {
                path: input.file_path,
                line: input.offset ?? 0,
              },
            ]
          : [],
      };

    case "LS":
      return {
        title: `List the ${input?.path ? "`" + input.path + "`" : "current"} directory's contents`,
        kind: "search",
        content: [],
        locations: [],
      };

    case acpToolNames.edit:
    case "Edit": {
      const path = input?.file_path ?? input?.file_path;

      return {
        title: path ? `Edit \`${path}\`` : "Edit",
        kind: "edit",
        content:
          input && path
            ? [
                {
                  type: "diff",
                  path,
                  oldText: input.old_string ?? null,
                  newText: input.new_string ?? "",
                },
              ]
            : [],
        locations: path ? [{ path }] : undefined,
      };
    }

    case acpToolNames.write: {
      let content: ToolCallContent[] = [];
      if (input && input.file_path) {
        content = [
          {
            type: "diff",
            path: input.file_path,
            oldText: null,
            newText: input.content,
          },
        ];
      } else if (input && input.content) {
        content = [
          {
            type: "content",
            content: { type: "text", text: input.content },
          },
        ];
      }
      return {
        title: input?.file_path ? `Write ${input.file_path}` : "Write",
        kind: "edit",
        content,
        locations: input?.file_path ? [{ path: input.file_path }] : [],
      };
    }

    case "Write":
      return {
        title: input?.file_path ? `Write ${input.file_path}` : "Write",
        kind: "edit",
        content:
          input && input.file_path
            ? [
                {
                  type: "diff",
                  path: input.file_path,
                  oldText: null,
                  newText: input.content,
                },
              ]
            : [],
        locations: input?.file_path ? [{ path: input.file_path }] : [],
      };

    case "Glob": {
      let label = "Find";
      if (input.path) {
        label += ` \`${input.path}\``;
      }
      if (input.pattern) {
        label += ` \`${input.pattern}\``;
      }
      return {
        title: label,
        kind: "search",
        content: [],
        locations: input.path ? [{ path: input.path }] : [],
      };
    }

    case "Grep": {
      let label = "grep";

      if (input["-i"]) {
        label += " -i";
      }
      if (input["-n"]) {
        label += " -n";
      }

      if (input["-A"] !== undefined) {
        label += ` -A ${input["-A"]}`;
      }
      if (input["-B"] !== undefined) {
        label += ` -B ${input["-B"]}`;
      }
      if (input["-C"] !== undefined) {
        label += ` -C ${input["-C"]}`;
      }

      if (input.output_mode) {
        switch (input.output_mode) {
          case "FilesWithMatches":
            label += " -l";
            break;
          case "Count":
            label += " -c";
            break;
          case "Content":
          default:
            break;
        }
      }

      if (input.head_limit !== undefined) {
        label += ` | head -${input.head_limit}`;
      }

      if (input.glob) {
        label += ` --include="${input.glob}"`;
      }

      if (input.type) {
        label += ` --type=${input.type}`;
      }

      if (input.multiline) {
        label += " -P";
      }

      if (input.pattern) {
        label += ` "${input.pattern}"`;
      }

      if (input.path) {
        label += ` ${input.path}`;
      }

      return {
        title: label,
        kind: "search",
        content: [],
      };
    }

    case "WebFetch":
      return {
        title: input?.url ? `Fetch ${input.url}` : "Fetch",
        kind: "fetch",
        content:
          input && input.prompt
            ? [
                {
                  type: "content",
                  content: { type: "text", text: input.prompt },
                },
              ]
            : [],
      };

    case "WebSearch": {
      let label = `"${input.query}"`;

      if (input.allowed_domains && input.allowed_domains.length > 0) {
        label += ` (allowed: ${input.allowed_domains.join(", ")})`;
      }

      if (input.blocked_domains && input.blocked_domains.length > 0) {
        label += ` (blocked: ${input.blocked_domains.join(", ")})`;
      }

      return {
        title: label,
        kind: "fetch",
        content: [],
      };
    }

    case "TodoWrite":
      return {
        title: Array.isArray(input?.todos)
          ? `Update TODOs: ${input.todos.map((todo: any) => todo.content).join(", ")}`
          : "Update TODOs",
        kind: "think",
        content: [],
      };

    case "ExitPlanMode":
      return {
        title: "Ready to code?",
        kind: "switch_mode",
        content:
          input && input.plan
            ? [{ type: "content", content: { type: "text", text: input.plan } }]
            : [],
      };

    case "Other": {
      let output;
      try {
        output = JSON.stringify(input, null, 2);
      } catch {
        output = typeof input === "string" ? input : "{}";
      }
      return {
        title: name || "Unknown Tool",
        kind: "other",
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: `\`\`\`json\n${output}\`\`\``,
            },
          },
        ],
      };
    }

    default:
      return {
        title: name || "Unknown Tool",
        kind: "other",
        content: [],
      };
  }
}

export function toolUpdateFromToolResult(
  toolResult:
    | ToolResultBlockParam
    | BetaToolResultBlockParam
    | BetaWebSearchToolResultBlockParam
    | BetaWebFetchToolResultBlockParam
    | WebSearchToolResultBlockParam
    | BetaCodeExecutionToolResultBlockParam
    | BetaBashCodeExecutionToolResultBlockParam
    | BetaTextEditorCodeExecutionToolResultBlockParam
    | BetaRequestMCPToolResultBlockParam
    | BetaToolSearchToolResultBlockParam,
  toolUse: any | undefined,
): ToolUpdate {
  if (
    "is_error" in toolResult &&
    toolResult.is_error &&
    toolResult.content &&
    toolResult.content.length > 0
  ) {
    // Only return errors
    return toAcpContentUpdate(toolResult.content, true);
  }

  switch (toolUse?.name) {
    case "Read":
    case acpToolNames.read:
      if (Array.isArray(toolResult.content) && toolResult.content.length > 0) {
        return {
          content: toolResult.content.map((content: any) => ({
            type: "content",
            content:
              content.type === "text"
                ? {
                    type: "text",
                    text: markdownEscape(content.text.replace(SYSTEM_REMINDER, "")),
                  }
                : toAcpContentBlock(content, false),
          })),
        };
      } else if (typeof toolResult.content === "string" && toolResult.content.length > 0) {
        return {
          content: [
            {
              type: "content",
              content: {
                type: "text",
                text: markdownEscape(toolResult.content.replace(SYSTEM_REMINDER, "")),
              },
            },
          ],
        };
      }
      return {};

    case acpToolNames.edit: {
      const content: ToolCallContent[] = [];
      const locations: ToolCallLocation[] = [];

      if (
        Array.isArray(toolResult.content) &&
        toolResult.content.length > 0 &&
        "text" in toolResult.content[0] &&
        typeof toolResult.content[0].text === "string"
      ) {
        const patches = diff.parsePatch(toolResult.content[0].text);
        console.error(JSON.stringify(patches));
        for (const { oldFileName, newFileName, hunks } of patches) {
          for (const { lines, newStart } of hunks) {
            const oldText = [];
            const newText = [];
            for (const line of lines) {
              if (line.startsWith("-")) {
                oldText.push(line.slice(1));
              } else if (line.startsWith("+")) {
                newText.push(line.slice(1));
              } else {
                oldText.push(line.slice(1));
                newText.push(line.slice(1));
              }
            }
            if (oldText.length > 0 || newText.length > 0) {
              locations.push({ path: newFileName || oldFileName, line: newStart });
              content.push({
                type: "diff",
                path: newFileName || oldFileName,
                oldText: oldText.join("\n") || null,
                newText: newText.join("\n"),
              });
            }
          }
        }
      }

      const result: ToolUpdate = {};
      if (content.length > 0) {
        result.content = content;
      }
      if (locations.length > 0) {
        result.locations = locations;
      }
      return result;
    }

    case acpToolNames.bash:
    case "edit":
    case "Edit":
    case acpToolNames.write:
    case "Write": {
      return {};
    }

    case "ExitPlanMode": {
      return { title: "Exited Plan Mode" };
    }

    case "Task":
    case "NotebookEdit":
    case "NotebookRead":
    case "TodoWrite":
    case "exit_plan_mode":
    case "Bash":
    case "BashOutput":
    case "KillBash":
    case "LS":
    case "Glob":
    case "Grep":
    case "WebFetch":
    case "WebSearch":
    case "Other":
    default: {
      return toAcpContentUpdate(
        toolResult.content,
        "is_error" in toolResult ? toolResult.is_error : false,
      );
    }
  }
}

function toAcpContentUpdate(
  content: any,
  isError: boolean = false,
): { content?: ToolCallContent[] } {
  if (Array.isArray(content) && content.length > 0) {
    return {
      content: content.map((c: any) => ({
        type: "content" as const,
        content: toAcpContentBlock(c, isError),
      })),
    };
  } else if (typeof content === "object" && content !== null && "type" in content) {
    return {
      content: [
        {
          type: "content" as const,
          content: toAcpContentBlock(content, isError),
        },
      ],
    };
  } else if (typeof content === "string" && content.length > 0) {
    return {
      content: [
        {
          type: "content",
          content: {
            type: "text",
            text: isError ? `\`\`\`\n${content}\n\`\`\`` : content,
          },
        },
      ],
    };
  }
  return {};
}

function toAcpContentBlock(content: ToolResultContent, isError: boolean): ContentBlock {
  const wrapText = (text: string): ContentBlock => ({
    type: "text" as const,
    text: isError ? `\`\`\`\n${text}\n\`\`\`` : text,
  });

  switch (content.type) {
    case "text":
      return {
        type: "text" as const,
        text: isError ? `\`\`\`\n${content.text}\n\`\`\`` : content.text,
      };
    case "image":
      if (content.source.type === "base64") {
        return {
          type: "image" as const,
          data: content.source.data,
          mimeType: content.source.media_type,
        };
      }
      // URL and file-based images can't be converted to ACP format (requires data)
      return wrapText(
        content.source.type === "url"
          ? `[image: ${content.source.url}]`
          : "[image: file reference]",
      );

    case "tool_reference":
      return wrapText(`Tool: ${content.tool_name}`);
    case "tool_search_tool_search_result":
      return wrapText(
        `Tools found: ${content.tool_references.map((r) => r.tool_name).join(", ") || "none"}`,
      );
    case "tool_search_tool_result_error":
      return wrapText(
        `Error: ${content.error_code}${content.error_message ? ` - ${content.error_message}` : ""}`,
      );
    case "web_search_result":
      return wrapText(`${content.title} (${content.url})`);
    case "web_search_tool_result_error":
      return wrapText(`Error: ${content.error_code}`);
    case "web_fetch_result":
      return wrapText(`Fetched: ${content.url}`);
    case "web_fetch_tool_result_error":
      return wrapText(`Error: ${content.error_code}`);
    case "code_execution_result":
      return wrapText(`Output: ${content.stdout || content.stderr || ""}`);
    case "bash_code_execution_result":
      return wrapText(`Output: ${content.stdout || content.stderr || ""}`);
    case "code_execution_tool_result_error":
    case "bash_code_execution_tool_result_error":
      return wrapText(`Error: ${content.error_code}`);
    case "text_editor_code_execution_view_result":
      return wrapText(content.content);
    case "text_editor_code_execution_create_result":
      return wrapText(content.is_file_update ? "File updated" : "File created");
    case "text_editor_code_execution_str_replace_result":
      return wrapText(content.lines?.join("\n") || "");
    case "text_editor_code_execution_tool_result_error":
      return wrapText(
        `Error: ${content.error_code}${content.error_message ? ` - ${content.error_message}` : ""}`,
      );

    default:
      return wrapText(JSON.stringify(content));
  }
}

export type ClaudePlanEntry = {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm: string;
};

export function planEntries(input: { todos: ClaudePlanEntry[] }): PlanEntry[] {
  return input.todos.map((input) => ({
    content: input.content,
    status: input.status,
    priority: "medium",
  }));
}

export function markdownEscape(text: string): string {
  let escape = "```";
  for (const [m] of text.matchAll(/^```+/gm)) {
    while (m.length >= escape.length) {
      escape += "`";
    }
  }
  return escape + "\n" + text + (text.endsWith("\n") ? "" : "\n") + escape;
}

/* A global variable to store callbacks that should be executed when receiving hooks from Claude Code */
const toolUseCallbacks: {
  [toolUseId: string]: {
    onPostToolUseHook?: (
      toolUseID: string,
      toolInput: unknown,
      toolResponse: unknown,
    ) => Promise<void>;
  };
} = {};

/* Setup callbacks that will be called when receiving hooks from Claude Code */
export const registerHookCallback = (
  toolUseID: string,
  {
    onPostToolUseHook,
  }: {
    onPostToolUseHook?: (
      toolUseID: string,
      toolInput: unknown,
      toolResponse: unknown,
    ) => Promise<void>;
  },
) => {
  toolUseCallbacks[toolUseID] = {
    onPostToolUseHook,
  };
};

/* A callback for Claude Code that is called when receiving a PostToolUse hook */
export const createPostToolUseHook =
  (
    logger: Logger = console,
    options?: {
      onEnterPlanMode?: () => Promise<void>;
    },
  ): HookCallback =>
  async (input: any, toolUseID: string | undefined): Promise<{ continue: boolean }> => {
    if (input.hook_event_name === "PostToolUse") {
      // Handle EnterPlanMode tool - notify client of mode change after successful execution
      if (input.tool_name === "EnterPlanMode" && options?.onEnterPlanMode) {
        await options.onEnterPlanMode();
      }

      if (toolUseID) {
        const onPostToolUseHook = toolUseCallbacks[toolUseID]?.onPostToolUseHook;
        if (onPostToolUseHook) {
          await onPostToolUseHook(toolUseID, input.tool_input, input.tool_response);
          delete toolUseCallbacks[toolUseID]; // Cleanup after execution
        } else {
          logger.error(`No onPostToolUseHook found for tool use ID: ${toolUseID}`);
          delete toolUseCallbacks[toolUseID];
        }
      }
    }
    return { continue: true };
  };

/**
 * Creates a PreToolUse hook that checks permissions using the SettingsManager.
 * This runs before the SDK's built-in permission rules, allowing us to enforce
 * our own permission settings for ACP-prefixed tools.
 */
export const createPreToolUseHook =
  (settingsManager: SettingsManager, logger: Logger = console): HookCallback =>
  async (input: any, _toolUseID: string | undefined) => {
    if (input.hook_event_name !== "PreToolUse") {
      return { continue: true };
    }

    const toolName = input.tool_name;
    const toolInput = input.tool_input;

    const permissionCheck = settingsManager.checkPermission(toolName, toolInput);

    if (permissionCheck.decision !== "ask") {
      logger.log(
        `[PreToolUseHook] Tool: ${toolName}, Decision: ${permissionCheck.decision}, Rule: ${permissionCheck.rule}`,
      );
    }

    switch (permissionCheck.decision) {
      case "allow":
        return {
          continue: true,
          hookSpecificOutput: {
            hookEventName: "PreToolUse" as const,
            permissionDecision: "allow" as const,
            permissionDecisionReason: `Allowed by settings rule: ${permissionCheck.rule}`,
          },
        };

      case "deny":
        return {
          continue: true,
          hookSpecificOutput: {
            hookEventName: "PreToolUse" as const,
            permissionDecision: "deny" as const,
            permissionDecisionReason: `Denied by settings rule: ${permissionCheck.rule}`,
          },
        };

      case "ask":
      default:
        // Let the normal permission flow continue
        return { continue: true };
    }
  };
