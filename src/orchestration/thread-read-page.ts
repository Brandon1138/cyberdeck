import { createHash } from "node:crypto";
import { ThreadPageOptionsSchema, type ThreadPageOptions, type ThreadReadResult } from "../domain/thread.js";
import type { ThreadTranscriptReader } from "./persistence-ports.js";

/** Bounded JSON pages; an oversized event stays before nextCursor until its last byte is returned. */
export async function readThreadPage(
  transcripts: ThreadTranscriptReader, sessionId: string, afterCursor: number, limit: number,
  options: ThreadPageOptions = {},
): Promise<ThreadReadResult> {
  const { maxBytes, continuation } = ThreadPageOptionsSchema.parse(options);
  const result: ThreadReadResult = { events: [], nextCursor: afterCursor };
  const fits = (value: ThreadReadResult) => Buffer.byteLength(JSON.stringify(value)) <= maxBytes;
  for (let index = 0; index < Math.max(1, Math.min(limit, 100)); index++) {
    const page = await transcripts.read(sessionId, result.nextCursor, 1);
    const event = page.events[0];
    if (continuation !== undefined && (event?.id !== continuation.eventId || event.cursor !== continuation.cursor)) stale();
    if (event === undefined) { result.nextCursor = Math.max(result.nextCursor, page.nextCursor); break; }
    if (continuation === undefined && fits({ events: [...result.events, event], nextCursor: event.cursor })) {
      result.events.push(event); result.nextCursor = event.cursor; continue;
    }
    if (result.events.length > 0) break;
    const bytes = Buffer.from(JSON.stringify(event));
    const digest = createHash("sha256").update(bytes).digest("hex");
    const offset = continuation?.byteOffset ?? 0;
    if (continuation !== undefined && (continuation.digest !== digest || offset >= bytes.length
      || (bytes[offset]! & 0xc0) === 0x80 || event.cursor <= afterCursor)) stale();
    const make = (end: number): ThreadReadResult => ({
      events: [], nextCursor: end === bytes.length ? event.cursor : afterCursor,
      fragment: { eventId: event.id, cursor: event.cursor, byteOffset: offset, nextByteOffset: end,
        totalBytes: bytes.length, json: bytes.subarray(offset, end).toString("utf8") },
      ...(end === bytes.length ? {} : { continuation: { eventId: event.id, cursor: event.cursor, byteOffset: end, digest } }),
    });
    let low = offset, high = Math.min(bytes.length, offset + maxBytes);
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (fits(make(middle))) low = middle; else high = middle - 1;
    }
    // Stay on a UTF-8 boundary. Escaped JSON syntax may cross chunks; concatenation restores it.
    while (low < bytes.length && low > offset && (bytes[low]! & 0xc0) === 0x80) low--;
    if (low <= offset) throw new Error("Thread page metadata exceeds byte budget");
    return make(low);
  }
  return result;
}
function stale(): never { throw Object.assign(new Error("Thread detail changed or was rotated out; continuation cannot skip unread bytes"), { code: "STALE_THREAD_DETAIL" }); }
