// A pushable async iterable: allows you to push items and consume them with for-await.

import { Readable, Writable } from "node:stream";
import { WritableStream, ReadableStream } from "node:stream/web";
import { readFileSync } from "node:fs";
import { Logger } from "./acp-agent.js";
import { ClaudeCodeSettings, getManagedSettingsPath } from "./settings.js";

type NodeWriteError = Error & { code?: string };

// Useful for bridging push-based and async-iterator-based code.
export class Pushable<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private resolvers: ((value: IteratorResult<T>) => void)[] = [];
  private done = false;

  push(item: T) {
    if (this.resolvers.length > 0) {
      const resolve = this.resolvers.shift()!;
      resolve({ value: item, done: false });
    } else {
      this.queue.push(item);
    }
  }

  end() {
    this.done = true;
    while (this.resolvers.length > 0) {
      const resolve = this.resolvers.shift()!;
      resolve({ value: undefined as any, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.queue.length > 0) {
          const value = this.queue.shift()!;
          return Promise.resolve({ value, done: false });
        }
        if (this.done) {
          return Promise.resolve({ value: undefined as any, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.resolvers.push(resolve);
        });
      },
    };
  }
}

function isBrokenPipeError(error: unknown): error is NodeWriteError {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeWriteError).code === "EPIPE"
  );
}

// Helper to convert Node.js streams to Web Streams
export function nodeToWebWritable(nodeStream: Writable): WritableStream<Uint8Array> {
  let terminalError: Error | null = null;
  let brokenPipe = false;

  nodeStream.on("error", (error) => {
    if (isBrokenPipeError(error)) {
      brokenPipe = true;
      return;
    }

    terminalError = error;
  });

  return new WritableStream<Uint8Array>({
    write(chunk) {
      if (brokenPipe) {
        return Promise.resolve();
      }

      if (terminalError) {
        return Promise.reject(terminalError);
      }

      return new Promise<void>((resolve, reject) => {
        nodeStream.write(Buffer.from(chunk), (err) => {
          if (!err) {
            resolve();
            return;
          }

          if (isBrokenPipeError(err)) {
            brokenPipe = true;
            resolve();
            return;
          }

          terminalError = err;
          reject(err);
        });
      });
    },
  });
}

export function nodeToWebReadable(nodeStream: Readable): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      nodeStream.on("data", (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk));
      });
      nodeStream.on("end", () => controller.close());
      nodeStream.on("error", (err) => controller.error(err));
    },
  });
}

export function unreachable(value: never, logger: Logger = console) {
  let valueAsString;
  try {
    valueAsString = JSON.stringify(value);
  } catch {
    valueAsString = value;
  }
  logger.error(`Unexpected case: ${valueAsString}`);
}

export function sleep(time: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, time));
}

export function loadManagedSettings(): ClaudeCodeSettings | null {
  try {
    return JSON.parse(readFileSync(getManagedSettingsPath(), "utf8")) as ClaudeCodeSettings;
  } catch {
    return null;
  }
}

export function applyEnvironmentSettings(settings: ClaudeCodeSettings): void {
  if (settings.env) {
    for (const [key, value] of Object.entries(settings.env)) {
      process.env[key] = value;
    }
  }
}
