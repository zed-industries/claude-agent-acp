#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { appendFileSync, readSync, writeSync } from "node:fs";

const sessionId = "fake-session";
const logPath = process.env.FAKE_CLAUDE_CLI_LOG_PATH;

let firstUser = null;
let secondUser = null;
let interrupted = false;
let scriptedTransferSent = false;

function log(message, payload) {
  if (!logPath) {
    return;
  }

  appendFileSync(
    logPath,
    `${new Date().toISOString()} ${message}${payload ? ` ${JSON.stringify(payload)}` : ""}\n`,
  );
}

log("started", { argv: process.argv.slice(2) });

function send(message) {
  log("send", message);
  writeSync(1, `${JSON.stringify(message)}\n`);
}

function controlSuccess(requestId, response = {}) {
  send({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: requestId,
      response,
    },
  });
}

function replayUser(userMessage) {
  return {
    type: "user",
    message: userMessage.message,
    parent_tool_use_id: null,
    uuid: userMessage.uuid,
    session_id: sessionId,
    isReplay: true,
  };
}

function buildResult({
  stopReason = null,
  inputTokens = 0,
  outputTokens = 0,
  cachedReadTokens = 0,
  cachedWriteTokens = 0,
}) {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 0,
    duration_api_ms: 0,
    num_turns: 1,
    result: "",
    stop_reason: stopReason,
    total_cost_usd: 0,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_input_tokens: cachedReadTokens,
      cache_creation_input_tokens: cachedWriteTokens,
    },
    modelUsage: {
      default: {
        inputTokens,
        outputTokens,
        cacheReadInputTokens: cachedReadTokens,
        cacheCreationInputTokens: cachedWriteTokens,
        webSearchRequests: 0,
        costUSD: 0,
        contextWindow: 200000,
        maxOutputTokens: 8192,
      },
    },
    permission_denials: [],
    uuid: randomUUID(),
    session_id: sessionId,
  };
}

function maybeEmitInterruptedTurnTransfer() {
  if (!interrupted || !secondUser || scriptedTransferSent) {
    return;
  }

  scriptedTransferSent = true;
  log("emit-transfer");

  send(buildResult({ inputTokens: 11, outputTokens: 7 }));
  send(replayUser(secondUser));
  send({
    type: "system",
    subtype: "session_state_changed",
    state: "idle",
    uuid: randomUUID(),
    session_id: sessionId,
  });

  send({
    type: "system",
    subtype: "local_command_output",
    content: "actual second prompt output",
    uuid: randomUUID(),
    session_id: sessionId,
  });
  send(buildResult({ inputTokens: 3, outputTokens: 5 }));
  send({
    type: "system",
    subtype: "session_state_changed",
    state: "idle",
    uuid: randomUUID(),
    session_id: sessionId,
  });
}

function handleMessage(message) {
  log("recv", message);

  if (message.type === "control_request") {
    switch (message.request.subtype) {
      case "initialize":
        controlSuccess(message.request_id, {
          commands: [],
          agents: [],
          output_style: "default",
          available_output_styles: ["default"],
          models: [{ value: "default", displayName: "Default", description: "Fake model" }],
          account: {},
        });
        send({
          type: "system",
          subtype: "init",
          uuid: randomUUID(),
          session_id: sessionId,
        });
        return;
      case "interrupt":
        interrupted = true;
        controlSuccess(message.request_id, {});
        maybeEmitInterruptedTurnTransfer();
        return;
      default:
        controlSuccess(message.request_id, {});
        return;
    }
  }

  if (message.type !== "user") {
    return;
  }

  if (!firstUser) {
    firstUser = message;
    send(replayUser(message));
    return;
  }

  if (!secondUser) {
    secondUser = message;
    maybeEmitInterruptedTurnTransfer();
  }
}

const chunk = Buffer.alloc(4096);
let buffered = "";

while (true) {
  const bytesRead = readSync(0, chunk, 0, chunk.length, null);
  if (bytesRead === 0) {
    log("stdin-ended");
    break;
  }

  buffered += chunk.toString("utf8", 0, bytesRead);

  while (true) {
    const newlineIndex = buffered.indexOf("\n");
    if (newlineIndex === -1) {
      break;
    }

    const line = buffered.slice(0, newlineIndex).trim();
    buffered = buffered.slice(newlineIndex + 1);

    if (!line) {
      continue;
    }

    handleMessage(JSON.parse(line));
  }
}
