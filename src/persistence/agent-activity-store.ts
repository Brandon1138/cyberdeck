import { open, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AgentActivitySchema, type ActivityInput, type AgentActivity } from "../domain/agent-activity.js";
import type { AgentActivityPort } from "../orchestration/agent-activity-port.js";
import { ensurePrivateDirectory, openPrivateAppendFile } from "./private-files.js";

export interface ActivityRetention { maxBytes: number; maxAgeMs: number; now?: () => number }
/** Host-only journal. Serialized writes and source dedup survive restart; no sink is involved. */
export class AgentActivityStore implements AgentActivityPort {
  private events: AgentActivity[] = [];
  private readonly seen = new Map<string, AgentActivity>();
  private sequence = 0;
  private bytes = 0;
  private dropped = 0;
  private degraded = false;
  private poisoned = false;
  private tail: Promise<void> = Promise.resolve();
  private constructor(private readonly directory: string, private readonly retention: ActivityRetention) {}
  static async open(directory: string, retention: ActivityRetention = { maxBytes: 2 * 1024 ** 3, maxAgeMs: 30 * 86400000 }): Promise<AgentActivityStore> {
    if (!Number.isSafeInteger(retention.maxBytes) || retention.maxBytes < 1024 || retention.maxAgeMs < 1) throw new Error("ACTIVITY_RETENTION_INVALID");
    await ensurePrivateDirectory(directory);
    const store = new AgentActivityStore(directory, retention);
    let content = "";
    try { content = await readFile(store.path, "utf8"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    const boundary = content.lastIndexOf("\n") + 1;
    if (boundary < content.length) {
      await writeFile(join(directory, `activity-torn-tail-${Date.now()}.txt`), content.slice(boundary), { flag: "wx", mode: 0o600 });
      const handle = await open(store.path, "r+");
      try { await handle.truncate(Buffer.byteLength(content.slice(0, boundary))); await handle.sync(); } finally { await handle.close(); }
      store.degraded = true; store.dropped += 1;
    }
    for (const line of content.slice(0, boundary).split("\n").filter(Boolean)) {
      const event = AgentActivitySchema.parse(JSON.parse(line));
      if (event.sequence <= store.sequence || store.seen.has(event.sourceKey)) throw new Error("ACTIVITY_JOURNAL_CONFLICT");
      store.sequence = event.sequence; store.events.push(event); store.seen.set(event.sourceKey, event);
      store.bytes += Buffer.byteLength(line) + 1;
    }
    try {
      const checkpoint = JSON.parse(await readFile(join(directory, "activity-health.json"), "utf8"));
      store.sequence = Math.max(store.sequence, Number(checkpoint.sequence) || 0);
      store.dropped += Number(checkpoint.dropped) || 0;
      store.degraded ||= store.dropped > 0;
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    return store;
  }
  private get path(): string { return join(this.directory, "activity.jsonl"); }
  append(input: ActivityInput): Promise<AgentActivity> {
    const operation = this.tail.then(async () => {
      if (this.poisoned) throw new Error("ACTIVITY_STORE_UNCERTAIN");
      const existing = this.seen.get(input.sourceKey);
      if (existing !== undefined) {
        if (existing.sessionId !== input.sessionId || existing.instructionId !== input.instructionId || existing.kind !== input.kind || existing.sourceHash !== input.sourceHash) throw new Error("ACTIVITY_ATTRIBUTION_CONFLICT");
        return structuredClone(existing);
      }
      const event = AgentActivitySchema.parse({ ...input, sequence: this.sequence + 1 });
      const line = `${JSON.stringify(event)}\n`;
      await this.prune(Buffer.byteLength(line));
      const handle = await openPrivateAppendFile(this.path);
      try { await handle.writeFile(line); await handle.sync(); } catch (error) { this.poisoned = true; throw error; } finally { await handle.close(); }
      this.sequence = event.sequence; this.events.push(event); this.seen.set(event.sourceKey, event); this.bytes += Buffer.byteLength(line);
      return structuredClone(event);
    });
    this.tail = operation.then(() => {}, () => { this.degraded = true; this.dropped += 1; });
    return operation;
  }
  async read(runId: string, afterSequence = 0, limit = 100): Promise<AgentActivity[]> {
    await this.tail;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("ACTIVITY_READ_LIMIT");
    return this.events.filter((event) => event.runId === runId && event.sequence > afterSequence).slice(0, limit).map((event) => structuredClone(event));
  }
  health(): { degraded: boolean; dropped: number; retained: number } { return { degraded: this.degraded, dropped: this.dropped, retained: this.events.length }; }
  private async prune(incoming: number): Promise<void> {
    if (incoming > this.retention.maxBytes) throw new Error("ACTIVITY_EVENT_TOO_LARGE");
    const cutoff = (this.retention.now?.() ?? Date.now()) - this.retention.maxAgeMs;
    let remove = 0, bytes = this.bytes;
    while (remove < this.events.length && (Date.parse(this.events[remove]!.observedAt) < cutoff || bytes + incoming > this.retention.maxBytes)) {
      bytes -= Buffer.byteLength(JSON.stringify(this.events[remove])) + 1; remove += 1;
    }
    if (remove === 0) return;
    const kept = this.events.slice(remove);
    // Persist loss and high-water mark before replacement; a crash may overreport loss, never hide it.
    const health = { sequence: this.sequence, dropped: this.dropped + remove };
    const healthHandle = await open(join(this.directory, "activity-health.json"), "w", 0o600);
    try { await healthHandle.writeFile(JSON.stringify(health)); await healthHandle.sync(); } finally { await healthHandle.close(); }
    const temporary = `${this.path}.compact`;
    const handle = await open(temporary, "w", 0o600);
    try { await handle.writeFile(kept.map((event) => JSON.stringify(event) + "\n").join("")); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, this.path);
    for (const event of this.events.slice(0, remove)) this.seen.delete(event.sourceKey);
    this.events = kept; this.bytes = bytes; this.dropped += remove; this.degraded = true;
    // Durable provider cursors prevent replay beyond retention. The in-memory dedup index
    // obeys the same bound instead of retaining every evicted event for the broker's lifetime.
  }
}

/** Ordinary operation remains available with a visibly unavailable local recorder. */
export async function openActivityRecorder(directory: string): Promise<AgentActivityPort> {
  try { return await AgentActivityStore.open(directory); }
  catch {
    let dropped = 1;
    return { append: async () => { dropped += 1; throw new Error("ACTIVITY_CAPTURE_UNAVAILABLE"); },
      read: async () => [], health: () => ({ degraded: true, dropped, retained: 0 }) };
  }
}
