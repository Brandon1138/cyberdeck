import type { InstructionRecord } from "../domain/instruction.js";
import type { InstructionCommitObserver } from "./activity-instruction-store.js";

/** Synchronous view updated at canonical write boundaries, never by a periodic stale cache. */
export class InstructionParkingReadModel implements InstructionCommitObserver {
  private readonly records = new Map<string, InstructionRecord>();
  private readonly writingCounts = new Map<string, number>();
  private readonly uncertain = new Set<string>();
  private readonly queued = new Set<string>();
  private wake: ((id: string) => void) | undefined;
  constructor(records: InstructionRecord[], private readonly maxRecords = 10000) {
    if (records.length > maxRecords) throw new Error("PARKING_INSTRUCTION_VIEW_CAP");
    for (const record of records) this.records.set(record.id, record);
  }
  bindWake(wake: (id: string) => void): void { this.wake = wake; for (const id of this.queued) wake(id); this.queued.clear(); }
  writing(record: InstructionRecord): void {
    const id = record.targetSessionId;
    this.writingCounts.set(id, (this.writingCounts.get(id) ?? 0) + 1);
    if (record.status === "accepted") { if (this.wake) this.wake(id); else this.queued.add(id); }
  }
  committed(record: InstructionRecord): void {
    this.endWrite(record.targetSessionId);
    if (!this.records.has(record.id) && this.records.size >= this.maxRecords) { this.uncertain.add(record.targetSessionId); return; }
    this.records.set(record.id, record);
  }
  failed(record: InstructionRecord): void { this.endWrite(record.targetSessionId); this.uncertain.add(record.targetSessionId); }
  read(sessionId: string) {
    return { known: !this.uncertain.has(sessionId) && !this.writingCounts.has(sessionId),
      statuses: [...this.records.values()].filter(r => r.targetSessionId === sessionId).map(r => r.status) };
  }
  /** Only the canonical session-retirement path may remove a session's read model. */
  reconcileRetired(retainedSessionIds: ReadonlySet<string>): void {
    const knownIds = new Set([...this.records.values()].map(record => record.targetSessionId));
    for (const id of this.uncertain) knownIds.add(id);
    for (const id of this.queued) knownIds.add(id);
    for (const id of knownIds) if (!retainedSessionIds.has(id) && !this.writingCounts.has(id)) this.forget(id);
  }
  forget(sessionId: string): void {
    if (this.writingCounts.has(sessionId)) throw new Error("PARKING_INSTRUCTION_WRITE_PENDING");
    for (const [key, record] of this.records) if (record.targetSessionId === sessionId) this.records.delete(key);
    this.uncertain.delete(sessionId); this.queued.delete(sessionId);
  }
  private endWrite(id: string): void {
    const count = this.writingCounts.get(id) ?? 0;
    if (count <= 1) this.writingCounts.delete(id); else this.writingCounts.set(id, count - 1);
  }
}
