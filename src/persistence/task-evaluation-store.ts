import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TaskEvaluationIntentSchema, TaskEvaluationResultSchema, type TaskEvaluationIntent, type TaskEvaluationResult } from "../domain/task-evaluation.js";

import { evidenceHash, type EvaluationEvidenceManifest, type EvaluationReplayCheckpoint } from "../orchestration/task-evaluation-ports.js";
import { legacySnapshotHash, terminalInstructionSource, type LegacyInstructionSnapshot, type LegacyEvaluationMigration, type LegacyEvaluationDisposition } from "../orchestration/task-evaluation-legacy.js";
export { evidenceHash, type EvaluationEvidenceManifest } from "../orchestration/task-evaluation-ports.js";
export const evaluationKey = (intent: TaskEvaluationIntent): string => createHash("sha256").update(JSON.stringify([intent.attemptId, intent.rubricId, intent.rubricVersion])).digest("hex");
export interface EvaluationClaim { key: string; token: string; expiresAt: number; intent: TaskEvaluationIntent; manifest: EvaluationEvidenceManifest }

/** Shared broker/evaluator database. SQLite serializes claims across processes; FULL commits
 * survive restart. Inline evidence is a durable pin, removed only after result acknowledgement.
 * No rows are silently evicted: at the disk cap canonical replay remains the pending outbox. */
export class TaskEvaluationStore {
  private readonly db: DatabaseSync;
  constructor(path: string, private readonly maxBytes = 32 * 1024 ** 2) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 65536) throw new Error("EVALUATION_CAP_INVALID");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try { if (lstatSync(path).isSymbolicLink()) throw new Error("EVALUATION_SYMLINK"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    this.db = new DatabaseSync(path); chmodSync(path, 0o600);
    // Reserve half the disk budget for SQLite's bounded rollback journal during updates.
    this.db.exec(`PRAGMA page_size=4096; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000; PRAGMA cache_size=-512; PRAGMA max_page_count=${Math.floor(maxBytes / 8192)};
      CREATE TABLE IF NOT EXISTS evaluations (
        key TEXT PRIMARY KEY, intent TEXT NOT NULL, manifest TEXT, token TEXT, expires REAL,
        result TEXT, acknowledged INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS evaluation_sources (source TEXT NOT NULL, key TEXT NOT NULL, PRIMARY KEY(source,key));
      CREATE TABLE IF NOT EXISTS evaluation_checkpoints (consumer TEXT PRIMARY KEY, source TEXT NOT NULL, sequence INTEGER NOT NULL);
      INSERT OR IGNORE INTO evaluation_sources(source,key)
        SELECT json_extract(manifest,'$.terminalEvent.sourceKey'),key FROM evaluations
        WHERE manifest IS NOT NULL AND json_type(manifest,'$.terminalEvent.sourceKey')='text';
    `);
  }
  enqueue(intent: TaskEvaluationIntent, manifest: EvaluationEvidenceManifest): string {
    TaskEvaluationIntentSchema.parse(intent);
    const key = evaluationKey(intent), body = JSON.stringify(manifest);
    if (evidenceHash(manifest) !== intent.evidenceManifestHash) throw new Error("EVALUATION_MANIFEST_MISMATCH");
    const existing = this.db.prepare("SELECT intent FROM evaluations WHERE key=?").get(key);
    if (existing) {
      if (JSON.stringify(intent) !== existing.intent) throw new Error("EVALUATION_INTENT_CONFLICT");
      return key;
    }
    if (Buffer.byteLength(body) > Math.min(1024 * 1024, this.maxBytes / 4)) throw new Error("EVALUATION_EVIDENCE_CAP");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO evaluations(key,intent,manifest) VALUES (?,?,?)").run(key, JSON.stringify(intent), body);
      const terminal = manifest.terminalEvent as { sourceKey?: unknown } | null;
      if (typeof terminal?.sourceKey === "string") this.db.prepare("INSERT INTO evaluation_sources(source,key) VALUES (?,?)").run(terminal.sourceKey, key);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return key;
  }
  findIntent(attemptId: string, rubricId: string, rubricVersion: string): TaskEvaluationIntent | undefined {
    const key = createHash("sha256").update(JSON.stringify([attemptId, rubricId, rubricVersion])).digest("hex");
    const row = this.db.prepare("SELECT intent FROM evaluations WHERE key=?").get(key);
    return row ? TaskEvaluationIntentSchema.parse(JSON.parse(String(row.intent))) : undefined;
  }
  hasTerminalSource(sourceKey: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM evaluation_sources WHERE source=? LIMIT 1").get(sourceKey));
  }
  legacyMigration(): LegacyEvaluationMigration | undefined {
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='evaluation_legacy_migration'").get()) return undefined;
    const row = this.db.prepare("SELECT manifest FROM evaluation_legacy_migration WHERE singleton=1").get();
    return row ? JSON.parse(String(row.manifest)) as LegacyEvaluationMigration : undefined;
  }
  /** Invoke before any admission, replay checkpoint, or new instruction writes at FIRST
   * initialization. A single FULL transaction seals the allowlist including the empty case.
   * Failure rolls back everything and MUST keep startup/admission closed. Restart never widens it. */
  initializeLegacyTerminalSnapshot(sourceId: string, records: Iterable<LegacyInstructionSnapshot>, maxRecords = 10000): LegacyEvaluationMigration {
    if (!sourceId || sourceId.length > 256 || !Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 100000)
      throw new Error("EVALUATION_LEGACY_OPTIONS_INVALID");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.legacyMigration();
      if (prior) {
        if (prior.sourceId !== sourceId) throw new Error("EVALUATION_LEGACY_SOURCE_CONFLICT");
        this.db.exec("COMMIT"); return prior;
      }
      if (this.db.prepare("SELECT 1 FROM evaluation_checkpoints LIMIT 1").get()) throw new Error("EVALUATION_LEGACY_INITIALIZATION_TOO_LATE");
      this.db.exec(`CREATE TABLE evaluation_legacy_migration (singleton INTEGER PRIMARY KEY CHECK(singleton=1), manifest TEXT NOT NULL);
        CREATE TABLE evaluation_legacy_snapshots (source TEXT PRIMARY KEY, hash TEXT NOT NULL, result TEXT NOT NULL) WITHOUT ROWID;`);
      let count = 0;
      const hashes: string[] = [];
      for (const record of records) {
        if (++count > maxRecords) throw new Error("EVALUATION_LEGACY_SNAPSHOT_LIMIT");
        if (!["completed", "cancelled", "undelivered"].includes(record.status)
          || (record.attemptGeneration !== undefined && record.terminalActivity !== undefined)) continue;
        const sourceKey = terminalInstructionSource(record), snapshotHash = legacySnapshotHash(record);
        if (sourceKey.length > 1024) throw new Error("EVALUATION_LEGACY_SOURCE_INVALID");
        const result: LegacyEvaluationDisposition = { sourceKey, snapshotHash, disposition: "unverified", reason: "legacy-terminal-attempt-identity-unavailable" };
        this.db.prepare("INSERT INTO evaluation_legacy_snapshots VALUES (?,?,?)").run(sourceKey, snapshotHash, JSON.stringify(result));
        hashes.push(`${sourceKey}:${snapshotHash}`);
      }
      const manifest: LegacyEvaluationMigration = { schemaVersion: 1, sourceId, snapshots: hashes.length,
        snapshotHash: createHash("sha256").update(JSON.stringify([sourceId, hashes.sort()])).digest("hex") };
      this.db.prepare("INSERT INTO evaluation_legacy_migration VALUES (1,?)").run(JSON.stringify(manifest));
      this.db.exec("COMMIT"); return manifest;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  hasLegacyTerminalSnapshot(record: LegacyInstructionSnapshot): boolean {
    if (!this.legacyMigration()) return false;
    const row = this.db.prepare("SELECT hash FROM evaluation_legacy_snapshots WHERE source=?").get(terminalInstructionSource(record));
    return row?.hash === legacySnapshotHash(record);
  }
  legacyDispositions(afterSource = "", limit = 100): LegacyEvaluationDisposition[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("EVALUATION_PAGE_LIMIT");
    if (!this.legacyMigration()) return [];
    return this.db.prepare("SELECT result FROM evaluation_legacy_snapshots WHERE source>? ORDER BY source LIMIT ?").all(afterSource, limit)
      .map(row => JSON.parse(String(row.result)) as LegacyEvaluationDisposition);
  }
  checkpoint(consumer: string): EvaluationReplayCheckpoint | undefined {
    const row = this.db.prepare("SELECT source,sequence FROM evaluation_checkpoints WHERE consumer=?").get(consumer);
    return row ? { sourceId: String(row.source), sequence: Number(row.sequence) } : undefined;
  }
  /** The caller must durably enqueue each terminal event before advancing this cursor. */
  advanceCheckpoint(consumer: string, sourceId: string, expectedSequence: number, sequence: number): void {
    if (!/^[a-zA-Z0-9:_-]{1,128}$/.test(consumer) || !sourceId || !Number.isSafeInteger(expectedSequence)
      || expectedSequence < 0 || !Number.isSafeInteger(sequence) || sequence < expectedSequence) throw new Error("EVALUATION_CHECKPOINT_INVALID");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.checkpoint(consumer);
      if (prior && (prior.sourceId !== sourceId || prior.sequence !== expectedSequence) || !prior && expectedSequence !== 0)
        throw new Error("EVALUATION_CHECKPOINT_CONFLICT");
      this.db.prepare("INSERT INTO evaluation_checkpoints VALUES (?,?,?) ON CONFLICT(consumer) DO UPDATE SET sequence=excluded.sequence").run(consumer, sourceId, sequence);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  claim(now: number, leaseMs: number): EvaluationClaim | undefined {
    if (!Number.isFinite(now) || !Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 300000) throw new Error("EVALUATION_LEASE_INVALID");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT key,intent,manifest FROM evaluations WHERE result IS NULL AND (token IS NULL OR expires<=?) ORDER BY rowid LIMIT 1").get(now);
      if (!row) { this.db.exec("COMMIT"); return undefined; }
      const token = randomUUID(), expiresAt = now + leaseMs;
      this.db.prepare("UPDATE evaluations SET token=?,expires=? WHERE key=?").run(token, expiresAt, String(row.key));
      this.db.exec("COMMIT");
      return { key: String(row.key), token, expiresAt, intent: JSON.parse(String(row.intent)) as TaskEvaluationIntent, manifest: JSON.parse(String(row.manifest)) as EvaluationEvidenceManifest };
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
  finish(claim: EvaluationClaim, result: TaskEvaluationResult, now: number): void {
    TaskEvaluationResultSchema.parse(result);
    const row = this.db.prepare("SELECT token,expires,result FROM evaluations WHERE key=?").get(claim.key);
    if (row?.token !== claim.token) throw new Error("EVALUATION_STALE_CLAIM");
    if (row.result) { if (row.result !== JSON.stringify(result)) throw new Error("EVALUATION_RESULT_CONFLICT"); return; }
    if (Number(row.expires) <= now) throw new Error("EVALUATION_STALE_CLAIM");
    const changed = this.db.prepare("UPDATE evaluations SET result=? WHERE key=? AND token=? AND result IS NULL").run(JSON.stringify(result), claim.key, claim.token);
    if (!changed.changes) throw new Error("EVALUATION_STALE_CLAIM");
  }
  acknowledge(key: string): void {
    const changed = this.db.prepare("UPDATE evaluations SET acknowledged=1,manifest=NULL WHERE key=? AND result IS NOT NULL").run(key);
    if (!changed.changes) throw new Error("EVALUATION_RESULT_REQUIRED");
  }
  /** Recover result-write-before-ack without invoking a model or regrading. */
  unacknowledged(limit = 100): { key: string; result: TaskEvaluationResult }[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("EVALUATION_PAGE_LIMIT");
    return this.db.prepare("SELECT key,result FROM evaluations WHERE result IS NOT NULL AND acknowledged=0 ORDER BY rowid LIMIT ?").all(limit)
      .map(row => ({ key: String(row.key), result: TaskEvaluationResultSchema.parse(JSON.parse(String(row.result))) }));
  }
  result(key: string): TaskEvaluationResult | undefined {
    const row = this.db.prepare("SELECT result FROM evaluations WHERE key=?").get(key);
    return row?.result ? JSON.parse(String(row.result)) as TaskEvaluationResult : undefined;
  }
  health(): { pending: number; unacknowledged: number; pinned: number; bytes: number; capBytes: number } {
    const count = (where: string): number => Number(this.db.prepare(`SELECT count(*) AS n FROM evaluations WHERE ${where}`).get()!.n);
    return { pending: count("result IS NULL"), unacknowledged: count("result IS NOT NULL AND acknowledged=0"), pinned: count("manifest IS NOT NULL"), bytes: Number(this.db.prepare("PRAGMA page_count").get()!.page_count) * 4096, capBytes: this.maxBytes };
  }
  close(): void { this.db.close(); }
}
