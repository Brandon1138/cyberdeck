import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  CONTROL_PLANE_SCHEMA_VERSION,
  CorrelationIdSchema,
  JobIdSchema,
  SessionIdSchema,
  TimestampSchema,
  schemaVersionField,
  type ControlPlaneErrorCode,
  type CorrelationId,
  type JobId,
} from "../domain/control-plane.js";
import { DelegationIntentSchema, type DelegationIntent } from "../domain/delegation.js";
import {
  CancellationRequestSchema,
  CancellationResultSchema,
  DispatchRequestSchema,
  type CancellationResult,
  type JobDispatchAdapter,
} from "../domain/dispatch.js";
import type { BrokerEvent, BrokerEventType } from "../domain/events.js";
import {
  JobReportSchema,
  JobRequestSchema,
  JobResultSchema,
  type JobRecord,
  type JobRequest,
  type JobResult,
} from "../domain/job.js";
import { evaluateClaudeLaunchSafety, isFableModel } from "../domain/policy.js";
import {
  validateRegisteredProvider,
  type ProviderRegistry,
} from "../domain/provider-registration.js";
import { UsageReportSchema, type UsageReport } from "../domain/usage.js";

/**
 * Every code the control plane can surface. It is the frozen cross-process vocabulary plus the two
 * live-launch safety codes (a delegated Fable request and a Claude launch without an explicit
 * non-Fable model). Stored terminal {@link JobResult} errors still use only the frozen enum; these
 * extra codes are for the synchronous rejections that happen *before* a job is even dispatched.
 */
export type ControlPlaneErrorClassCode =
  | ControlPlaneErrorCode
  | "FABLE_REQUIRES_EXPLICIT_HUMAN_START"
  | "CLAUDE_LAUNCH_REQUIRES_EXPLICIT_NON_FABLE_MODEL";

export class ControlPlaneError extends Error {
  constructor(
    readonly code: ControlPlaneErrorClassCode,
    message: string,
  ) {
    super(message);
    this.name = "ControlPlaneError";
  }
}

export const ReportBackStateSchema = z.enum(["pending", "delivered", "failed"]);
export type ReportBackState = z.infer<typeof ReportBackStateSchema>;

/**
 * A durable, idempotent handoff of a settled child job to its parent/caller. Settlement alone never
 * marks a job reported: a handoff starts `pending` and only reaches `delivered` when the parent
 * explicitly acknowledges it. A failed delivery is retryable, tracked by `attempts`/`lastError`.
 */
export const ReportBackRecordSchema = z.object({
  schemaVersion: schemaVersionField,
  jobId: JobIdSchema,
  correlationId: CorrelationIdSchema,
  parentJobId: JobIdSchema.optional(),
  parentSessionId: SessionIdSchema.optional(),
  result: JobResultSchema,
  usage: UsageReportSchema.optional(),
  state: ReportBackStateSchema,
  attempts: z.number().int().nonnegative(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  deliveredAt: TimestampSchema.optional(),
  lastError: z.string().optional(),
});
export type ReportBackRecord = z.infer<typeof ReportBackRecordSchema>;

/**
 * The terminal result envelope the control plane stores and exposes: the job record (status,
 * result summary/error, structured artifact references, and provenance — provider, correlation,
 * parent, timestamps), the reported `usage` (absent when the provider did not report it), and the
 * report-back handoff state for delegated jobs.
 */
export interface JobSnapshot {
  record: JobRecord;
  usage?: UsageReport;
  reportBack?: ReportBackRecord;
}

/** Complete durable state for one job. Runtime handles are deliberately excluded. */
export interface PersistedJobState extends JobSnapshot {
  idempotencyKey: string;
  parentSessionId?: string;
}

/** Narrow persistence port implemented by the append-only A3 job store. */
export interface JobStateRepository {
  append(state: PersistedJobState): Promise<void>;
  load(): Promise<PersistedJobState[]>;
}

export interface SubmitResult {
  job: JobRecord;
  /** True when an identical idempotency key was already submitted; no new job was created. */
  deduplicated: boolean;
}

export type IngestResult = {
  status: "settled" | "interrupted" | "already-settled" | "unknown-job";
  jobId: JobId;
};

interface JournalLike {
  append(event: BrokerEvent): Promise<void>;
}

export interface JobControlPlaneOptions {
  registry: ProviderRegistry;
  journal?: JournalLike;
  store?: JobStateRepository;
  now?: () => string;
  idFactory?: () => string;
}

/** Typed broker-facing parameter schemas — preferred over ad hoc `unknown` params. */
export const SubmitJobParamsSchema = z.object({
  request: JobRequestSchema,
  idempotencyKey: z.string().min(1),
  correlationId: CorrelationIdSchema.optional(),
  sessionId: SessionIdSchema.optional(),
});
export type SubmitJobParams = z.infer<typeof SubmitJobParamsSchema>;

export const GetJobParamsSchema = z.object({ jobId: JobIdSchema });
export const CancelJobParamsSchema = z.object({
  jobId: JobIdSchema,
  reason: z.string().optional(),
});
export const IngestReportParamsSchema = z.object({ report: JobReportSchema });
export const AcknowledgeReportParamsSchema = z.object({ jobId: JobIdSchema });

interface JobEntry {
  record: JobRecord;
  idempotencyKey: string;
  parentSessionId?: string;
  usage?: UsageReport;
  reportBack?: ReportBackRecord;
}

interface CreateSpec {
  request: JobRequest;
  idempotencyKey: string;
  correlationId: CorrelationId;
  parentJobId?: JobId;
  parentSessionId?: string;
  sessionId?: string;
  delegationId?: string;
}

/**
 * The durable job control plane. It owns all job state and lifecycle; Agent B-owned adapters
 * translate provider/runtime events through the frozen {@link JobDispatchAdapter} port, which the
 * control plane consumes but never redesigns. The control plane never ranks or routes providers: it
 * selects the explicitly requested, registered provider's adapter and calls it.
 */
export class JobControlPlane {
  private readonly jobs = new Map<string, JobEntry>();
  private readonly byIdempotencyKey = new Map<string, string>();
  private readonly adapters = new Map<string, JobDispatchAdapter>();
  private readonly unsubscribes = new Map<string, () => void>();
  private pendingReports: Promise<void> = Promise.resolve();
  private pendingReportError: unknown;

  constructor(private readonly options: JobControlPlaneOptions) {}

  /**
   * Rebuild durable state without dispatching anything. Nonterminal work belonged to a runtime
   * whose ownership cannot be verified after broker death, so it becomes explicitly interrupted.
   */
  async recover(): Promise<void> {
    if (this.options.store === undefined) return;
    const states = await this.options.store.load();
    this.jobs.clear();
    this.byIdempotencyKey.clear();

    for (const state of states) {
      const entry: JobEntry = {
        record: cloneJobRecord(state.record),
        idempotencyKey: state.idempotencyKey,
        ...(state.parentSessionId !== undefined ? { parentSessionId: state.parentSessionId } : {}),
        ...(state.usage !== undefined ? { usage: state.usage } : {}),
        ...(state.reportBack !== undefined ? { reportBack: { ...state.reportBack } } : {}),
      };
      this.jobs.set(entry.record.id, entry);
      this.byIdempotencyKey.set(entry.idempotencyKey, entry.record.id);
    }

    for (const entry of this.jobs.values()) {
      if (
        entry.record.lifecycle.status === "queued" ||
        entry.record.lifecycle.status === "dispatched" ||
        entry.record.lifecycle.status === "running"
      ) {
        const now = this.now();
        entry.record = {
          ...entry.record,
          lifecycle: {
            status: "interrupted",
            interruptedAt: now,
            reason:
              "Broker restarted; previous runtime ownership is unverifiable and explicit recovery is required",
          },
          updatedAt: now,
        };
        await this.persist(entry);
      }
    }
  }

  /**
   * Register an in-process adapter for its provider and subscribe to its report stream. Reports are
   * funneled through {@link ingestReport}, the same idempotent path used by the broker's out-of-
   * process completion ingest.
   */
  registerAdapter(adapter: JobDispatchAdapter): () => void {
    this.adapters.set(adapter.provider, adapter);
    const unsubscribe = adapter.onReport((report) => {
      this.pendingReports = this.pendingReports
        .then(async () => {
          await this.ingestReport(report);
        })
        .catch((error: unknown) => {
          this.pendingReportError = error;
        });
    });
    this.unsubscribes.set(adapter.provider, unsubscribe);
    return () => {
      unsubscribe();
      this.adapters.delete(adapter.provider);
      this.unsubscribes.delete(adapter.provider);
    };
  }

  /** Wait until asynchronously emitted adapter reports have been durably ingested. */
  async whenIdle(): Promise<void> {
    await this.pendingReports;
    if (this.pendingReportError !== undefined) throw this.pendingReportError;
  }

  async submit(input: unknown): Promise<SubmitResult> {
    const params = SubmitJobParamsSchema.parse(input);
    return this.create({
      request: params.request,
      idempotencyKey: params.idempotencyKey,
      correlationId: params.correlationId ?? this.newCorrelationId(),
      ...(params.sessionId !== undefined ? { sessionId: params.sessionId } : {}),
    });
  }

  async delegate(input: unknown): Promise<SubmitResult> {
    const intent: DelegationIntent = DelegationIntentSchema.parse(input);
    if (intent.parentJobId !== undefined && !this.jobs.has(intent.parentJobId)) {
      throw new ControlPlaneError("JOB_NOT_FOUND", `Unknown parent job ${intent.parentJobId}`);
    }
    return this.create({
      request: intent.request,
      idempotencyKey: intent.delegationId,
      correlationId: intent.correlationId,
      delegationId: intent.delegationId,
      ...(intent.parentJobId !== undefined ? { parentJobId: intent.parentJobId } : {}),
      ...(intent.parentSessionId !== undefined ? { parentSessionId: intent.parentSessionId } : {}),
    });
  }

  private async create(spec: CreateSpec): Promise<SubmitResult> {
    const existingId = this.byIdempotencyKey.get(spec.idempotencyKey);
    if (existingId !== undefined) {
      const existing = this.jobs.get(existingId);
      if (existing !== undefined) {
        return { job: cloneJobRecord(existing.record), deduplicated: true };
      }
    }

    const { request } = spec;

    const providerCheck = validateRegisteredProvider(request.provider, this.registeredIds());
    if (!providerCheck.ok) {
      throw new ControlPlaneError(
        "PROVIDER_NOT_REGISTERED",
        `Provider ${request.provider} is not registered`,
      );
    }

    // Live-launch safety runs BEFORE the launch port (adapter.dispatch) is ever invoked.
    const delegated = spec.parentJobId !== undefined || spec.parentSessionId !== undefined;
    if (delegated && isFableModel(request.model)) {
      throw new ControlPlaneError(
        "FABLE_REQUIRES_EXPLICIT_HUMAN_START",
        "A delegated job may not request a Fable model; Fable requires an explicit human start",
      );
    }
    const safety = evaluateClaudeLaunchSafety(request.provider, request.model);
    if (!safety.safe) {
      // An omitted model is unsafe here too — it is not treated as implicitly non-Fable.
      throw new ControlPlaneError(
        safety.code,
        "A live Claude launch requires an operator-verified explicit non-Fable model",
      );
    }

    const jobId = JobIdSchema.parse(this.newId());
    const now = this.now();
    const record: JobRecord = {
      schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
      id: jobId,
      correlationId: spec.correlationId,
      request,
      lifecycle: { status: "queued", enqueuedAt: now },
      createdAt: now,
      updatedAt: now,
      ...(spec.parentJobId !== undefined ? { parentJobId: spec.parentJobId } : {}),
      ...(spec.sessionId !== undefined ? { sessionId: spec.sessionId } : {}),
    };
    const entry: JobEntry = {
      record,
      idempotencyKey: spec.idempotencyKey,
      ...(spec.parentSessionId !== undefined ? { parentSessionId: spec.parentSessionId } : {}),
    };
    this.jobs.set(jobId, entry);
    this.byIdempotencyKey.set(spec.idempotencyKey, jobId);
    await this.persist(entry);

    await this.emit("job.submitted", {
      jobId,
      provider: request.provider,
      correlationId: record.correlationId,
      parentJobId: spec.parentJobId ?? null,
    });
    if (spec.delegationId !== undefined) {
      await this.emit("delegation.created", {
        delegationId: spec.delegationId,
        jobId,
        correlationId: record.correlationId,
        parentJobId: spec.parentJobId ?? null,
        parentSessionId: spec.parentSessionId ?? null,
      });
    }

    await this.dispatch(entry);
    return { job: cloneJobRecord(entry.record), deduplicated: false };
  }

  private async dispatch(entry: JobEntry): Promise<void> {
    const provider = entry.record.request.provider;
    const adapter = this.adapters.get(provider);
    if (adapter === undefined) {
      await this.settle(entry, {
        outcome: "failed",
        error: { code: "DISPATCH_REJECTED", message: `No adapter registered for provider ${provider}` },
        artifacts: [],
      });
      return;
    }

    const dispatchRequest = DispatchRequestSchema.parse({
      jobId: entry.record.id,
      correlationId: entry.record.correlationId,
      request: entry.record.request,
    });
    try {
      await adapter.dispatch(dispatchRequest);
    } catch (error) {
      await this.settle(entry, {
        outcome: "failed",
        error: {
          code: "DISPATCH_REJECTED",
          message: error instanceof Error ? error.message : "Dispatch failed",
        },
        artifacts: [],
      });
      return;
    }

    // A late report may have already settled the job while we awaited dispatch; do not clobber it.
    if (entry.record.lifecycle.status !== "queued") return;
    const now = this.now();
    entry.record = {
      ...entry.record,
      lifecycle: { status: "dispatched", dispatchedAt: now },
      updatedAt: now,
    };
    await this.persist(entry);
    await this.emit("job.dispatched", { jobId: entry.record.id, provider });
  }

  /** Idempotently ingest an adapter's terminal report. A duplicate for a settled job is a no-op. */
  async ingestReport(report: unknown): Promise<IngestResult> {
    const parsed = JobReportSchema.parse(report);
    const entry = this.jobs.get(parsed.jobId);
    if (entry === undefined) return { status: "unknown-job", jobId: parsed.jobId };
    if (entry.record.lifecycle.status === "settled") {
      return { status: "already-settled", jobId: parsed.jobId };
    }
    if (
      parsed.result.outcome === "failed" &&
      parsed.result.error.code === "RUNTIME_INTERRUPTED"
    ) {
      const now = this.now();
      entry.record = {
        ...entry.record,
        lifecycle: {
          status: "interrupted",
          interruptedAt: now,
          reason: parsed.result.error.message,
        },
        updatedAt: now,
      };
      if (parsed.usage !== undefined) entry.usage = parsed.usage;
      await this.persist(entry);
      await this.emit("job.interrupted", {
        jobId: entry.record.id,
        provider: entry.record.request.provider,
        correlationId: entry.record.correlationId,
        reason: parsed.result.error.message,
      });
      return { status: "interrupted", jobId: parsed.jobId };
    }
    await this.settle(entry, parsed.result, parsed.usage);
    return { status: "settled", jobId: parsed.jobId };
  }

  async cancel(jobId: unknown, reason?: string): Promise<CancellationResult> {
    const parsedId = JobIdSchema.parse(jobId);
    const entry = this.jobs.get(parsedId);
    if (entry === undefined) {
      throw new ControlPlaneError("JOB_NOT_FOUND", `Unknown job ${parsedId}`);
    }
    if (entry.record.lifecycle.status === "settled") {
      throw new ControlPlaneError("JOB_ALREADY_TERMINAL", `Job ${parsedId} is already terminal`);
    }

    const adapter = this.adapters.get(entry.record.request.provider);
    if (
      entry.record.lifecycle.status === "queued" ||
      entry.record.lifecycle.status === "interrupted" ||
      adapter === undefined
    ) {
      // Nothing was handed to a live adapter; settle directly without a port round-trip.
      await this.settle(entry, {
        outcome: "cancelled",
        ...(reason !== undefined ? { reason } : {}),
      });
      return CancellationResultSchema.parse({ accepted: true, jobId: parsedId });
    }

    const cancelRequest = CancellationRequestSchema.parse({
      jobId: parsedId,
      correlationId: entry.record.correlationId,
      ...(reason !== undefined ? { reason } : {}),
    });
    const result = CancellationResultSchema.parse(await adapter.cancel(cancelRequest));
    if (result.accepted) {
      await this.settle(entry, {
        outcome: "cancelled",
        ...(reason !== undefined ? { reason } : {}),
      });
    }
    return result;
  }

  async acknowledgeReport(jobId: unknown): Promise<ReportBackRecord> {
    const entry = this.requireReportBack(jobId);
    const rb = entry.reportBack;
    if (rb === undefined) throw new ControlPlaneError("JOB_NOT_FOUND", "No report-back to acknowledge");
    if (rb.state === "delivered") return { ...rb };
    const now = this.now();
    entry.reportBack = { ...rb, state: "delivered", deliveredAt: now, updatedAt: now };
    await this.persist(entry);
    await this.emit("job.report.acknowledged", {
      jobId: entry.record.id,
      parentJobId: rb.parentJobId ?? null,
    });
    return { ...entry.reportBack };
  }

  async failReport(jobId: unknown, error: string): Promise<ReportBackRecord> {
    const entry = this.requireReportBack(jobId);
    const rb = entry.reportBack;
    if (rb === undefined) throw new ControlPlaneError("JOB_NOT_FOUND", "No report-back to fail");
    const now = this.now();
    entry.reportBack = {
      ...rb,
      state: "failed",
      attempts: rb.attempts + 1,
      lastError: error,
      updatedAt: now,
    };
    await this.persist(entry);
    await this.emit("job.report.failed", {
      jobId: entry.record.id,
      parentJobId: rb.parentJobId ?? null,
      attempts: entry.reportBack.attempts,
    });
    return { ...entry.reportBack };
  }

  getJob(jobId: unknown): JobSnapshot {
    const entry = this.jobs.get(JobIdSchema.parse(jobId));
    if (entry === undefined) {
      throw new ControlPlaneError("JOB_NOT_FOUND", `Unknown job ${String(jobId)}`);
    }
    return this.snapshot(entry);
  }

  listJobs(): JobSnapshot[] {
    return [...this.jobs.values()].map((entry) => this.snapshot(entry));
  }

  private async settle(entry: JobEntry, result: JobResult, usage?: UsageReport): Promise<void> {
    const now = this.now();
    entry.record = {
      ...entry.record,
      lifecycle: { status: "settled", finishedAt: now, result },
      updatedAt: now,
    };
    if (usage !== undefined) entry.usage = usage;

    const hasParent = entry.record.parentJobId !== undefined || entry.parentSessionId !== undefined;
    if (hasParent) {
      entry.reportBack = {
        schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
        jobId: entry.record.id,
        correlationId: entry.record.correlationId,
        result,
        state: "pending",
        attempts: 0,
        createdAt: now,
        updatedAt: now,
        ...(entry.record.parentJobId !== undefined ? { parentJobId: entry.record.parentJobId } : {}),
        ...(entry.parentSessionId !== undefined ? { parentSessionId: entry.parentSessionId } : {}),
        ...(usage !== undefined ? { usage } : {}),
      };
    }

    await this.persist(entry);
    await this.emit("job.settled", {
      jobId: entry.record.id,
      provider: entry.record.request.provider,
      outcome: result.outcome,
      errorCode: result.outcome === "failed" ? result.error.code : null,
    });
    if (hasParent) {
      await this.emit("job.reported", {
        jobId: entry.record.id,
        state: "pending",
        parentJobId: entry.record.parentJobId ?? null,
      });
    }
  }

  private requireReportBack(jobId: unknown): JobEntry {
    const entry = this.jobs.get(JobIdSchema.parse(jobId));
    if (entry === undefined || entry.reportBack === undefined) {
      throw new ControlPlaneError("JOB_NOT_FOUND", `No report-back for job ${String(jobId)}`);
    }
    return entry;
  }

  private snapshot(entry: JobEntry): JobSnapshot {
    return {
      record: cloneJobRecord(entry.record),
      ...(entry.usage !== undefined ? { usage: entry.usage } : {}),
      ...(entry.reportBack !== undefined ? { reportBack: { ...entry.reportBack } } : {}),
    };
  }

  private registeredIds(): string[] {
    return this.options.registry.list().map((descriptor) => descriptor.id);
  }

  private async persist(entry: JobEntry): Promise<void> {
    if (this.options.store === undefined) return;
    await this.options.store.append({
      record: cloneJobRecord(entry.record),
      idempotencyKey: entry.idempotencyKey,
      ...(entry.parentSessionId !== undefined ? { parentSessionId: entry.parentSessionId } : {}),
      ...(entry.usage !== undefined ? { usage: entry.usage } : {}),
      ...(entry.reportBack !== undefined ? { reportBack: { ...entry.reportBack } } : {}),
    });
  }

  private async emit(type: BrokerEventType, data: Record<string, unknown>): Promise<void> {
    if (this.options.journal === undefined) return;
    await this.options.journal.append({
      id: this.newId(),
      type,
      occurredAt: this.now(),
      data,
    });
  }

  private now(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }

  private newId(): string {
    return this.options.idFactory?.() ?? randomUUID();
  }

  private newCorrelationId(): CorrelationId {
    return CorrelationIdSchema.parse(this.newId());
  }
}

function cloneJobRecord(record: JobRecord): JobRecord {
  return { ...record };
}
