import { ThreadEventSchema, type ThreadEvent } from "../domain/thread.js";
import type { StrigoiSourceRef } from "../domain/strigoi.js";
import type { StrigoiSourceArchive } from "./strigoi-source-archive.js";
import type { StrigoiPackets } from "./strigoi-packets.js";

/** Succession intent and receipts outlive the shared transcript's rotating segments. */
export async function archivedTurnEvents(archive: StrigoiSourceArchive, packets: StrigoiPackets, sessionId: string): Promise<ThreadEvent[]> {
  const groups = new Map<string, StrigoiSourceRef[]>();
  for (const source of await archive.list()) {
    if (!source.id.startsWith("thread:") || !source.sessionIds?.includes(sessionId)) continue;
    const key = JSON.stringify([source.kind, source.id, source.revision]);
    const group = groups.get(key) ?? []; group.push(source); groups.set(key, group);
  }
  const events = new Map<string, ThreadEvent>();
  for (const group of groups.values()) {
    const event = ThreadEventSchema.parse(JSON.parse(await packets.original(group)));
    if (event.sessionId !== sessionId || `thread:${event.id}` !== group[0]!.id) throw new Error("STRIGOI_TURN_EVIDENCE_IDENTITY_MISMATCH");
    const previous = events.get(event.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(event)) {
      // Startup inventory may recapture a storage-elided version of an already archived
      // original. Only its text may differ, and a full original must still be present.
      if (JSON.stringify({ ...previous, text: undefined }) !== JSON.stringify({ ...event, text: undefined })
        || typeof event.data.storageOriginalLength !== "number") throw new Error("STRIGOI_TURN_EVIDENCE_CONFLICT");
      const previousFull = previous.text?.length === event.data.storageOriginalLength;
      const eventFull = event.text?.length === event.data.storageOriginalLength;
      if (previousFull && eventFull) throw new Error("STRIGOI_TURN_EVIDENCE_CONFLICT");
      if (previousFull) continue;
    }
    events.set(event.id, event);
  }
  if ([...events.values()].some(e => typeof e.data.storageOriginalLength === "number" && e.text?.length !== e.data.storageOriginalLength)) {
    throw new Error("STRIGOI_TURN_EVIDENCE_INCOMPLETE");
  }
  // Confirm ambiguous archive publication before a durable outcome is adopted.
  await archive.confirm();
  return [...events.values()].sort((a, b) => a.cursor - b.cursor);
}
