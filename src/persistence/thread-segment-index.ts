import { open } from "node:fs/promises";
import { ThreadEventSchema, type ThreadEvent, type ThreadReadResult } from "../domain/thread.js";
import { JsonlOffsetReader } from "./jsonl-offset-reader.js";

interface Location { cursor: number; offset: number; bytes: number }
interface Segment { reader: JsonlOffsetReader; sessions: Map<string, Location[]>; all: Location[]; ordered: boolean }

/** Disposable locations only; bounded by retained segments, never a second authoritative journal. */
export class ThreadSegmentIndex {
  private readonly segments = new Map<string, Segment>();
  async read(paths: string[], afterCursor: number, limit: number, sessionId?: string): Promise<ThreadReadResult> {
    const events: ThreadEvent[] = [];
    for (const path of paths) {
      let segment = this.segments.get(path);
      if (segment === undefined) {
        const sessions = new Map<string, Location[]>(), all: Location[] = [];
        segment = { sessions, all, ordered: true, reader: undefined! };
        const reset = segment;
        segment.reader = new JsonlOffsetReader(() => { sessions.clear(); all.length = 0; reset.ordered = true; });
        this.segments.set(path, segment);
      }
      const current = segment;
      await current.reader.scan(path, (line, offset, bytes) => {
        const event = parseThreadEvent(line);
        if (event === undefined) return;
        const location = { cursor: event.cursor, offset, bytes };
        if ((current.all.at(-1)?.cursor ?? 0) >= event.cursor) current.ordered = false;
        current.all.push(location);
        const rows = current.sessions.get(event.sessionId) ?? [];
        rows.push(location); current.sessions.set(event.sessionId, rows);
      });
      const rows = sessionId === undefined ? current.all : current.sessions.get(sessionId) ?? [];
      // Cursors are monotonic for store-authored files. Preserve stream order for anomalous files.
      const ordered = current.ordered;
      let start = 0;
      if (ordered) {
        let high = rows.length;
        while (start < high) { const middle = (start + high) >>> 1; if (rows[middle]!.cursor <= afterCursor) start = middle + 1; else high = middle; }
      }
      const selected: Location[] = [];
      for (let index = start; index < rows.length && selected.length < limit - events.length; index++) {
        if (rows[index]!.cursor > afterCursor) selected.push(rows[index]!);
      }
      if (!selected.length) continue;
      const file = await open(path, "r");
      try {
        for (const location of selected) {
          const buffer = Buffer.alloc(location.bytes);
          const { bytesRead } = await file.read(buffer, 0, buffer.length, location.offset);
          const event = bytesRead === buffer.length ? parseThreadEvent(buffer.toString("utf8")) : undefined;
          if (event === undefined || event.cursor !== location.cursor || (sessionId !== undefined && event.sessionId !== sessionId)) {
            this.segments.delete(path); throw new Error("Transcript index changed during read");
          }
          events.push(event);
        }
      } finally { await file.close(); }
      if (events.length >= limit) break;
    }
    for (const path of this.segments.keys()) if (!paths.includes(path)) this.segments.delete(path);
    return { events, nextCursor: events.at(-1)?.cursor ?? afterCursor };
  }
}

export function parseThreadEvent(line: string): ThreadEvent | undefined {
  try { const parsed = ThreadEventSchema.safeParse(JSON.parse(line)); return parsed.success ? parsed.data : undefined; }
  catch { return undefined; }
}
