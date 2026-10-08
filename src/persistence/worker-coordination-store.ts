import { randomUUID } from "node:crypto";
import { open, rename, stat, unlink, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  CheckpointRequestSchema,
  ControllerLivenessSchema,
  MutationReceiptSchema,
  OwnershipAuditRecordSchema,
  OwnershipSubjectSchema,
  StoredWorkerEventSchema,
  WORKER_COORDINATION_SCHEMA_VERSION,
  type CheckpointRequest,
  type ControllerLiveness,
  type MutationReceipt,
  type OwnershipAuditRecord,
  type OwnershipSubject,
  type StoredWorkerEvent,
} from "../domain/worker-coordination.js";
import type {
  CoordinationTransaction,
  WorkerCoordinationState,
} from "../domain/worker-coordination-state.js";
import { WorkerHandoffSchema, type WorkerHandoff } from "../domain/worker-handoff.js";
import { openPrivateAppendFile } from "./private-files.js";

const CoordinationTransactionSchema = z.object({
  schemaVersion: z.literal(WORKER_COORDINATION_SCHEMA_VERSION),
  recordType: z.literal("worker-coordination.transaction"),
  transactionId: z.uuid(),
  persistedAt: z.iso.datetime(),
  subjects: z.array(OwnershipSubjectSchema).default([]),
  events: z.array(StoredWorkerEventSchema).default([]),
  checkpoints: z.array(CheckpointRequestSchema).default([]),
  audits: z.array(OwnershipAuditRecordSchema).default([]),
  liveness: z.array(ControllerLivenessSchema).default([]),
  /**
   * Directed handoffs. Defaulted, like every array here, so a log written before handoffs existed
   * still parses — the field is absent on those lines, not empty, and the two must read alike.
   */
  handoffs: z.array(WorkerHandoffSchema).default([]),
  receipts: z.array(MutationReceiptSchema).default([]),
});

export type {
  CoordinationTransaction,
  WorkerCoordinationState,
} from "../domain/worker-coordination-state.js";

export class WorkerCoordinationStoreError extends Error {
  constructor(
    readonly code:
      | "STORE_CORRUPT"
      | "SCHEMA_VERSION_UNSUPPORTED"
      | "DUPLICATE_TRANSACTION_ID",
    message: string,
    readonly line?: number,
  ) {
    super(message);
    this.name = "WorkerCoordinationStoreError";
  }
}

export interface WorkerCoordinationStoreOptions {
  now?: () => string;
  idFactory?: () => string;
  /** Overridable so a test can exercise compaction without writing the production threshold. */
  compactionThresholdBytes?: number;
  retainedReceipts?: number;
}

/**
 * Receipts kept by a compaction. A receipt is an idempotency key: it exists so a mutation replayed
 * by a client that lost the response is answered instead of re-run. That window is one call's
 * lifetime, not the broker's, so a bounded tail serves every replay that can still arrive while an
 * unbounded set serves none of them and costs a kilobyte per mutation forever.
 */
const RETAINED_RECEIPTS = 2_000;

/**
 * When a compaction is worth doing. Below this the fold costs more than the read it saves; above it
 * the log has begun to dominate startup, and left alone it ends at V8's ~512 MB string cap, which
 * is where the broker stops starting at all rather than merely starting slowly.
 */
const COMPACTION_THRESHOLD_BYTES = 128 * 1024 * 1024;

export interface WorkerCoordinationCompaction {
  compacted: boolean;
  beforeBytes: number;
  afterBytes: number;
  records: number;
  archivedAudits: number;
}

/**
 * Atomic append-only transaction log for ownership, reports, checkpoints, and audit.
 * One fsynced line contains every state change from one broker mutation.
 */
export class WorkerCoordinationStore {
  readonly path: string;
  private writeTail = Promise.resolve();

  constructor(
    stateDirectory: string,
    private readonly options: WorkerCoordinationStoreOptions = {},
  ) {
    this.path = join(stateDirectory, "orchestration", "worker-coordination-v1.jsonl");
  }

  async append(transaction: CoordinationTransaction): Promise<void> {
    const envelope = CoordinationTransactionSchema.parse({
      schemaVersion: WORKER_COORDINATION_SCHEMA_VERSION,
      recordType: "worker-coordination.transaction",
      transactionId: this.options.idFactory?.() ?? randomUUID(),
      persistedAt: this.options.now?.() ?? new Date().toISOString(),
      subjects: transaction.subjects ?? [],
      events: transaction.events ?? [],
      checkpoints: transaction.checkpoints ?? [],
      audits: transaction.audits ?? [],
      liveness: transaction.liveness ?? [],
      handoffs: transaction.handoffs ?? [],
      receipts: transaction.receipts ?? [],
    });
    assertSupportedVersions(envelope);
    const write = async (): Promise<void> => {
      const handle = await openPrivateAppendFile(this.path);
      try {
        await handle.write(`${JSON.stringify(envelope)}\n`, undefined, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    };
    // Chain on settle, not on success: one failed append must not poison every later append.
    this.writeTail = this.writeTail.then(write, write);
    await this.writeTail;
  }

  async load(): Promise<WorkerCoordinationState> {
    await this.writeTail;
    const subjects = new Map<string, OwnershipSubject>();
    const events = new Map<string, StoredWorkerEvent>();
    const checkpoints = new Map<string, CheckpointRequest>();
    const liveness = new Map<string, ControllerLiveness>();
    const handoffs = new Map<string, WorkerHandoff>();
    const receipts = new Map<string, MutationReceipt>();
    const audits: OwnershipAuditRecord[] = [];
    const transactionIds = new Set<string>();
    let lineNumber = 0;
    for await (const line of readCompleteRecords(this.path)) {
      lineNumber += 1;
      const record = parseRecord(line, lineNumber, transactionIds);
      for (const subject of record.subjects) subjects.set(subject.subjectId, subject);
      for (const event of record.events) events.set(event.eventId, event);
      for (const checkpoint of record.checkpoints) {
        checkpoints.set(checkpointKey(checkpoint.workerId, checkpoint.correlationId), checkpoint);
      }
      for (const entry of record.liveness) {
        liveness.set(entry.controller.controllerId, entry);
      }
      for (const handoff of record.handoffs) handoffs.set(handoff.handoffId, handoff);
      for (const receipt of record.receipts) receipts.set(receipt.mutationId, receipt);
      for (const audit of record.audits) audits.push(audit);
    }

    return {
      subjects: [...subjects.values()],
      events: [...events.values()].sort((left, right) => left.ordinal - right.ordinal),
      checkpoints: [...checkpoints.values()],
      audits,
      liveness: [...liveness.values()],
      handoffs: [...handoffs.values()],
      receipts: [...receipts.values()],
    };
  }

  /** Where a compaction puts the audit trail. Never read at startup, so its growth is harmless. */
  get auditArchivePath(): string {
    return join(dirname(this.path), "worker-coordination-audits-archive.jsonl");
  }

  /**
   * Compact only once the log is big enough for it to pay. Called at startup, before the fold.
   */
  async compactIfLarge(): Promise<WorkerCoordinationCompaction> {
    const beforeBytes = await this.size();
    if (beforeBytes < (this.options.compactionThresholdBytes ?? COMPACTION_THRESHOLD_BYTES)) {
      return { compacted: false, beforeBytes, afterBytes: beforeBytes, records: 0, archivedAudits: 0 };
    }
    const operation = this.writeTail.then(() => this.rewrite(), () => this.rewrite());
    this.writeTail = operation.then(() => {}, () => {});
    return operation;
  }

  private async size(): Promise<number> {
    return stat(this.path).then((stats) => stats.size).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return 0;
      throw error;
    });
  }

  /**
   * Replace the log with a single record holding the same folded state.
   *
   * Every collection here is last-write-wins by id, so one record carrying the folded maps replays
   * to exactly the state the whole log replays to — compaction loses no ownership, no lease and no
   * pending event. The two unbounded collections are the ones that do not fold: receipts accumulate
   * one per mutation forever, and audits are pure history. Receipts keep a bounded tail; audits move
   * to an archive beside the log, which keeps the trail on disk without keeping it in the broker's
   * startup path.
   *
   * The replacement is fsynced and renamed, so a crash leaves the previous log intact rather than a
   * prefix of the new one. Audits are archived before that rename, so the same crash can duplicate
   * archived audits on the next attempt; the archive is an append-only sink nothing parses, and
   * duplicate history is the right side to err on against losing it.
   */
  private async rewrite(): Promise<WorkerCoordinationCompaction> {
    const beforeBytes = await this.size();
    const directory = dirname(this.path);
    const subjects = new Map<string, OwnershipSubject>();
    const events = new Map<string, StoredWorkerEvent>();
    const checkpoints = new Map<string, CheckpointRequest>();
    const liveness = new Map<string, ControllerLiveness>();
    const handoffs = new Map<string, WorkerHandoff>();
    const transactionIds = new Set<string>();
    // The newest receipts in file order, which is append order; trimmed in batches so the window
    // never grows with the log.
    const keep = this.options.retainedReceipts ?? RETAINED_RECEIPTS;
    let window: MutationReceipt[] = [];
    let records = 0;
    let archivedAudits = 0;

    const archive = await openPrivateAppendFile(this.auditArchivePath);
    try {
      let batch = "";
      for await (const line of readCompleteRecords(this.path)) {
        records += 1;
        const record = parseRecord(line, records, transactionIds);
        for (const subject of record.subjects) subjects.set(subject.subjectId, subject);
        for (const event of record.events) events.set(event.eventId, event);
        for (const checkpoint of record.checkpoints) {
          checkpoints.set(checkpointKey(checkpoint.workerId, checkpoint.correlationId), checkpoint);
        }
        for (const entry of record.liveness) liveness.set(entry.controller.controllerId, entry);
        for (const handoff of record.handoffs) handoffs.set(handoff.handoffId, handoff);
        for (const receipt of record.receipts) window.push(receipt);
        if (window.length > keep * 2) window = window.slice(-keep);
        for (const audit of record.audits) {
          batch += `${JSON.stringify(audit)}\n`;
          archivedAudits += 1;
        }
        if (batch.length > 1024 * 1024) {
          await archive.writeFile(batch, "utf8");
          batch = "";
        }
      }
      if (batch.length > 0) await archive.writeFile(batch, "utf8");
      await archive.sync();
    } finally {
      await archive.close();
    }
    // Persist a newly created archive's directory entry before replacing its source log.
    const archiveParent = await open(directory, "r");
    try { await archiveParent.sync(); } finally { await archiveParent.close(); }

    const retained = new Map<string, MutationReceipt>();
    for (const receipt of window) retained.set(receipt.mutationId, receipt);
    const receipts = [...retained.values()]
      .sort((left, right) => Date.parse(left.recordedAt) - Date.parse(right.recordedAt))
      .slice(-keep);

    const envelope = CoordinationTransactionSchema.parse({
      schemaVersion: WORKER_COORDINATION_SCHEMA_VERSION,
      recordType: "worker-coordination.transaction",
      transactionId: this.options.idFactory?.() ?? randomUUID(),
      persistedAt: this.options.now?.() ?? new Date().toISOString(),
      subjects: [...subjects.values()],
      events: [...events.values()].sort((left, right) => left.ordinal - right.ordinal),
      checkpoints: [...checkpoints.values()],
      audits: [],
      liveness: [...liveness.values()],
      handoffs: [...handoffs.values()],
      receipts,
    });
    assertSupportedVersions(envelope);

    const temporary = `${this.path}.${randomUUID()}.compacting`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(`${JSON.stringify(envelope)}\n`);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, this.path);
      const parent = await open(directory, "r");
      try { await parent.sync(); } finally { await parent.close(); }
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    return { compacted: true, beforeBytes, afterBytes: await this.size(), records, archivedAudits };
  }
}

type CoordinationRecord = z.infer<typeof CoordinationTransactionSchema>;

/**
 * One record's worth of validation, shared by the fold and the compaction that rewrites it.
 *
 * They must agree exactly: a compaction that accepted what `load` rejects would quietly launder a
 * corrupt log into a clean one, and the corruption would surface later with its evidence gone.
 */
function parseRecord(line: string, lineNumber: number, transactionIds: Set<string>): CoordinationRecord {
  if (line.trim() === "") {
    throw new WorkerCoordinationStoreError(
      "STORE_CORRUPT",
      `Blank worker coordination record at line ${lineNumber}`,
      lineNumber,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch (error) {
    throw new WorkerCoordinationStoreError(
      "STORE_CORRUPT",
      `Invalid worker coordination JSON at line ${lineNumber}: ${
        error instanceof Error ? error.message : "parse failed"
      }`,
      lineNumber,
    );
  }
  const version = typeof raw === "object" && raw !== null && "schemaVersion" in raw
    ? (raw as { schemaVersion?: unknown }).schemaVersion
    : undefined;
  if (typeof version === "number" && version !== WORKER_COORDINATION_SCHEMA_VERSION) {
    throw new WorkerCoordinationStoreError(
      "SCHEMA_VERSION_UNSUPPORTED",
      `Unsupported worker coordination schema version ${version} at line ${lineNumber}`,
      lineNumber,
    );
  }
  assertSupportedVersions(raw, lineNumber);
  const parsed = CoordinationTransactionSchema.safeParse(raw);
  if (!parsed.success) {
    throw new WorkerCoordinationStoreError(
      "STORE_CORRUPT",
      `Invalid worker coordination record at line ${lineNumber}: ${z.prettifyError(parsed.error)}`,
      lineNumber,
    );
  }
  if (transactionIds.has(parsed.data.transactionId)) {
    throw new WorkerCoordinationStoreError(
      "DUPLICATE_TRANSACTION_ID",
      `Duplicate worker coordination transaction ${parsed.data.transactionId} at line ${lineNumber}`,
      lineNumber,
    );
  }
  transactionIds.add(parsed.data.transactionId);
  return parsed.data;
}

/**
 * Complete, newline-terminated records, one at a time.
 *
 * The whole log must never become a single JS string: past V8's ~512 MB cap that throws
 * `Invalid string length` and the broker cannot start at all — the log is the first thing it reads
 * and nothing downstream runs. Reading it in bounded chunks makes startup independent of how long
 * the log has grown, so a big log is slow to fold, never impossible to open.
 *
 * A trailing fragment with no newline is a crash-shaped tail and is dropped, which is exactly what
 * the split-and-pop this replaces did. A missing file yields no records rather than an error.
 */
async function* readCompleteRecords(path: string): AsyncGenerator<string> {
  let handle: FileHandle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  try {
    const size = (await handle.stat()).size;
    const buffer = Buffer.alloc(64 * 1024);
    let partial = Buffer.alloc(0);
    let position = 0;
    while (position < size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - position), position);
      if (!bytesRead) break;
      position += bytesRead;
      partial = Buffer.concat([partial, buffer.subarray(0, bytesRead)]);
      let newline: number;
      while ((newline = partial.indexOf(10)) >= 0) {
        yield partial.subarray(0, newline).toString("utf8");
        partial = partial.subarray(newline + 1);
      }
    }
  } finally {
    await handle.close();
  }
}

function checkpointKey(workerId: string, correlationId: string): string {
  return `${workerId}\0${correlationId}`;
}

function assertSupportedVersions(value: unknown, line?: number): void {
  if (Array.isArray(value)) {
    for (const item of value) assertSupportedVersions(item, line);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const object = value as Record<string, unknown>;
  if (
    typeof object.schemaVersion === "number"
    && object.schemaVersion !== WORKER_COORDINATION_SCHEMA_VERSION
  ) {
    throw new WorkerCoordinationStoreError(
      "SCHEMA_VERSION_UNSUPPORTED",
      `Unsupported worker coordination schema version ${object.schemaVersion}${
        line === undefined ? "" : ` at line ${line}`
      }`,
      line,
    );
  }
  for (const child of Object.values(object)) assertSupportedVersions(child, line);
}
