import { open } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";

interface Observation { activity: "working" | "awaiting-input" | "unknown"; turns: number; at?: string }
interface Cursor extends Observation { inode: number; offset: number; pending: string; decoder: StringDecoder; identified: boolean }

/** Incremental, bounded source reads preserve activity through quiet periods and tool output. */
export class NativeAgentActivity {
  private readonly cursors = new Map<string, Cursor>();
  async read(path: string, id: string): Promise<Observation> {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(path, "r");
      const stat = await handle.stat();
      const key = `${id}:${path}`;
      let cursor = this.cursors.get(key);
      if (cursor === undefined || cursor.inode !== stat.ino || cursor.offset > stat.size) {
        cursor = { inode: stat.ino, offset: 0, pending: "", decoder: new StringDecoder("utf8"), identified: false, activity: "unknown", turns: 0 };
        this.cursors.set(key, cursor);
      }
      const bytes = Buffer.alloc(Math.min(stat.size - cursor.offset, 4 * 1024 * 1024));
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, cursor.offset);
      cursor.offset += bytesRead;
      const lines = (cursor.pending + cursor.decoder.write(bytes.subarray(0, bytesRead))).split("\n");
      cursor.pending = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (!cursor.identified) {
            if (event.type !== "session_meta" || event.payload?.id !== id) return { activity: "unknown", turns: 0 };
            cursor.identified = true; continue;
          }
          if (event.type !== "event_msg") continue;
          if (event.payload?.type === "task_started") { cursor.activity = "working"; cursor.at = event.timestamp; }
          if (["task_complete", "task_aborted", "turn_aborted"].includes(event.payload?.type)) {
            cursor.activity = "awaiting-input"; cursor.turns++; cursor.at = event.timestamp;
          }
        } catch { cursor.activity = "unknown"; }
      }
      // A large partial frame is an observation gap, not permission to invent a current state.
      if (cursor.pending.length > 4 * 1024 * 1024) { this.cursors.delete(key); return { activity: "unknown", turns: 0 }; }
      if (!cursor.identified || cursor.offset < stat.size || cursor.pending !== "") return { activity: "unknown", turns: cursor.turns };
      return { activity: cursor.activity, turns: cursor.turns, ...(cursor.at === undefined ? {} : { at: cursor.at }) };
    } catch { return { activity: "unknown", turns: 0 }; }
    finally { await handle?.close(); }
  }
}
