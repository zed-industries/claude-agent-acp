import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  BashInput,
  FileEditInput,
  FileReadInput,
  FileWriteInput,
  TaskOutputInput,
} from "@anthropic-ai/claude-agent-sdk/sdk-tools.js";
import { z } from "zod";
import { CLAUDE_CONFIG_DIR, ClaudeAcpAgent } from "./acp-agent.js";
import {
  ClientCapabilities,
  ReadTextFileResponse,
  TerminalOutputResponse,
} from "@agentclientprotocol/sdk";
import * as diff from "diff";
import * as path from "node:path";
import * as fs from "node:fs/promises";

import { sleep, unreachable } from "./utils.js";
import { acpToolNames } from "./tools.js";

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

const unqualifiedToolNames = {
  read: "Read",
  edit: "Edit",
  write: "Write",
  bash: "Bash",
  killShell: "KillShell",
  bashOutput: "BashOutput",
};

export function createMcpServer(
  agent: ClaudeAcpAgent,
  sessionId: string,
  clientCapabilities: ClientCapabilities | undefined,
): McpServer {
  /**
   * This checks if a given path is related to internal agent persistence and if the agent should be allowed to read/write from here.
   * We let the agent do normal fs operations on these paths so that it can persist its state.
   * However, we block access to settings files for security reasons.
   */
  function internalPath(file_path: string) {
    return (
      file_path.startsWith(CLAUDE_CONFIG_DIR) &&
      !file_path.startsWith(path.join(CLAUDE_CONFIG_DIR, "settings.json")) &&
      !file_path.startsWith(path.join(CLAUDE_CONFIG_DIR, "session-env"))
    );
  }

  async function readTextFile(input: FileReadInput): Promise<ReadTextFileResponse> {
    if (internalPath(input.file_path)) {
      const content = await fs.readFile(input.file_path, "utf8");

      // eslint-disable-next-line eqeqeq
      if (input.offset != null || input.limit != null) {
        const lines = content.split("\n");

        // Apply offset and limit if provided
        const offset = input.offset ?? 1;
        const limit = input.limit ?? lines.length;

        // Extract the requested lines (offset is 1-based)
        const startIndex = Math.max(0, offset - 1);
        const endIndex = Math.min(lines.length, startIndex + limit);
        const selectedLines = lines.slice(startIndex, endIndex);

        return { content: selectedLines.join("\n") };
      } else {
        return { content };
      }
    }

    return agent.readTextFile({
      sessionId,
      path: input.file_path,
      line: input.offset,
      limit: input.limit,
    });
  }

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

  // Create MCP server
  const server = new McpServer({ name: "acp", version: "1.0.0" }, { capabilities: { tools: {} } });

  if (clientCapabilities?.fs?.writeTextFile) {
    server.registerTool(
      unqualifiedToolNames.write,
      {
        title: unqualifiedToolNames.write,
        description: `Writes a file to the local filesystem..

In sessions with ${acpToolNames.write} always use it instead of Write as it will
allow the user to conveniently review changes.

Usage:
- This tool will overwrite the existing file if there is one at the provided path.
- If this is an existing file, you MUST use the Read tool first to read the file's contents. This tool will fail if you did not read the file first.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.
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
              content: [
                {
                  type: "text",
                  text: "The user has left the building",
                },
              ],
            };
          }
          await writeTextFile(input);

          return {
            content: [
              {
                type: "text",
                text: `The file ${input.file_path} has been updated successfully.`,
              },
            ],
          };
        } catch (error) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "Writing file failed: " + formatErrorMessage(error),
              },
            ],
          };
        }
      },
    );

    server.registerTool(
      unqualifiedToolNames.edit,
      {
        title: unqualifiedToolNames.edit,
        description: `Performs exact string replacements in files.

In sessions with ${acpToolNames.edit} always use it instead of Edit as it will
allow the user to conveniently review changes.

Usage:
- You must use your \`Read\` tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file.
- When editing text from Read tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears.
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
              content: [
                {
                  type: "text",
                  text: "The user has left the building",
                },
              ],
            };
          }

          const readResponse = await readTextFile({
            file_path: input.file_path,
          });

          if (typeof readResponse?.content !== "string") {
            throw new Error(`No file contents for ${input.file_path}.`);
          }

          const { newContent } = replaceAndCalculateLocation(readResponse.content, [
            {
              oldText: input.old_string,
              newText: input.new_string,
              replaceAll: input.replace_all,
            },
          ]);

          const patch = diff.createPatch(input.file_path, readResponse.content, newContent);

          await writeTextFile({ file_path: input.file_path, content: newContent });

          return {
            content: [
              {
                type: "text",
                text: patch,
              },
            ],
          };
        } catch (error) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "Editing file failed: " + formatErrorMessage(error),
              },
            ],
          };
        }
      },
    );
  }

  if (agent.clientCapabilities?.terminal) {
    server.registerTool(
      unqualifiedToolNames.bash,
      {
        title: unqualifiedToolNames.bash,
        description: `Executes a bash command

In sessions with ${acpToolNames.bash} always use it instead of Bash`,
        inputSchema: {
          command: z.string().describe("The command to execute"),
          timeout: z.number().describe(`Optional timeout in milliseconds (max ${2 * 60 * 1000})`),
          description: z.string().optional()
            .describe(`Clear, concise description of what this command does in 5-10 words, in active voice. Examples:
Input: ls
Output: List files in current directory

Input: git status
Output: Show working tree status

Input: npm install
Output: Install package dependencies

Input: mkdir foo
Output: Create directory 'foo'`),
          run_in_background: z
            .boolean()
            .default(false)
            .describe(
              `Set to true to run this command in the background. The tool returns an \`id\` that can be used with the \`${acpToolNames.bashOutput}\` tool to retrieve the current output, or the \`${acpToolNames.killShell}\` tool to stop it early.`,
            ),
        },
      },
      async (input: BashInput, extra) => {
        try {
          const session = agent.sessions[sessionId];
          if (!session) {
            return {
              content: [
                {
                  type: "text",
                  text: "The user has left the building",
                },
              ],
            };
          }

          const toolCallId = extra._meta?.["claudecode/toolUseId"];

          if (typeof toolCallId !== "string") {
            throw new Error("No tool call ID found");
          }

          if (!agent.clientCapabilities?.terminal || !agent.client.createTerminal) {
            throw new Error("unreachable");
          }

          const handle = await agent.client.createTerminal({
            command: input.command,
            env: [{ name: "CLAUDECODE", value: "1" }],
            sessionId,
            outputByteLimit: 32_000,
          });

          await agent.client.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId,
              status: "in_progress",
              title: input.description,
              content: [{ type: "terminal", terminalId: handle.id }],
            },
          });

          const abortPromise = new Promise((resolve) => {
            if (extra.signal.aborted) {
              resolve(null);
            } else {
              extra.signal.addEventListener("abort", () => {
                resolve(null);
              });
            }
          });

          const statusPromise = Promise.race([
            handle.waitForExit().then((exitStatus) => ({ status: "exited" as const, exitStatus })),
            abortPromise.then(() => ({ status: "aborted" as const, exitStatus: null })),
            sleep(input.timeout ?? 2 * 60 * 1000).then(async () => {
              if (agent.backgroundTerminals[handle.id]?.status === "started") {
                await handle.kill();
              }
              return { status: "timedOut" as const, exitStatus: null };
            }),
          ]);

          if (input.run_in_background) {
            agent.backgroundTerminals[handle.id] = {
              handle,
              lastOutput: null,
              status: "started",
            };

            statusPromise.then(async ({ status, exitStatus }) => {
              const bgTerm = agent.backgroundTerminals[handle.id];

              if (bgTerm.status !== "started") {
                return;
              }

              const currentOutput = await handle.currentOutput();

              agent.backgroundTerminals[handle.id] = {
                status,
                pendingOutput: {
                  ...currentOutput,
                  output: stripCommonPrefix(bgTerm.lastOutput?.output ?? "", currentOutput.output),
                  exitStatus: exitStatus ?? currentOutput.exitStatus,
                },
              };

              return handle.release();
            });

            return {
              content: [
                {
                  type: "text",
                  text: `Command started in background with id: ${handle.id}`,
                },
              ],
            };
          }

          await using terminal = handle;

          const { status } = await statusPromise;

          if (status === "aborted") {
            return {
              content: [{ type: "text", text: "Tool cancelled by user" }],
            };
          }

          const output = await terminal.currentOutput();

          return {
            content: [{ type: "text", text: toolCommandOutput(status, output) }],
          };
        } catch (error) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "Running bash command failed: " + formatErrorMessage(error),
              },
            ],
          };
        }
      },
    );

    server.registerTool(
      unqualifiedToolNames.bashOutput,
      {
        title: unqualifiedToolNames.bashOutput,
        description: `- Retrieves output from a running or completed background bash shell
- Takes a bash_id parameter identifying the shell
- Always returns only new output since the last check
- Returns stdout and stderr output along with shell status
- Use this tool when you need to monitor or check the output of a long-running shell

In sessions with ${acpToolNames.bashOutput} always use it for output from Bash commands instead of TaskOutput.`,
        inputSchema: {
          task_id: z
            .string()
            .describe(
              `The id of the background bash command as returned by \`${acpToolNames.bash}\``,
            ),
          block: z.boolean().describe("Whether to wait for completion"),
          timeout: z.number().describe("Max wait time in ms"),
        },
      },
      async (input: TaskOutputInput) => {
        try {
          const bgTerm = agent.backgroundTerminals[input.task_id];

          if (!bgTerm) {
            throw new Error(`Unknown shell ${input.task_id}`);
          }

          if (input.block && bgTerm.status === "started") {
            const statusPromise = Promise.race([
              bgTerm.handle
                .waitForExit()
                .then((exitStatus) => ({ status: "exited" as const, exitStatus })),
              sleep(input.timeout ?? 2 * 60 * 1000).then(async () => {
                if (bgTerm.status === "started") {
                  await bgTerm.handle.kill();
                }
                return { status: "timedOut" as const, exitStatus: null };
              }),
            ]);

            const { status, exitStatus } = await statusPromise;
            const currentOutput = await bgTerm.handle.currentOutput();
            const strippedOutput = stripCommonPrefix(
              bgTerm.lastOutput?.output ?? "",
              currentOutput.output,
            );

            agent.backgroundTerminals[input.task_id] = {
              status,
              pendingOutput: {
                ...currentOutput,
                output: strippedOutput,
                exitStatus: exitStatus ?? currentOutput.exitStatus,
              },
            };

            await bgTerm.handle.release();

            return {
              content: [
                {
                  type: "text",
                  text: toolCommandOutput(status, {
                    ...currentOutput,
                    output: strippedOutput,
                    exitStatus: exitStatus ?? currentOutput.exitStatus,
                  }),
                },
              ],
            };
          }

          if (bgTerm.status === "started") {
            const newOutput = await bgTerm.handle.currentOutput();
            const strippedOutput = stripCommonPrefix(
              bgTerm.lastOutput?.output ?? "",
              newOutput.output,
            );
            bgTerm.lastOutput = newOutput;

            return {
              content: [
                {
                  type: "text",
                  text: toolCommandOutput(bgTerm.status, {
                    ...newOutput,
                    output: strippedOutput,
                  }),
                },
              ],
            };
          } else {
            return {
              content: [
                {
                  type: "text",
                  text: toolCommandOutput(bgTerm.status, bgTerm.pendingOutput),
                },
              ],
            };
          }
        } catch (error) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "Retrieving bash output failed: " + formatErrorMessage(error),
              },
            ],
          };
        }
      },
    );

    server.registerTool(
      unqualifiedToolNames.killShell,
      {
        title: unqualifiedToolNames.killShell,
        description: `- Kills a running background bash shell by its ID
- Takes a shell_id parameter identifying the shell to kill
- Returns a success or failure status
- Use this tool when you need to terminate a long-running shell

In sessions with ${acpToolNames.killShell} always use it instead of KillShell.`,
        inputSchema: {
          shell_id: z
            .string()
            .describe(
              `The id of the background bash command as returned by \`${acpToolNames.bash}\``,
            ),
        },
      },
      async (input) => {
        try {
          const bgTerm = agent.backgroundTerminals[input.shell_id];

          if (!bgTerm) {
            throw new Error(`Unknown shell ${input.shell_id}`);
          }

          switch (bgTerm.status) {
            case "started": {
              await bgTerm.handle.kill();
              const currentOutput = await bgTerm.handle.currentOutput();
              agent.backgroundTerminals[bgTerm.handle.id] = {
                status: "killed",
                pendingOutput: {
                  ...currentOutput,
                  output: stripCommonPrefix(bgTerm.lastOutput?.output ?? "", currentOutput.output),
                },
              };
              await bgTerm.handle.release();

              return {
                content: [{ type: "text", text: "Command killed successfully." }],
              };
            }
            case "aborted":
              return {
                content: [{ type: "text", text: "Command aborted by user." }],
              };
            case "exited":
              return {
                content: [{ type: "text", text: "Command had already exited." }],
              };
            case "killed":
              return {
                content: [{ type: "text", text: "Command was already killed." }],
              };
            case "timedOut":
              return {
                content: [{ type: "text", text: "Command killed by timeout." }],
              };
            default: {
              unreachable(bgTerm);
              throw new Error("Unexpected background terminal status");
            }
          }
        } catch (error) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "Killing shell failed: " + formatErrorMessage(error),
              },
            ],
          };
        }
      },
    );
  }

  return server;
}

function stripCommonPrefix(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) {
    i++;
  }
  return b.slice(i);
}

function toolCommandOutput(
  status: "started" | "aborted" | "exited" | "killed" | "timedOut",
  output: TerminalOutputResponse,
): string {
  const { exitStatus, output: commandOutput, truncated } = output;

  let toolOutput = "";

  switch (status) {
    case "started":
    case "exited": {
      if (exitStatus && (exitStatus.exitCode ?? null) === null) {
        toolOutput += `Interrupted by the user. `;
      }
      break;
    }
    case "killed":
      toolOutput += `Killed. `;
      break;
    case "timedOut":
      toolOutput += `Timed out. `;
      break;
    case "aborted":
      break;
    default: {
      const unreachable: never = status;
      return unreachable;
    }
  }

  if (exitStatus) {
    if (typeof exitStatus.exitCode === "number") {
      toolOutput += `Exited with code ${exitStatus.exitCode}.`;
    }

    if (typeof exitStatus.signal === "string") {
      toolOutput += `Signal \`${exitStatus.signal}\`. `;
    }

    toolOutput += "Final output:\n\n";
  } else {
    toolOutput += "New output:\n\n";
  }

  toolOutput += commandOutput;

  if (truncated) {
    toolOutput += `\n\nCommand output was too long, so it was truncated to ${commandOutput.length} bytes.`;
  }

  return toolOutput;
}

/**
 * Replace text in a file and calculate the line numbers where the edits occurred.
 *
 * @param fileContent - The full file content
 * @param edits - Array of edit operations to apply sequentially
 * @returns the new content and the line numbers where replacements occurred in the final content
 */
export function replaceAndCalculateLocation(
  fileContent: string,
  edits: Array<{
    oldText: string;
    newText: string;
    replaceAll?: boolean;
  }>,
): { newContent: string; lineNumbers: number[] } {
  let currentContent = fileContent;

  // Use unique markers to track where replacements happen
  const markerPrefix = `__REPLACE_MARKER_${Math.random().toString(36).substr(2, 9)}_`;
  let markerCounter = 0;
  const markers: string[] = [];

  // Apply edits sequentially, inserting markers at replacement positions
  for (const edit of edits) {
    // Skip empty oldText
    if (edit.oldText === "") {
      throw new Error(`The provided \`old_string\` is empty.\n\nNo edits were applied.`);
    }

    if (edit.replaceAll) {
      // Replace all occurrences with marker + newText
      const parts: string[] = [];
      let lastIndex = 0;
      let searchIndex = 0;

      while (true) {
        const index = currentContent.indexOf(edit.oldText, searchIndex);
        if (index === -1) {
          if (searchIndex === 0) {
            throw new Error(
              `The provided \`old_string\` does not appear in the file: "${edit.oldText}".\n\nNo edits were applied.`,
            );
          }
          break;
        }

        // Add content before the match
        parts.push(currentContent.substring(lastIndex, index));

        // Add marker and replacement
        const marker = `${markerPrefix}${markerCounter++}__`;
        markers.push(marker);
        parts.push(marker + edit.newText);

        lastIndex = index + edit.oldText.length;
        searchIndex = lastIndex;
      }

      // Add remaining content
      parts.push(currentContent.substring(lastIndex));
      currentContent = parts.join("");
    } else {
      // Replace first occurrence only
      const index = currentContent.indexOf(edit.oldText);
      if (index === -1) {
        throw new Error(
          `The provided \`old_string\` does not appear in the file: "${edit.oldText}".\n\nNo edits were applied.`,
        );
      } else {
        const marker = `${markerPrefix}${markerCounter++}__`;
        markers.push(marker);
        currentContent =
          currentContent.substring(0, index) +
          marker +
          edit.newText +
          currentContent.substring(index + edit.oldText.length);
      }
    }
  }

  // Find line numbers where markers appear in the content
  const lineNumbers: number[] = [];
  for (const marker of markers) {
    const index = currentContent.indexOf(marker);
    if (index !== -1) {
      const lineNumber = Math.max(
        0,
        currentContent.substring(0, index).split(/\r\n|\r|\n/).length - 1,
      );
      lineNumbers.push(lineNumber);
    }
  }

  // Remove all markers from the final content
  let finalContent = currentContent;
  for (const marker of markers) {
    finalContent = finalContent.replace(marker, "");
  }

  // Dedupe and sort line numbers
  const uniqueLineNumbers = [...new Set(lineNumbers)].sort();

  return { newContent: finalContent, lineNumbers: uniqueLineNumbers };
}
