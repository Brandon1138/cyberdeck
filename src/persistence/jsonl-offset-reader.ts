import { open } from "node:fs/promises";

/** Incremental non-authority JSONL reader. Partial lines remain before the cursor. */
export class JsonlOffsetReader {
  offset = 0;
  private identity = "";
  private stamp = "";
  private size = 0;
  private prefix: Buffer = Buffer.alloc(0);
  private boundary: Buffer = Buffer.alloc(0);
  private tail = Promise.resolve();
  constructor(private readonly reset: () => void) {}

  scan(path: string, visit: (line: string, offset: number, bytes: number) => void): Promise<void> {
    const operation = this.tail.then(() => this.read(path, visit));
    this.tail = operation.then(() => {}, () => {});
    return operation;
  }

  private async read(path: string, visit: (line: string, offset: number, bytes: number) => void): Promise<void> {
    const file = await open(path, "r").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (file === undefined) { this.clear(); return; }
    try {
      const info = await file.stat({ bigint: true });
      const identity = `${path}:${info.dev}:${info.ino}`;
      const stamp = `${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
      const size = Number(info.size);
      if (identity === this.identity && stamp === this.stamp) return;
      const sample = async (start: number, bytes: number): Promise<Buffer> => {
        const buffer = Buffer.alloc(bytes);
        const { bytesRead } = await file.read(buffer, 0, bytes, start);
        return buffer.subarray(0, bytesRead);
      };
      const changed = identity !== this.identity || size < this.size
        || (size === this.size && stamp !== this.stamp)
        || !(await sample(0, this.prefix.length)).equals(this.prefix)
        || !(await sample(Math.max(0, this.offset - this.boundary.length), this.boundary.length)).equals(this.boundary);
      if (changed) this.clear();
      let position = this.offset, partial = Buffer.alloc(0);
      const buffer = Buffer.alloc(64 * 1024);
      while (position < size) {
        const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, size - position), position);
        if (!bytesRead) { this.clear(); throw new Error("Transcript changed during read"); }
        position += bytesRead;
        partial = Buffer.concat([partial, buffer.subarray(0, bytesRead)]);
        let newline: number;
        while ((newline = partial.indexOf(10)) >= 0) {
          const bytes = newline + 1;
          visit(partial.subarray(0, newline).toString("utf8").replace(/\r$/u, ""), this.offset, bytes);
          this.offset += bytes; partial = partial.subarray(bytes);
        }
      }
      this.identity = identity; this.stamp = stamp; this.size = size;
      this.prefix = await sample(0, Math.min(256, this.offset));
      this.boundary = await sample(Math.max(0, this.offset - 256), Math.min(256, this.offset));
    } finally { await file.close(); }
  }

  private clear(): void {
    this.offset = 0; this.identity = ""; this.stamp = ""; this.size = 0;
    this.prefix = Buffer.alloc(0); this.boundary = Buffer.alloc(0); this.reset();
  }
}
