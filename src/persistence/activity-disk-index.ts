import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { AgentActivity } from "../domain/agent-activity.js";

export interface ActivityLocation { sequence: number; offset: number; bytes: number; observed: number; run: string }
/** Disposable disk index. The fsynced JSONL is authoritative and rebuilds this at every open.
 * Only locations and hashed dedup keys are indexed; payloads never accumulate in process memory.
 */
export class ActivityDiskIndex {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA cache_size=-2048; PRAGMA temp_store=FILE; PRAGMA journal_mode=OFF;
      DROP TABLE IF EXISTS activity;
      CREATE TABLE activity(sequence INTEGER PRIMARY KEY, source TEXT UNIQUE NOT NULL, run TEXT NOT NULL,
        offset INTEGER NOT NULL, bytes INTEGER NOT NULL, observed REAL NOT NULL);
      CREATE INDEX activity_run ON activity(run, sequence);`);
  }
  add(event: AgentActivity, offset: number, bytes: number): void {
    this.db.prepare("INSERT INTO activity VALUES (?, ?, ?, ?, ?, ?)").run(event.sequence,
      createHash("sha256").update(event.sourceKey).digest("hex"), event.runId, offset, bytes, Date.parse(event.observedAt));
  }
  source(key: string): ActivityLocation | undefined {
    return this.db.prepare("SELECT sequence, offset, bytes, observed, run FROM activity WHERE source=?")
      .get(createHash("sha256").update(key).digest("hex")) as ActivityLocation | undefined;
  }
  page(run: string, after: number, limit: number): ActivityLocation[] {
    return this.db.prepare("SELECT sequence, offset, bytes, observed, run FROM activity WHERE run=? AND sequence>? ORDER BY sequence LIMIT ?")
      .all(run, after, limit) as unknown as ActivityLocation[];
  }
  oldest(after = 0): ActivityLocation[] {
    return this.db.prepare("SELECT sequence, offset, bytes, observed, run FROM activity WHERE sequence>? ORDER BY sequence LIMIT 1000")
      .all(after) as unknown as ActivityLocation[];
  }
  removePrefix(sequence: number, bytes: number): void {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM activity WHERE sequence<=?").run(sequence);
      this.db.prepare("UPDATE activity SET offset=offset-?").run(bytes);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  count(): number { return Number(this.db.prepare("SELECT count(*) AS count FROM activity").get()!.count); }
  close(): void { this.db.close(); }
}
