import { describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import { nodeToWebWritable } from "../utils.js";

describe("nodeToWebWritable", () => {
  it("treats EPIPE as a closed downstream", async () => {
    class EpipeWritable extends Writable {
      override _write(_chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void) {
        const error = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });

        this.emit("error", error);
        callback(error);
      }
    }

    const writer = nodeToWebWritable(new EpipeWritable()).getWriter();

    await expect(writer.write(new Uint8Array([1, 2, 3]))).resolves.toBeUndefined();
    await expect(writer.write(new Uint8Array([4, 5, 6]))).resolves.toBeUndefined();
  });

  it("rejects non-EPIPE write failures", async () => {
    class ResetWritable extends Writable {
      override _write(_chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void) {
        const error = Object.assign(new Error("write ECONNRESET"), { code: "ECONNRESET" });

        this.emit("error", error);
        callback(error);
      }
    }

    const writer = nodeToWebWritable(new ResetWritable()).getWriter();

    await expect(writer.write(new Uint8Array([1, 2, 3]))).rejects.toThrow("write ECONNRESET");
  });
});
