import { z } from "zod";
import { randomUUID } from "node:crypto";
import { ActivityDiskIndex } from "./activity-disk-index.js";
import { recoverActivityJournal, readActivityLocation, copyActivitySuffix } from "./activity-journal.js";
import { writeAtomicPrivateFile } from "./atomic-private-file.js";
import { open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { AgentActivitySchema, type ActivityInput, type AgentActivity } from "../domain/agent-activity.js";
import type { AgentActivityPort } from "../orchestration/agent-activity-port.js";
import { ensurePrivateDirectory, openPrivateAppendFile } from "./private-files.js";

export interface ActivityRetention { maxBytes: number; maxAgeMs: number; now?: () => number }
/** Host-only journal. Serialized writes and source dedup survive restart; no sink is involved. */
export class AgentActivityStore implements AgentActivityPort {
  private readonly index: ActivityDiskIndex;
  private readonly pins = new Set<string>();
  private sequence = 0;
  private bytes = 0;
  private dropped = 0;
  private degraded = false;
  private poisoned = false;
  private tail: Promise<void> = Promise.resolve();
  private constructor(private readonly directory: string, private readonly retention: ActivityRetention) { this.index = new ActivityDiskIndex(join(directory, "activity-index.sqlite")); }
  static async open(directory: string, retention: ActivityRetention = { maxBytes: 2 * 1024 ** 3, maxAgeMs: 30 * 86400000 }): Promise<AgentActivityStore> {
    if (!Number.isSafeInteger(retention.maxBytes) || retention.maxBytes < 1024 || !Number.isFinite(retention.maxAgeMs) || retention.maxAgeMs < 1) throw new Error("ACTIVITY_RETENTION_INVALID");
    await ensurePrivateDirectory(directory);
    const store = new AgentActivityStore(directory, retention);
    await store.load().catch((error) => { store.index.close(); throw error; });
    try {
      const checkpoint = z.object({ sequence: z.number().int().nonnegative(), dropped: z.number().int().nonnegative() }).parse(JSON.parse(await readFile(join(directory, "activity-health.json"), "utf8")));
      store.sequence = Math.max(store.sequence, Number(checkpoint.sequence) || 0);
      store.dropped += Number(checkpoint.dropped) || 0;
      store.degraded ||= store.dropped > 0;
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    try {
      const pins = z.array(z.uuid()).max(1024).parse(JSON.parse(await readFile(join(directory, "activity-pins.json"), "utf8")));
      for (const run of pins) store.pins.add(run);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") { store.index.close(); throw error; } }
    if (store.degraded) await writeAtomicPrivateFile(join(directory, "activity-health.json"), JSON.stringify({ sequence: store.sequence, dropped: store.dropped }));
    return store;
  }
  private get path(): string { return join(this.directory, "activity.jsonl"); }
  /** Rebuild every in-memory and index fact from the journal alone; a torn tail is preserved and counted. */
  private async load(): Promise<void> {
    this.index.reset(); this.sequence = 0;
    const recovered = await recoverActivityJournal(this.directory, (event, offset, bytes) => {
      if (event.sequence <= this.sequence) throw new Error("ACTIVITY_JOURNAL_CONFLICT");
      this.index.add(event, offset, bytes); this.sequence = event.sequence;
    });
    this.bytes = recovered.bytes;
    if (recovered.torn) { this.degraded = true; this.dropped++; }
  }
  /** After a failed write nothing about the file is trusted until the journal has been re-read.
   * A recovered store carries the loss forward; one that cannot recover stays visibly unavailable. */
  private async recover(): Promise<void> {
    const sequence = this.sequence, dropped = this.dropped;
    await this.load();
    this.sequence = Math.max(this.sequence, sequence); this.dropped = Math.max(this.dropped, dropped + 1); this.degraded = true;
    await writeAtomicPrivateFile(join(this.directory, "activity-health.json"), JSON.stringify({ sequence: this.sequence, dropped: this.dropped }));
    this.poisoned = false;
  }
  append(input: ActivityInput): Promise<AgentActivity> {
    const operation = this.tail.then(async () => {
      if (this.poisoned) await this.recover().catch(() => { throw new Error("ACTIVITY_STORE_UNCERTAIN"); });
      const location = this.index.source(input.sourceKey);
      const existing = location ? await readActivityLocation(this.path, location) : undefined;
      if (existing !== undefined) {
        if (existing.sourceKey !== input.sourceKey || existing.sessionId !== input.sessionId || existing.instructionId !== input.instructionId || existing.kind !== input.kind || existing.sourceHash !== input.sourceHash) throw new Error("ACTIVITY_ATTRIBUTION_CONFLICT");
        return structuredClone(existing);
      }
      const event = AgentActivitySchema.parse({ ...input, sequence: this.sequence + 1 });
      const line = `${JSON.stringify(event)}\n`;
      if (Buffer.byteLength(line) > 256 * 1024) throw new Error("ACTIVITY_FRAME_LIMIT");
      await this.prune(Buffer.byteLength(line));
      const handle = await openPrivateAppendFile(this.path);
      try { await handle.writeFile(line); await handle.sync(); } catch (error) { this.poisoned = true; throw error; } finally { await handle.close(); }
      try { this.index.add(event, this.bytes, Buffer.byteLength(line)); } catch (error) { this.poisoned = true; throw error; }
      this.sequence = event.sequence; this.bytes += Buffer.byteLength(line);
      return structuredClone(event);
    });
    this.tail = operation.then(() => {}, () => { this.degraded = true; this.dropped += 1; });
    return operation;
  }
  async read(runId: string, afterSequence = 0, limit = 100): Promise<AgentActivity[]> {
    return this.readPage(() => this.index.page(runId, afterSequence, limit), afterSequence, limit);
  }
  async readSession(sessionId: string, afterSequence = 0, limit = 100): Promise<AgentActivity[]> {
    return this.readPage(() => this.index.sessionPage(sessionId, afterSequence, limit), afterSequence, limit);
  }
  private readPage(locations: () => ReturnType<ActivityDiskIndex["page"]>, afterSequence: number, limit: number): Promise<AgentActivity[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("ACTIVITY_READ_LIMIT");
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new Error("ACTIVITY_READ_CURSOR");
    const operation = this.tail.then(() => Promise.all(locations().map((location) => readActivityLocation(this.path, location))));
    this.tail = operation.then(() => {}, () => {});
    return operation;
  }
  health(): { degraded: boolean; dropped: number; retained: number; journalBytes: number; indexBytes: number; capBytes: number; pinned: number; uncertain: boolean } {
    return { degraded: this.degraded, dropped: this.dropped, retained: this.index.count(), journalBytes: this.bytes, indexBytes: this.index.bytes(),
      capBytes: this.retention.maxBytes, pinned: this.pins.size, uncertain: this.poisoned };
  }
  noteGap(): Promise<void> {
    const operation = this.tail.then(async () => {
      this.degraded = true; this.dropped++;
      await writeAtomicPrivateFile(join(this.directory, "activity-health.json"), JSON.stringify({ sequence: this.sequence, dropped: this.dropped }));
    });
    this.tail = operation.then(() => {}, () => {}); return operation;
  }
  private async prune(incoming: number): Promise<void> {
    if (incoming > this.retention.maxBytes) throw new Error("ACTIVITY_EVENT_TOO_LARGE");
    const cutoff = (this.retention.now?.() ?? Date.now()) - this.retention.maxAgeMs;
    // The cap is disk under this directory: journal plus its index. Once over it, free a batch
    // rather than one frame, so the index vacuum that follows runs per batch, not per append.
    // The row this append adds can grow the index by up to a page per b-tree; reserve for it.
    const indexBytes = this.index.bytes() + 2048, cap = this.retention.maxBytes - indexBytes;
    const target = this.bytes + incoming > cap ? cap - Math.max(incoming, Math.floor(this.retention.maxBytes / 64)) : cap;
    let remove = 0, removedBytes = 0, through = 0;
    outer: for (;;) {
      const page = this.index.oldest(through);
      if (!page.length) break;
      for (const location of page) {
        if (this.pins.has(location.run)) break outer;
        if (location.observed >= cutoff && this.bytes - removedBytes + incoming <= target) break outer;
        removedBytes = location.offset + location.bytes; through = location.sequence; remove++;
      }
    }
    if (this.bytes - removedBytes + incoming > cap) throw new Error("ACTIVITY_PINNED_CAPACITY");
    if (!remove) return;
    // Loss is durable before replacement. A crash may overreport it, never erase it.
    await writeAtomicPrivateFile(join(this.directory, "activity-health.json"), JSON.stringify({ sequence: this.sequence, dropped: this.dropped + remove }));
    const temporary = `${this.path}.${randomUUID()}.compact`;
    await copyActivitySuffix(this.path, temporary, removedBytes);
    this.poisoned = true;
    await rename(temporary, this.path);
    const parent = await open(this.directory, "r"); try { await parent.sync(); } finally { await parent.close(); }
    try { this.index.removePrefix(through, removedBytes); } catch (error) { this.poisoned = true; throw error; }
    this.bytes -= removedBytes; this.dropped += remove; this.degraded = true; this.poisoned = false;
  }
  pin(runId: string, pinned: boolean): Promise<void> {
    const operation = this.tail.then(async () => {
      z.uuid().parse(runId);
      const next = new Set(this.pins);
      if (pinned) next.add(runId); else next.delete(runId);
      if (next.size > 1024) throw new Error("ACTIVITY_PIN_LIMIT");
      await writeAtomicPrivateFile(join(this.directory, "activity-pins.json"), JSON.stringify([...next]));
      this.pins.clear(); for (const run of next) this.pins.add(run);
    });
    this.tail = operation.then(() => {}, () => {}); return operation;
  }
  async close(): Promise<void> { await this.tail; this.index.close(); }
}

/** Ordinary operation remains available with a visibly unavailable local recorder. */
export async function openActivityRecorder(directory: string): Promise<AgentActivityPort> {
  try { return await AgentActivityStore.open(directory); }
  catch {
    let dropped = 1;
    return { append: async () => { dropped += 1; throw new Error("ACTIVITY_CAPTURE_UNAVAILABLE"); },
      noteGap: async () => { dropped++; },
      read: async () => [], health: () => ({ degraded: true, dropped, retained: 0, uncertain: true }) };
  }
}
