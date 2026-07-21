export class AppServerProtocolError extends Error {
  constructor(
    readonly code:
      | "MALFORMED_FRAME"
      | "FRAME_TOO_LARGE"
      | "OUTPUT_LIMIT_EXCEEDED"
      | "PROTOCOL_MISMATCH"
      | "REQUEST_TIMEOUT"
      | "DISCONNECTED",
    message: string,
  ) {
    super(message);
    this.name = "AppServerProtocolError";
  }
}

export interface AppServerJsonDecoderOptions {
  maxFrameBytes?: number;
}

/** Newline-delimited App Server RPC decoder with a hard per-frame bound. */
export class AppServerJsonDecoder {
  private pending = Buffer.alloc(0);
  private readonly maxFrameBytes: number;

  constructor(options: AppServerJsonDecoderOptions = {}) {
    this.maxFrameBytes = options.maxFrameBytes ?? 256 * 1024;
    if (!Number.isSafeInteger(this.maxFrameBytes) || this.maxFrameBytes <= 0) {
      throw new Error("maxFrameBytes must be a positive safe integer");
    }
  }

  push(chunk: Buffer): Array<Record<string, unknown>> {
    this.pending = Buffer.concat([this.pending, chunk]);
    if (this.pending.length > this.maxFrameBytes && this.pending.indexOf(0x0a) === -1) {
      throw new AppServerProtocolError(
        "FRAME_TOO_LARGE",
        `App Server frame exceeded the bounded ${this.maxFrameBytes}-byte limit`,
      );
    }

    const frames: Array<Record<string, unknown>> = [];
    for (;;) {
      const newline = this.pending.indexOf(0x0a);
      if (newline === -1) break;
      if (newline > this.maxFrameBytes) {
        throw new AppServerProtocolError(
          "FRAME_TOO_LARGE",
          `App Server frame exceeded the bounded ${this.maxFrameBytes}-byte limit`,
        );
      }
      const raw = this.pending.subarray(0, newline).toString("utf8").replace(/\r$/, "");
      this.pending = this.pending.subarray(newline + 1);
      if (raw.trim() === "") continue;
      let decoded: unknown;
      try {
        decoded = JSON.parse(raw);
      } catch (error) {
        throw new AppServerProtocolError(
          "MALFORMED_FRAME",
          `Malformed App Server JSON-RPC frame: ${error instanceof Error ? error.message : "invalid JSON"}`,
        );
      }
      if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
        throw new AppServerProtocolError("MALFORMED_FRAME", "Malformed App Server frame: expected object");
      }
      const frame = decoded as Record<string, unknown>;
      // Codex 0.144.6 accepts JSON-RPC 2.0 requests but omits the `jsonrpc` member on responses and
      // notifications. Accept that observed wire shape; if a server explicitly declares a version,
      // it must still be 2.0 so a genuinely incompatible protocol fails closed.
      if (frame.jsonrpc !== undefined && frame.jsonrpc !== "2.0") {
        throw new AppServerProtocolError(
          "PROTOCOL_MISMATCH",
          "App Server frame declared an incompatible JSON-RPC version",
        );
      }
      frames.push(frame);
    }
    return frames;
  }

  flush(): void {
    if (this.pending.length === 0) return;
    const bytes = this.pending.length;
    this.pending = Buffer.alloc(0);
    throw new AppServerProtocolError(
      "MALFORMED_FRAME",
      `App Server disconnected with a partial ${bytes}-byte frame`,
    );
  }
}

export function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AppServerProtocolError("PROTOCOL_MISMATCH", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AppServerProtocolError("PROTOCOL_MISMATCH", `${label} must be a non-empty string`);
  }
  return value;
}
