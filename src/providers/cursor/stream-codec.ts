/** Cursor documents newline-delimited `stream-json`, but not its frame field schema. */
export type CursorStreamFrame =
  | { kind: "json"; value: unknown }
  | { kind: "malformed"; raw: string; message: string };

export class CursorStreamDecoder {
  private pending = Buffer.alloc(0);

  push(chunk: Buffer): CursorStreamFrame[] {
    this.pending = Buffer.concat([this.pending, chunk]);
    const frames: CursorStreamFrame[] = [];
    for (;;) {
      const newline = this.pending.indexOf(0x0a);
      if (newline === -1) break;
      const line = this.pending.subarray(0, newline).toString("utf8");
      this.pending = this.pending.subarray(newline + 1);
      const decoded = decodeLine(line);
      if (decoded !== undefined) frames.push(decoded);
    }
    return frames;
  }

  flush(): CursorStreamFrame[] {
    if (this.pending.length === 0) return [];
    const line = this.pending.toString("utf8");
    this.pending = Buffer.alloc(0);
    const decoded = decodeLine(line);
    return decoded === undefined ? [] : [decoded];
  }
}

function decodeLine(raw: string): CursorStreamFrame | undefined {
  const normalized = raw.replace(/\r$/, "");
  if (normalized.trim() === "") return undefined;
  try {
    return { kind: "json", value: JSON.parse(normalized) };
  } catch (error) {
    return {
      kind: "malformed",
      raw: normalized,
      message: error instanceof Error ? error.message : "Invalid JSON frame",
    };
  }
}
