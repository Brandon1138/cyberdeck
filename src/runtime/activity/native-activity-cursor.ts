import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, mkdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { AgentActivityPort } from "../../orchestration/agent-activity-port.js";
import { collectNativeActivity, type ActivityAttribution, type NativeActivityParser } from "./provider-activity-collector.js";

const Cursor = z.object({ schemaVersion: z.literal(1), offset: z.number().int().nonnegative(),
  digest: z.string().regex(/^[a-f0-9]{64}$/), sourceId: z.string(), device: z.number(), inode: z.number() }).strict();

/** Serialized per source. The caller supplies an explicit committed instruction/turn binding
 * for this interval. Reading a shared cwd or assigning by timestamp is never a binding. */
export class NativeActivityCursor {
  private tail = Promise.resolve();
  constructor(private readonly directory: string, private readonly recorder: AgentActivityPort) {}
  collect(input: {
    path: string; sourceId: string; provider: string; parse: NativeActivityParser;
    attribution: ActivityAttribution; fromOffset: number; throughOffset: number;
  }): Promise<number> {
    const operation = this.tail.then(() => this.readInterval(input));
    this.tail = operation.then(() => {}, () => {});
    return operation;
  }
  private async readInterval(input: Parameters<NativeActivityCursor["collect"]>[0]): Promise<number> {
    if (!Number.isSafeInteger(input.fromOffset) || !Number.isSafeInteger(input.throughOffset)
      || input.fromOffset < 0 || input.throughOffset < input.fromOffset) throw new Error("ACTIVITY_INTERVAL_INVALID");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, `${createHash("sha256").update(input.sourceId).digest("hex")}.json`);
    let cursor: z.infer<typeof Cursor> | undefined;
    try { cursor = Cursor.parse(JSON.parse(await readFile(path, "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const source = await open(input.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await source.stat();
      if (!stat.isFile()) throw new Error("ACTIVITY_SOURCE_NOT_FILE");
      if (cursor && (cursor.sourceId !== input.sourceId || cursor.inode !== stat.ino || cursor.device !== stat.dev || stat.size < cursor.offset)) {
        await this.gap(input, "truncated-source"); throw new Error("ACTIVITY_SOURCE_REPLACED");
      }
      if (input.fromOffset > (cursor?.offset ?? 0) || input.throughOffset > stat.size) throw new Error("ACTIVITY_INTERVAL_GAP");
      if ((cursor?.offset ?? 0) > input.throughOffset) throw new Error("ACTIVITY_INTERVAL_STALE");
      // Verify the acknowledged prefix without loading whole native files into memory.
      // A changed source is preserved and refused; it cannot silently rewrite prior evidence.
      const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
      let position = 0;
      while (position < (cursor?.offset ?? 0)) {
        const count = Math.min(buffer.length, cursor!.offset - position);
        const read = await source.read(buffer, 0, count, position);
        if (!read.bytesRead) throw new Error("ACTIVITY_SOURCE_TRUNCATED");
        hash.update(buffer.subarray(0, read.bytesRead)); position += read.bytesRead;
      }
      if (cursor && hash.copy().digest("hex") !== cursor.digest) {
        await this.gap(input, "truncated-source"); throw new Error("ACTIVITY_SOURCE_MODIFIED");
      }
      const lines: Array<{ offset: number; text: string }> = [];
      let partial = Buffer.alloc(0), acknowledged = position, count = 0;
      while (position < input.throughOffset) {
        const read = await source.read(buffer, 0, Math.min(buffer.length, input.throughOffset - position), position);
        if (!read.bytesRead) throw new Error("ACTIVITY_SOURCE_TRUNCATED");
        position += read.bytesRead;
        partial = Buffer.concat([partial, buffer.subarray(0, read.bytesRead)]);
        let newline: number;
        while ((newline = partial.indexOf(10)) >= 0) {
          if (newline > 1024 * 1024) throw new Error("ACTIVITY_SOURCE_FRAME_LIMIT");
          const complete = partial.subarray(0, newline + 1);
          lines.push({ offset: acknowledged, text: complete.subarray(0, -1).toString("utf8") });
          acknowledged += complete.length; hash.update(complete); partial = partial.subarray(newline + 1);
        }
        if (partial.length > 1024 * 1024) throw new Error("ACTIVITY_SOURCE_FRAME_LIMIT");
        if (lines.length) {
          count += await collectNativeActivity({ ...input, lines, recorder: this.recorder }); lines.length = 0;
        }
      }
      // Commit only after all complete frames' activity writes have been fsynced. If this
      // checkpoint fails, replay uses source dedup keys and does not duplicate tool events.
      const value = { schemaVersion: 1, sourceId: input.sourceId, device: stat.dev, inode: stat.ino, offset: acknowledged, digest: hash.digest("hex") };
      const temporary = `${path}.${randomUUID()}.pending`, file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
      await rename(temporary, path);
      const directory = await open(this.directory, "r"); try { await directory.sync(); } finally { await directory.close(); }
      return count;
    } finally { await source.close(); }
  }
  private async gap(input: Parameters<NativeActivityCursor["collect"]>[0], gap: "truncated-source"): Promise<void> {
    await this.recorder.append({ schemaVersion: 1, eventId: randomUUID(), sourceKey: `source-loss:${input.sourceId}:${input.fromOffset}:${input.throughOffset}`,
      ...input.attribution, observedAt: new Date().toISOString(), kind: "capture.gap", operation: "capture", outcome: "unknown",
      provenance: "provider-native", coverage: "partial", gap });
  }
}
