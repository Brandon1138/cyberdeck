/**
 * Newline-delimited JSON decoder for Claude's `--output-format stream-json` stdout.
 *
 * Deliberately schema-free. Newline-delimited framing is what the CLI documents, but the *fields*
 * inside each frame are not documented by its help and B1 recorded the frame schema as unverified
 * runtime behaviour. Decoding therefore stops at "this line was valid JSON" and hands the value on
 * opaquely; nothing here names or interprets a provider event type. Inventing that schema is what
 * this module exists to avoid.
 */
export type ClaudeStreamFrame =
  | { kind: "json"; value: unknown }
  | { kind: "malformed"; raw: string; message: string };

export class ClaudeStreamDecoder {
  private pending = Buffer.alloc(0);

  /** Decode whatever complete lines this chunk completes. Partial trailing data is buffered. */
  push(chunk: Buffer): ClaudeStreamFrame[] {
    this.pending = Buffer.concat([this.pending, chunk]);
    const frames: ClaudeStreamFrame[] = [];

    for (;;) {
      const newlineIndex = this.pending.indexOf(0x0a);
      if (newlineIndex === -1) break;

      const line = this.pending.subarray(0, newlineIndex);
      this.pending = this.pending.subarray(newlineIndex + 1);
      const frame = decodeLine(line.toString("utf8"));
      if (frame !== undefined) frames.push(frame);
    }

    return frames;
  }

  /**
   * Decode any unterminated trailing bytes at end of stream. A stream that ends mid-frame is
   * reported as malformed rather than silently dropped, so a truncated run cannot be mistaken for a
   * clean one.
   */
  flush(): ClaudeStreamFrame[] {
    if (this.pending.length === 0) return [];
    const raw = this.pending.toString("utf8");
    this.pending = Buffer.alloc(0);
    const frame = decodeLine(raw);
    return frame === undefined ? [] : [frame];
  }
}

function decodeLine(raw: string): ClaudeStreamFrame | undefined {
  const trimmed = raw.replace(/\r$/, "");
  if (trimmed.trim() === "") return undefined;
  try {
    return { kind: "json", value: JSON.parse(trimmed) };
  } catch (error) {
    return {
      kind: "malformed",
      raw: trimmed,
      message: error instanceof Error ? error.message : "Invalid JSON frame",
    };
  }
}
