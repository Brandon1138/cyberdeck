import type { z } from "zod";
import type { ProtocolErrorFrame } from "./frames.js";

export function encodeFrame(frame: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(frame)}\n`, "utf8");
}

export class JsonlDecoder<T> {
  private pending = Buffer.alloc(0);

  constructor(private readonly schema: z.ZodType<T>) {}

  push(chunk: Buffer): Array<T | ProtocolErrorFrame> {
    this.pending = Buffer.concat([this.pending, chunk]);
    const decoded: Array<T | ProtocolErrorFrame> = [];

    for (;;) {
      const newlineIndex = this.pending.indexOf(0x0a);
      if (newlineIndex === -1) {
        break;
      }

      const line = this.pending.subarray(0, newlineIndex);
      this.pending = this.pending.subarray(newlineIndex + 1);
      if (line.length === 0) {
        continue;
      }

      try {
        decoded.push(this.schema.parse(JSON.parse(line.toString("utf8"))));
      } catch (error) {
        decoded.push({
          type: "protocol-error",
          code: "INVALID_FRAME",
          message: error instanceof Error ? error.message : "Invalid JSONL frame",
        });
      }
    }

    return decoded;
  }
}
