import { createHash } from "node:crypto";
import { statSync, unlinkSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { AgentActivity } from "../domain/agent-activity.js";

export interface ActivityLocation { sequence: number; offset: number; bytes: number; observed: number; run: string }
const uuidBlob = (id: string): Buffer => Buffer.from(id.replaceAll("-", ""), "hex");
const uuidText = (blob: Uint8Array): string => { const h = Buffer.from(blob).toString("hex"); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; };
const row = (record: Record<string, unknown>): ActivityLocation => ({ sequence: Number(record.sequence), offset: Number(record.offset), bytes: Number(record.bytes), observed: Number(record.observed), run: uuidText(record.run as Uint8Array) });
/** Disposable disk index. The fsynced JSONL is authoritative and rebuilds this at every open, so
 * the previous file is unlinked first: a corrupt index can never keep the recorder from starting.
 * Only locations and hashed dedup keys are indexed; payloads never accumulate in process memory.
 * Its bytes are real disk under the activity directory and count against the retention cap.
 */
export class ActivityDiskIndex {
  private readonly db: DatabaseSync;
  private insert: ReturnType<DatabaseSync["prepare"]> | undefined;
  constructor(private readonly path: string) {
    for (const stale of [path, `${path}-journal`, `${path}-wal`, `${path}-shm`]) {
      try { unlinkSync(stale); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA page_size=1024; PRAGMA cache_size=-2048; PRAGMA temp_store=FILE; PRAGMA journal_mode=OFF;");
    this.reset();
  }
  /** Empty the index in place so an in-process journal re-scan can rebuild it. */
  reset(): void {
    // The cached statement is compiled against the table this drops; it must not outlive it.
    this.insert = undefined;
    this.db.exec(`DROP TABLE IF EXISTS activity;
      CREATE TABLE activity(sequence INTEGER PRIMARY KEY, source BLOB UNIQUE NOT NULL, run BLOB NOT NULL,
        offset INTEGER NOT NULL, bytes INTEGER NOT NULL, observed REAL NOT NULL, session BLOB NOT NULL);
      CREATE INDEX activity_run ON activity(run, sequence);
      CREATE INDEX activity_session ON activity(session, sequence);
      VACUUM;`);
  }
  add(event: AgentActivity, offset: number, bytes: number): void {
    this.insert ??= this.db.prepare("INSERT INTO activity VALUES (?, ?, ?, ?, ?, ?, ?)");
    this.insert.run(event.sequence,
      createHash("sha256").update(event.sourceKey).digest(), uuidBlob(event.runId), offset, bytes, Date.parse(event.observedAt), uuidBlob(event.sessionId));
  }
  /**
   * Run a whole-index rebuild as one transaction.
   *
   * Without it each `add` is its own implicit transaction, and `PRAGMA journal_mode=OFF` does not
   * take effect on this driver — the mode stays `delete`, so every row pays a rollback journal
   * create, write, fsync and unlink. Measured on a 287k-event journal that is ~256s of startup
   * against ~1.6s here, which is the difference between a broker that starts and one that looks
   * hung. Nothing else touches this database while a rebuild runs, so holding the transaction
   * across the journal read is safe; a throw rolls back and leaves no half-built index.
   */
  async bulk<T>(work: () => Promise<T>): Promise<T> {
    this.db.exec("BEGIN");
    try {
      const result = await work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* the failure below is the one worth reporting */ }
      throw error;
    }
  }
  source(key: string): ActivityLocation | undefined {
    const found = this.db.prepare("SELECT sequence, offset, bytes, observed, run FROM activity WHERE source=?").get(createHash("sha256").update(key).digest());
    return found ? row(found) : undefined;
  }
  page(run: string, after: number, limit: number): ActivityLocation[] {
    return this.db.prepare("SELECT sequence, offset, bytes, observed, run FROM activity WHERE run=? AND sequence>? ORDER BY sequence LIMIT ?")
      .all(uuidBlob(run), after, limit).map(row);
  }
  sessionPage(session: string, after: number, limit: number): ActivityLocation[] {
    return this.db.prepare("SELECT sequence, offset, bytes, observed, run FROM activity WHERE session=? AND sequence>? ORDER BY sequence LIMIT ?")
      .all(uuidBlob(session), after, limit).map(row);
  }
  oldestObserved(): number | undefined {
    const found = this.db.prepare("SELECT observed FROM activity ORDER BY sequence LIMIT 1").get();
    return found === undefined ? undefined : Number(found.observed);
  }
  oldest(after = 0): ActivityLocation[] {
    return this.db.prepare("SELECT sequence, offset, bytes, observed, run FROM activity WHERE sequence>? ORDER BY sequence LIMIT 1000").all(after).map(row);
  }
  removePrefix(sequence: number, bytes: number): void {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM activity WHERE sequence<=?").run(sequence);
      this.db.prepare("UPDATE activity SET offset=offset-?").run(bytes);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    this.db.exec("VACUUM");
  }
  count(): number { return Number(this.db.prepare("SELECT count(*) AS count FROM activity").get()!.count); }
  /** On-disk size right now; the freelist is returned to the filesystem after each prefix removal. */
  bytes(): number { try { return statSync(this.path).size; } catch { return 0; } }
  close(): void { this.db.close(); }
}
