import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
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
  receipts: z.array(MutationReceiptSchema).default([]),
});

export interface CoordinationTransaction {
  subjects?: OwnershipSubject[];
  events?: StoredWorkerEvent[];
  checkpoints?: CheckpointRequest[];
  audits?: OwnershipAuditRecord[];
  liveness?: ControllerLiveness[];
  receipts?: MutationReceipt[];
}

export interface WorkerCoordinationState {
  subjects: OwnershipSubject[];
  events: StoredWorkerEvent[];
  checkpoints: CheckpointRequest[];
  audits: OwnershipAuditRecord[];
  liveness: ControllerLiveness[];
  receipts: MutationReceipt[];
}

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
    const content = await readFile(this.path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const subjects = new Map<string, OwnershipSubject>();
    const events = new Map<string, StoredWorkerEvent>();
    const checkpoints = new Map<string, CheckpointRequest>();
    const liveness = new Map<string, ControllerLiveness>();
    const receipts = new Map<string, MutationReceipt>();
    const audits: OwnershipAuditRecord[] = [];
    if (content.length === 0) {
      return { subjects: [], events: [], checkpoints: [], audits, liveness: [], receipts: [] };
    }

    const lines = content.split("\n");
    if (content.endsWith("\n")) lines.pop();
    else lines.pop(); // Ignore only crash-shaped final fragment.
    const transactionIds = new Set<string>();
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line === undefined || line.trim() === "") {
        throw new WorkerCoordinationStoreError(
          "STORE_CORRUPT",
          `Blank worker coordination record at line ${index + 1}`,
          index + 1,
        );
      }
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch (error) {
        throw new WorkerCoordinationStoreError(
          "STORE_CORRUPT",
          `Invalid worker coordination JSON at line ${index + 1}: ${
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
          `Unsupported worker coordination schema version ${version} at line ${index + 1}`,
          index + 1,
        );
      }
      assertSupportedVersions(raw, index + 1);
      const parsed = CoordinationTransactionSchema.safeParse(raw);
      if (!parsed.success) {
        throw new WorkerCoordinationStoreError(
          "STORE_CORRUPT",
          `Invalid worker coordination record at line ${index + 1}: ${z.prettifyError(parsed.error)}`,
          index + 1,
        );
      }
      if (transactionIds.has(parsed.data.transactionId)) {
        throw new WorkerCoordinationStoreError(
          "DUPLICATE_TRANSACTION_ID",
          `Duplicate worker coordination transaction ${parsed.data.transactionId} at line ${index + 1}`,
          index + 1,
        );
      }
      transactionIds.add(parsed.data.transactionId);
      for (const subject of parsed.data.subjects) subjects.set(subject.subjectId, subject);
      for (const event of parsed.data.events) events.set(event.eventId, event);
      for (const checkpoint of parsed.data.checkpoints) {
        checkpoints.set(checkpoint.correlationId, checkpoint);
      }
      for (const entry of parsed.data.liveness) {
        liveness.set(entry.controller.controllerId, entry);
      }
      for (const receipt of parsed.data.receipts) receipts.set(receipt.mutationId, receipt);
      audits.push(...parsed.data.audits);
    }

    return {
      subjects: [...subjects.values()],
      events: [...events.values()].sort((left, right) => left.ordinal - right.ordinal),
      checkpoints: [...checkpoints.values()],
      audits,
      liveness: [...liveness.values()],
      receipts: [...receipts.values()],
    };
  }
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
