import {
  LOCAL_WORKER_CONTROL_SCHEMA_VERSION,
  LocalWorkerCommandResultSchema,
  LocalWorkerCommandSchema,
  LocalWorkerTelemetrySnapshotSchema,
  type LocalWorkerBudget,
  type LocalWorkerCommandResult,
  type LocalWorkerTelemetry,
  type LocalWorkerTelemetrySnapshot,
} from "../domain/local-worker-control.js";
import type { SessionRecord } from "../domain/session.js";
import {
  workerBudgetReading,
  type WorkerBudgetMutationResult,
  type WorkerBudgetRecord,
} from "../domain/worker-budget.js";
import type { WorkerTruth } from "../domain/worker-truth.js";

export interface LocalWorkerRegistryPort {
  list(): SessionRecord[];
  workerTruth(sessionId: string): WorkerTruth;
  stop(sessionId: string): Promise<void>;
  onSessionUpdate(listener: (sessionId: string) => void): () => void;
}

export interface LocalWorkerBudgetAdjustment {
  subjectId: string;
  direction: "extend" | "reduce";
  amount: number;
  expectedRevision: number;
  mutationId: string;
  reason: string;
}

/** Narrow adapter seam over broker-owned worker-budget state. */
export interface LocalWorkerBudgetPort {
  getBudget(workerId: string): WorkerBudgetRecord | undefined;
  adjustBudget(input: LocalWorkerBudgetAdjustment): Promise<WorkerBudgetMutationResult>;
  onBudgetUpdate(listener: (workerId: string, budget: WorkerBudgetRecord) => void): () => void;
}

export class LocalWorkerControlError extends Error {
  constructor(
    readonly code:
      | "WORKER_NOT_FOUND"
      | "NOT_A_WORKER"
      | "WORKER_TERMINAL"
      | "WORKER_NOT_BUDGETED"
      | "BUDGET_RESULT_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "LocalWorkerControlError";
  }
}

export interface LocalWorkerControlServiceOptions {
  registry: LocalWorkerRegistryPort;
  budgets: LocalWorkerBudgetPort;
  now?: () => string;
}

/**
 * Versioned local projection and broker-mediated command boundary for native clients.
 *
 * This service owns no process and persists nothing itself. Session lifecycle stays in the registry,
 * budget mutation stays in the budget coordinator, and subscribers receive snapshots only. Closing
 * or never opening a subscriber therefore cannot change worker execution or budget enforcement.
 */
export class LocalWorkerControlService {
  private readonly listeners = new Set<(snapshot: LocalWorkerTelemetrySnapshot) => void>();
  private readonly unsubscribes: Array<() => void> = [];
  private readonly now: () => string;
  private cursor = 0;
  private closed = false;

  constructor(private readonly options: LocalWorkerControlServiceOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.unsubscribes.push(options.registry.onSessionUpdate(() => this.publish()));
    this.unsubscribes.push(options.budgets.onBudgetUpdate(() => this.publish()));
  }

  snapshot(): LocalWorkerTelemetrySnapshot {
    const generatedAt = this.now();
    const sessions = this.options.registry.list();
    const byId = new Map(sessions.map((record) => [record.id, record]));
    return LocalWorkerTelemetrySnapshotSchema.parse({
      schemaVersion: LOCAL_WORKER_CONTROL_SCHEMA_VERSION,
      cursor: this.cursor,
      generatedAt,
      workers: sessions
        .filter((record) => (record.kind ?? "worker") === "worker")
        .map((record) => this.projectWorker(record, byId, generatedAt)),
    });
  }

  onUpdate(listener: (snapshot: LocalWorkerTelemetrySnapshot) => void): () => void {
    if (this.closed) return () => undefined;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
    this.listeners.clear();
  }

  async command(input: unknown): Promise<LocalWorkerCommandResult> {
    const command = LocalWorkerCommandSchema.parse(input);
    const worker = this.requireWorker(command.workerId);
    const truth = this.options.registry.workerTruth(worker.id);

    if (command.action === "stop") {
      if (truth.terminal) {
        return LocalWorkerCommandResultSchema.parse({
          schemaVersion: LOCAL_WORKER_CONTROL_SCHEMA_VERSION,
          action: "stop",
          workerId: worker.id,
          mutationId: command.mutationId,
          status: "already-terminal",
          revision: null,
        });
      }
      await this.options.registry.stop(worker.id);
      this.publish();
      return LocalWorkerCommandResultSchema.parse({
        schemaVersion: LOCAL_WORKER_CONTROL_SCHEMA_VERSION,
        action: "stop",
        workerId: worker.id,
        mutationId: command.mutationId,
        status: "accepted",
        revision: null,
      });
    }

    if (truth.terminal && command.action === "reduce-budget") {
      throw new LocalWorkerControlError(
        "WORKER_TERMINAL",
        `Worker ${worker.id} is terminal; its budget cannot be reduced`,
      );
    }
    if (this.options.budgets.getBudget(worker.id) === undefined) {
      throw new LocalWorkerControlError(
        "WORKER_NOT_BUDGETED",
        `Worker ${worker.id} has no scoped budget`,
      );
    }
    const result = await this.options.budgets.adjustBudget({
      subjectId: worker.id,
      direction: command.action === "extend-budget" ? "extend" : "reduce",
      amount: command.amount,
      expectedRevision: command.expectedRevision,
      mutationId: command.mutationId,
      reason: command.reason,
    });
    if (result.subjectId !== worker.id || result.mutationId !== command.mutationId) {
      throw new LocalWorkerControlError(
        "BUDGET_RESULT_MISMATCH",
        "Budget coordinator returned a result for a different worker or mutation",
      );
    }
    this.publish();
    return LocalWorkerCommandResultSchema.parse({
      schemaVersion: LOCAL_WORKER_CONTROL_SCHEMA_VERSION,
      action: command.action,
      workerId: worker.id,
      mutationId: command.mutationId,
      status: result.idempotentReplay ? "idempotent" : "updated",
      revision: result.revision,
    });
  }

  private projectWorker(
    record: SessionRecord,
    byId: ReadonlyMap<string, SessionRecord>,
    generatedAt: string,
  ): LocalWorkerTelemetry {
    const truth = this.options.registry.workerTruth(record.id);
    const budgetRecord = this.options.budgets.getBudget(record.id);
    const budget = budgetRecord === undefined ? null : projectBudget(budgetRecord, generatedAt);
    const terminal = truth.terminal;
    return {
      schemaVersion: LOCAL_WORKER_CONTROL_SCHEMA_VERSION,
      sessionId: record.id,
      parent: parentOf(record, byId),
      provider: record.provider,
      role: nullableText(record.role, 256),
      model: modelOf(record),
      taskSummary: taskSummaryOf(record),
      lifecycle: {
        state: truth.state,
        terminal,
        executionState: record.executionState,
        detail: truncate(truth.detail, 1_024),
        startedAt: record.createdAt,
        endedAt: terminal ? record.updatedAt : null,
        elapsedMs: elapsedMs(record.createdAt, terminal ? record.updatedAt : generatedAt),
      },
      budget,
      commands: {
        inspect: true,
        stop: !terminal,
        // Extension remains useful after a hard-cap stop: it clears exhausted policy state so an
        // explicit resume through an existing Cyberdeck surface can proceed. This command itself
        // never resumes or launches a process.
        extendBudget: budget !== null,
        reduceBudget: !terminal && budget !== null,
        pause: false,
        resume: false,
        open: false,
      },
    };
  }

  private requireWorker(workerId: string): SessionRecord {
    const record = this.options.registry.list().find((candidate) => candidate.id === workerId);
    if (record === undefined) {
      throw new LocalWorkerControlError("WORKER_NOT_FOUND", `Worker ${workerId} is unknown`);
    }
    if ((record.kind ?? "worker") !== "worker") {
      throw new LocalWorkerControlError("NOT_A_WORKER", `Session ${workerId} is an orchestrator`);
    }
    return record;
  }

  private publish(): void {
    if (this.closed) return;
    this.cursor += 1;
    if (this.listeners.size === 0) return;
    let snapshot: LocalWorkerTelemetrySnapshot;
    try {
      snapshot = this.snapshot();
    } catch {
      // Observation callbacks run on the registry's output path. Telemetry failure must never stop
      // provider output, lifecycle reconciliation, or independent budget enforcement.
      return;
    }
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // One disconnected or faulty client observer cannot suppress another observer.
      }
    }
  }
}

function parentOf(
  record: SessionRecord,
  byId: ReadonlyMap<string, SessionRecord>,
): LocalWorkerTelemetry["parent"] {
  if (record.parentSessionId === undefined) return null;
  const parent = byId.get(record.parentSessionId);
  return {
    sessionId: record.parentSessionId,
    kind: parent === undefined ? "unknown" : (parent.kind ?? "worker"),
  };
}

function modelOf(record: SessionRecord): LocalWorkerTelemetry["model"] {
  if (record.observedModel !== undefined) {
    return {
      value: record.observedModel.model,
      effort: record.observedModel.effort ?? null,
      provenance: "observed",
      observedAt: record.observedModel.observedAt ?? null,
    };
  }
  const launchModel = nullableText(record.model, 256);
  if (launchModel !== null) {
    return {
      value: launchModel,
      effort: record.effort ?? null,
      provenance: "launch",
      observedAt: null,
    };
  }
  return { value: null, effort: null, provenance: "unknown", observedAt: null };
}

function taskSummaryOf(record: SessionRecord): string {
  const candidate = record.name?.trim() || record.role?.trim() || "Untitled worker";
  return truncate(candidate, 240);
}

function projectBudget(record: WorkerBudgetRecord, generatedAt: string): LocalWorkerBudget {
  const reading = workerBudgetReading(record);
  const measurement = record.measurement;
  const providerRemaining = record.providerRemaining;
  const enforcement = record.enforcement;
  const softTriggeredAt = enforcement.state === "soft-pending" || enforcement.state === "soft-notified"
    ? enforcement.reachedAt
    : null;
  const hardTriggeredAt = enforcement.state === "hard-reached" || enforcement.state === "hard-stop-requested"
    ? enforcement.reachedAt
    : null;
  return {
    revision: record.revision,
    resource: record.declaration.resource,
    unit: record.declaration.allocation.unit,
    allocatedAmount: record.declaration.allocation.amount,
    consumedAmount: reading.status === "known" ? reading.consumedAmount : null,
    remainingAmount: reading.status === "known" ? reading.remainingAmount : null,
    measurement: measurement.status === "known"
      ? {
          source: measurement.source,
          accuracy: measurement.quality,
          observedAt: measurement.observedAt,
          freshness: measurementFreshness(
            measurement.observedAt,
            measurement.staleAfterMs,
            generatedAt,
          ),
          reason: reading.status === "known" ? null : reading.reason,
        }
      : {
          source: "unavailable",
          accuracy: "unknown",
          observedAt: measurement.observedAt ?? null,
          freshness: "unknown",
          reason: reading.status === "unknown" ? reading.reason : measurement.reason,
        },
    providerRemaining: providerRemaining.status === "available"
      ? {
          amount: providerRemaining.amount,
          unit: providerRemaining.unit,
          observedAt: providerRemaining.observedAt,
          freshness: measurementFreshness(
            providerRemaining.observedAt,
            providerRemaining.staleAfterMs,
            generatedAt,
          ),
          accuracy: providerRemaining.quality,
          reason: null,
        }
      : {
          amount: null,
          unit: null,
          observedAt: null,
          freshness: "unknown",
          accuracy: "unknown",
          reason: providerRemaining.reason ?? "Provider-wide remaining usage is unavailable",
        },
    policy: {
      softLimit: {
        thresholdAmount:
          record.declaration.allocation.amount * record.declaration.policy.softLimitRatio,
        action: "wrap-up",
        triggeredAt: softTriggeredAt,
      },
      hardLimit: {
        thresholdAmount:
          record.declaration.allocation.amount * record.declaration.policy.hardLimitRatio,
        action: "stop",
        triggeredAt: hardTriggeredAt,
      },
    },
    enforcement: {
      state: enforcement.state,
      revision: enforcement.state === "active" ? null : enforcement.revision,
      reachedAt: enforcement.state === "active" ? null : enforcement.reachedAt,
      actionAt: enforcement.state === "soft-notified"
        ? enforcement.notifiedAt
        : enforcement.state === "hard-stop-requested"
          ? enforcement.stopRequestedAt
          : null,
    },
  };
}

function measurementFreshness(
  observedAt: string,
  staleAfterMs: number,
  generatedAt: string,
): "fresh" | "stale" {
  return Date.parse(generatedAt) - Date.parse(observedAt) >= staleAfterMs ? "stale" : "fresh";
}

function elapsedMs(startedAt: string, endedAt: string): number {
  return Math.max(0, Date.parse(endedAt) - Date.parse(startedAt));
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function nullableText(value: string | undefined, max: number): string | null {
  const normalized = value?.trim();
  return normalized === undefined || normalized === "" ? null : truncate(normalized, max);
}
