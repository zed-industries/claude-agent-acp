import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FileEditInput, FileReadInput, FileWriteInput } from "@anthropic-ai/claude-agent-sdk/sdk-tools.js";
import { z } from "zod";
import { CLAUDE_CONFIG_DIR, ClaudeAcpAgent } from "./acp-agent.js";
import { ClientCapabilities, ReadTextFileResponse } from "@agentclientprotocol/sdk";
import * as diff from "diff";
import * as path from "node:path";
import * as fs from "node:fs/promises";

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * Checks if a given path is an internal agent persistence path.
 * We let the agent do normal fs operations on these paths so that it can persist its state.
 * However, we block access to settings files for security reasons.
 */
function internalPath(filePath: string): boolean {
  return (
    filePath.startsWith(CLAUDE_CONFIG_DIR) &&
    !filePath.startsWith(path.join(CLAUDE_CONFIG_DIR, "settings.json")) &&
    !filePath.startsWith(path.join(CLAUDE_CONFIG_DIR, "session-env"))
  );
}

const ACP_TOOL_NAME_PREFIX = "mcp__acp__";

export const acpToolNames = {
  edit: ACP_TOOL_NAME_PREFIX + "Edit",
  write: ACP_TOOL_NAME_PREFIX + "Write",
};

export interface McpServerResult {
  server: McpServer;
  /** Call when Claude reads a file (via PostToolUse on the built-in Read tool).
   *  Caches the file content so Edit/Write can detect stale edits. */
  onFileRead: (filePath: string) => Promise<void>;
}

/**
 * Creates an in-process MCP server that routes Write/Edit operations through Zed's ACP
 * filesystem APIs, enabling the Review Changes diff UI.
 *
 * Only Write and Edit are routed through ACP — Read uses Claude's built-in tool directly.
 * Internal paths (~/.claude/...) bypass ACP for direct filesystem access.
 * No custom permissions engine — relies on Claude Code's built-in canUseTool.
 * No Bash/terminal tools — those work fine with built-in tools + PostToolUse hooks.
 */
export function createMcpServer(
  agent: ClaudeAcpAgent,
  sessionId: string,
  _clientCapabilities: ClientCapabilities | undefined,
): McpServerResult {
  /**
   * Tracks the known content of each file at the time it was last read or written.
   * Used to enforce two guards:
   *   1. File must have been read before editing (key must exist)
   *   2. File must not have changed since last read (content must match)
   */
  const fileContentCache = new Map<string, string>();

  /** Read a file, routing through ACP for editor-open files or direct fs for internal paths. */
  async function readTextFile(input: FileReadInput): Promise<ReadTextFileResponse> {
    if (internalPath(input.file_path)) {
      const content = await fs.readFile(input.file_path, "utf8");

      if (input.offset != null || input.limit != null) {
        const lines = content.split("\n");
        const offset = input.offset ?? 1;
        const limit = input.limit ?? lines.length;
        const startIndex = Math.max(0, offset - 1);
        const endIndex = Math.min(lines.length, startIndex + limit);
        return { content: lines.slice(startIndex, endIndex).join("\n") };
      }
      return { content };
    }

    return agent.readTextFile({
      sessionId,
      path: input.file_path,
      line: input.offset,
      limit: input.limit,
    });
  }

  /** Write a file, routing through ACP (triggers Zed's Review Changes UI) or direct fs for internal paths. */
  async function writeTextFile(input: FileWriteInput): Promise<void> {
    if (internalPath(input.file_path)) {
      await fs.writeFile(input.file_path, input.content, "utf8");
    } else {
      await agent.writeTextFile({
        sessionId,
        path: input.file_path,
        content: input.content,
      });
    }
  }

  /**
   * Called when Claude reads a file (via PostToolUse hook on the built-in Read tool).
   * Reads the raw file content via ACP and caches it so Edit/Write can detect changes.
   */
  async function onFileRead(filePath: string): Promise<void> {
    try {
      const response = await readTextFile({ file_path: filePath });
      if (typeof response?.content === "string") {
        fileContentCache.set(filePath, response.content);
      }
    } catch {
      // Still mark as read even if caching fails — allows editing, just skips staleness check
      fileContentCache.set(filePath, "");
    }
  }

  /**
   * Checks that a file has been read and hasn't changed since.
   * Throws descriptive errors that guide Claude to read the file first.
   */
  function assertFileReadAndCurrent(filePath: string, currentContent: string): void {
    if (!fileContentCache.has(filePath)) {
      throw new Error(
        `You must read ${filePath} before editing it. ` +
          `Use the Read tool first to read the file's contents.`,
      );
    }

    const cachedContent = fileContentCache.get(filePath)!;
    // Skip staleness check if the cache entry is empty (read tracking only, no content)
    if (cachedContent && cachedContent !== currentContent) {
      fileContentCache.delete(filePath);
      throw new Error(
        `The file ${filePath} has been modified since you last read it. ` +
          `Please read it again before editing.`,
      );
    }
  }

  const server = new McpServer({ name: "acp", version: "1.0.0" }, { capabilities: { tools: {} } });

  // --- Write Tool ---
  server.registerTool(
    "Write",
    {
      title: "Write",
      description: `Writes content to a file through Zed's editor for review.

In sessions with ${acpToolNames.write}, ALWAYS use this instead of the built-in Write tool
as it allows the user to review changes in Zed's diff viewer.

Usage:
- This tool will overwrite the existing file if there is one at the provided path.
- If this is an existing file, you MUST use the Read tool first to read the file's contents. This tool will fail if you did not read the file first.
- Prefer the ${acpToolNames.edit} tool for modifying existing files — it only sends the diff. Only use this tool to create new files or for complete rewrites.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- NEVER create documentation files (*.md) or README files unless explicitly requested by the User.
- Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked.`,
      inputSchema: {
        file_path: z
          .string()
          .describe("The absolute path to the file to write (must be absolute, not relative)"),
        content: z.string().describe("The content to write to the file"),
      },
      annotations: {
        title: "Write file",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: false,
      },
    },
    async (input: FileWriteInput) => {
      try {
        const session = agent.sessions[sessionId];
        if (!session) {
          return {
            content: [{ type: "text" as const, text: "Session not found" }],
            isError: true,
          };
        }

        // For existing files, enforce read-before-write
        try {
          const existing = await readTextFile({ file_path: input.file_path });
          if (typeof existing?.content === "string") {
            assertFileReadAndCurrent(input.file_path, existing.content);
          }
        } catch (e) {
          // If the file doesn't exist yet (new file), skip the check
          if (e instanceof Error && e.message.includes("must read")) throw e;
          if (e instanceof Error && e.message.includes("has been modified")) throw e;
        }

        await writeTextFile(input);
        // Update cache so subsequent edits see this as the known content
        fileContentCache.set(input.file_path, input.content);

        return {
          content: [
            {
              type: "text" as const,
              text: `The file ${input.file_path} has been updated successfully.`,
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: "Writing file failed: " + formatErrorMessage(error),
            },
          ],
        };
      }
    },
  );

  // --- Edit Tool ---
  server.registerTool(
    "Edit",
    {
      title: "Edit",
      description: `Performs exact string replacements in files through Zed's editor for review.

In sessions with ${acpToolNames.edit}, ALWAYS use this instead of the built-in Edit tool
as it allows the user to review changes in Zed's diff viewer.

Usage:
- You must use the Read tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file.
- When editing text from Read tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.
- The edit will FAIL if \`old_string\` is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use \`replace_all\` to change every instance of \`old_string\`.
- Use \`replace_all\` for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.`,
      inputSchema: {
        file_path: z.string().describe("The absolute path to the file to modify"),
        old_string: z.string().describe("The text to replace"),
        new_string: z
          .string()
          .describe("The text to replace it with (must be different from old_string)"),
        replace_all: z
          .boolean()
          .default(false)
          .optional()
          .describe("Replace all occurrences of old_string (default false)"),
      },
      annotations: {
        title: "Edit file",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: false,
      },
    },
    async (input: FileEditInput) => {
      try {
        const session = agent.sessions[sessionId];
        if (!session) {
          return {
            content: [{ type: "text" as const, text: "Session not found" }],
            isError: true,
          };
        }

        const readResponse = await readTextFile({ file_path: input.file_path });

        if (typeof readResponse?.content !== "string") {
          throw new Error(`No file contents for ${input.file_path}.`);
        }

        // Enforce read-before-edit and staleness check
        assertFileReadAndCurrent(input.file_path, readResponse.content);

        const { newContent, patch } = applyEdit(
          readResponse.content,
          input.file_path,
          input.old_string,
          input.new_string,
          input.replace_all,
        );

        await writeTextFile({ file_path: input.file_path, content: newContent });
        // Update cache so subsequent edits see the post-edit content as current
        fileContentCache.set(input.file_path, newContent);

        return {
          content: [{ type: "text" as const, text: patch }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: "Editing file failed: " + formatErrorMessage(error),
            },
          ],
        };
      }
    },
  );

  return { server, onFileRead };
}

/**
 * Apply a string replacement edit and return the new content plus a unified diff.
 */
function applyEdit(
  fileContent: string,
  filePath: string,
  oldString: string,
  newString: string,
  replaceAll?: boolean,
): { newContent: string; patch: string } {
  if (oldString === "") {
    throw new Error("The provided `old_string` is empty.\n\nNo edits were applied.");
  }

  let newContent: string;

  if (replaceAll) {
    if (!fileContent.includes(oldString)) {
      throw new Error(
        `The provided \`old_string\` does not appear in the file: "${oldString}".\n\nNo edits were applied.`,
      );
    }
    newContent = fileContent.split(oldString).join(newString);
  } else {
    const index = fileContent.indexOf(oldString);
    if (index === -1) {
      throw new Error(
        `The provided \`old_string\` does not appear in the file: "${oldString}".\n\nNo edits were applied.`,
      );
    }
    // Check uniqueness
    const secondIndex = fileContent.indexOf(oldString, index + oldString.length);
    if (secondIndex !== -1) {
      throw new Error(
        `The provided \`old_string\` is not unique in the file (found multiple occurrences). ` +
          `Either provide a larger string with more surrounding context to make it unique, ` +
          `or use \`replace_all\` to change every instance.`,
      );
    }
    newContent =
      fileContent.substring(0, index) + newString + fileContent.substring(index + oldString.length);
  }

  const patch = diff.createPatch(filePath, fileContent, newContent);

  return { newContent, patch };
}
