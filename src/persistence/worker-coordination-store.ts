import { randomUUID } from "node:crypto";
import { link, open, rename, stat, unlink } from "node:fs/promises";
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
import { ensurePrivateDirectory, openPrivateAppendFile } from "./private-files.js";
import { completeJsonlLines } from "./complete-jsonl-lines.js";

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
  /** Bytes of growth before a lossless checkpoint is considered. */
  checkpointBytes?: number;
  onCheckpointError?: (error: unknown) => void;
}

/**
 * Atomic append-only transaction log for ownership, reports, checkpoints, and audit.
 * One fsynced line contains every state change from one broker mutation.
 */
export class WorkerCoordinationStore {
  readonly path: string;
  private writeTail = Promise.resolve();
  private checkpointAt: number;

  constructor(
    stateDirectory: string,
    private readonly options: WorkerCoordinationStoreOptions = {},
  ) {
    this.path = join(stateDirectory, "orchestration", "worker-coordination-v1.jsonl");
    this.checkpointAt = this.options.checkpointBytes ?? 64 * 1024 * 1024;
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
      // Maintenance cannot turn an already-fsynced mutation into a reported failure.
      await this.maybeCheckpoint();
    };
    // Chain on settle, not on success: one failed append must not poison every later append.
    this.writeTail = this.writeTail.then(write, write);
    await this.writeTail;
  }

  async load(): Promise<WorkerCoordinationState> {
    const load = async () => {
      const state = await this.replay();
      await this.maybeCheckpoint();
      return state;
    };
    const operation = this.writeTail.then(load, load);
    this.writeTail = operation.then(() => {}, () => {});
    return operation;
  }

  private async replay(): Promise<WorkerCoordinationState> {
    const subjects = new Map<string, OwnershipSubject>();
    const events = new Map<string, StoredWorkerEvent>();
    const checkpoints = new Map<string, CheckpointRequest>();
    const liveness = new Map<string, ControllerLiveness>();
    const handoffs = new Map<string, WorkerHandoff>();
    const receipts = new Map<string, MutationReceipt>();
    const audits: OwnershipAuditRecord[] = [];
    const transactionIds = new Set<string>();
    let index = -1;
    for await (const line of completeJsonlLines(this.path)) {
      index++;
      const envelope = parseCoordinationLine(line, index, transactionIds, this.path);
      for (const subject of envelope.subjects) subjects.set(subject.subjectId, subject);
      for (const event of envelope.events) events.set(event.eventId, event);
      for (const checkpoint of envelope.checkpoints) {
        checkpoints.set(checkpointKey(checkpoint.workerId, checkpoint.correlationId), checkpoint);
      }
      for (const entry of envelope.liveness) {
        liveness.set(entry.controller.controllerId, entry);
      }
      for (const handoff of envelope.handoffs) handoffs.set(handoff.handoffId, handoff);
      for (const receipt of envelope.receipts) receipts.set(receipt.mutationId, receipt);
      for (const audit of envelope.audits) audits.push(audit);
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

  private async maybeCheckpoint(): Promise<void> {
    try {
      const info = await stat(this.path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (info === undefined || info.size < this.checkpointAt) return;
      // Retained audit/receipt history is never expired. Doubling the trigger avoids repeatedly
      // rewriting a journal whose irreducible history already exceeds the initial threshold.
      this.checkpointAt = Math.max(this.checkpointAt * 2, info.size * 2);
      await this.checkpoint();
    } catch (error) {
      try {
        if (this.options.onCheckpointError !== undefined) this.options.onCheckpointError(error);
        else console.error(`Worker coordination checkpoint failed (${this.path})`, error);
      } catch { /* Observation cannot invalidate an acknowledged append. */ }
    }
  }

  /** Remove intermediate snapshots, retaining every transaction id, receipt and audit. */
  private async checkpoint(): Promise<void> {
    const source = await open(this.path, "r");
    try { await source.chmod(0o600); } finally { await source.close(); }
    const before = await stat(this.path, { bigint: true });
    type Envelope = z.infer<typeof CoordinationTransactionSchema>;
    const keys = {
      subjects: (entry: OwnershipSubject) => entry.subjectId,
      events: (entry: StoredWorkerEvent) => entry.eventId,
      checkpoints: (entry: CheckpointRequest) => checkpointKey(entry.workerId, entry.correlationId),
      liveness: (entry: ControllerLiveness) => entry.controller.controllerId,
      handoffs: (entry: WorkerHandoff) => entry.handoffId,
    };
    // Keep the first snapshot as well as the latest: Map insertion order is part of replay's
    // existing result, and deleting a key's first appearance would silently reorder subjects.
    const latest = new Map<string, { first: string; last: string }>();
    function entries(envelope: Envelope, keep: boolean): void {
      for (const field of Object.keys(keys) as Array<keyof typeof keys>) {
        // The field selects its schema-validated entry type and key function together.
        const key = keys[field] as (entry: unknown) => string;
        const values = envelope[field];
        if (keep) {
          (envelope[field] as unknown[]) = values.filter((entry) => {
            const retained = latest.get(`${field}:${key(entry)}`);
            return retained?.first === envelope.transactionId || retained?.last === envelope.transactionId;
          });
        } else {
          for (const entry of values) {
            const id = `${field}:${key(entry)}`;
            latest.set(id, { first: latest.get(id)?.first ?? envelope.transactionId, last: envelope.transactionId });
          }
        }
      }
    }
    const transactionIds = new Set<string>();
    let index = -1;
    // Validate every committed record before writing a replacement, without materializing another
    // full audit/receipt projection alongside the startup replay result.
    for await (const line of completeJsonlLines(this.path)) {
      entries(parseCoordinationLine(line, ++index, transactionIds, this.path), false);
    }
    await ensurePrivateDirectory(dirname(this.path));
    const temporary = `${this.path}.${randomUUID()}.checkpoint`;
    const archive = `${this.path}.${randomUUID()}.archive`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        let batch: string[] = [];
        let bytes = 0;
        for await (const line of completeJsonlLines(this.path)) {
          const envelope = CoordinationTransactionSchema.parse(JSON.parse(line));
          entries(envelope, true);
          const written = `${JSON.stringify(envelope)}\n`;
          batch.push(written);
          bytes += Buffer.byteLength(written);
          if (bytes >= 1024 * 1024) {
            await file.writeFile(batch.join(""));
            batch = [];
            bytes = 0;
          }
        }
        if (batch.length > 0) await file.writeFile(batch.join(""));
        await file.sync();
      } finally { await file.close(); }
      const after = await stat(this.path, { bigint: true });
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
        throw new Error("Worker coordination journal changed during checkpoint");
      }
      const compacted = await stat(temporary);
      if (compacted.size >= Number(before.size) * 0.75) return;
      // Link and fsync the original before atomically installing the checkpoint. A crash leaves
      // either the original or its equivalent checkpoint at the authority path, plus full history.
      await link(this.path, archive);
      const directory = await open(dirname(this.path), "r");
      try {
        await directory.sync();
        await rename(temporary, this.path);
        await directory.sync();
      } finally { await directory.close(); }
      this.checkpointAt = Math.max(this.options.checkpointBytes ?? 64 * 1024 * 1024, compacted.size * 2);
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
}

function parseCoordinationLine(
  line: string,
  index: number,
  transactionIds: Set<string>,
  path: string,
): z.infer<typeof CoordinationTransactionSchema> {
  if (line === undefined || line.trim() === "") {
    throw new WorkerCoordinationStoreError(
      "STORE_CORRUPT",
      `Blank worker coordination record in ${path} at line ${index + 1}`,
      index + 1,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch (error) {
    throw new WorkerCoordinationStoreError(
      "STORE_CORRUPT",
      `Invalid worker coordination JSON in ${path} at line ${index + 1}: ${
        error instanceof Error ? error.message : "parse failed"
      }`,
      index + 1,
    );
  }
  const version = typeof raw === "object" && raw !== null && "schemaVersion" in raw
    ? (raw as { schemaVersion?: unknown }).schemaVersion
    : undefined;
  if (typeof version === "number" && version !== WORKER_COORDINATION_SCHEMA_VERSION) {
    throw new WorkerCoordinationStoreError(
      "SCHEMA_VERSION_UNSUPPORTED",
      `Unsupported worker coordination schema version ${version} in ${path} at line ${index + 1}`,
      index + 1,
    );
  }
  assertSupportedVersions(raw, index + 1, path);
  const parsed = CoordinationTransactionSchema.safeParse(raw);
  if (!parsed.success) {
    throw new WorkerCoordinationStoreError(
      "STORE_CORRUPT",
      `Invalid worker coordination record in ${path} at line ${index + 1}: ${z.prettifyError(parsed.error)}`,
      index + 1,
    );
  }
  if (transactionIds.has(parsed.data.transactionId)) {
    throw new WorkerCoordinationStoreError(
      "DUPLICATE_TRANSACTION_ID",
      `Duplicate worker coordination transaction ${parsed.data.transactionId} in ${path} at line ${index + 1}`,
      index + 1,
    );
  }
  transactionIds.add(parsed.data.transactionId);
  return parsed.data;
}

function checkpointKey(workerId: string, correlationId: string): string {
  return `${workerId}\0${correlationId}`;
}

function assertSupportedVersions(value: unknown, line?: number, path?: string): void {
  if (Array.isArray(value)) {
    for (const item of value) assertSupportedVersions(item, line, path);
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
      `Unsupported worker coordination schema version ${object.schemaVersion}${path === undefined ? "" : ` in ${path}`}${
        line === undefined ? "" : ` at line ${line}`
      }`,
      line,
    );
  }
  for (const child of Object.values(object)) assertSupportedVersions(child, line, path);
}
