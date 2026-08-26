import { describe, expect, it, vi } from "vitest";
import type { SessionRecord } from "../../src/domain/session.js";
import {
  createWorkerBudgetRecord,
  WorkerBudgetRecordSchema,
  type WorkerBudgetMutationResult,
  type WorkerBudgetRecord,
} from "../../src/domain/worker-budget.js";
import type { WorkerTruth } from "../../src/domain/worker-truth.js";
import {
  LocalWorkerControlError,
  LocalWorkerControlService,
  type LocalWorkerBudgetAdjustment,
  type LocalWorkerBudgetPort,
  type LocalWorkerRegistryPort,
} from "../../src/orchestration/local-worker-control-service.js";

const WORKER_ID = "11111111-1111-4111-8111-111111111111";
const ORCHESTRATOR_ID = "22222222-2222-4222-8222-222222222222";
const UNBUDGETED_ID = "33333333-3333-4333-8333-333333333333";
const NOW = "2026-08-24T10:02:00.000Z";

function session(
  id: string,
  input: Partial<SessionRecord> = {},
): SessionRecord {
  return {
    provider: "codex",
    cwd: "/repo",
    detached: true,
    sandbox: "read-only",
    id,
    kind: "worker",
    createdAt: "2026-08-24T10:00:00.000Z",
    updatedAt: "2026-08-24T10:01:30.000Z",
    executionState: "active",
    attachmentState: "detached",
    pid: 1234,
    exitCode: null,
    childIds: [],
    ...input,
  };
}

function truth(input: Partial<WorkerTruth> = {}): WorkerTruth {
  return {
    state: "working",
    terminal: false,
    completedTurns: 0,
    canonicalTurns: 0,
    pendingInstructions: 0,
    composerOccupied: false,
    modalOpen: false,
    detail: "Provider turn in flight",
    ...input,
  };
}

class FakeRegistry implements LocalWorkerRegistryPort {
  readonly stop = vi.fn(async (sessionId: string) => {
    const record = this.records.find((candidate) => candidate.id === sessionId);
    if (record !== undefined) {
      record.executionState = "cancelled";
      record.updatedAt = NOW;
      this.truths.set(sessionId, truth({ state: "stopped", terminal: true, detail: "Stopped on request" }));
    }
    this.emit(sessionId);
  });
  private readonly listeners = new Set<(sessionId: string) => void>();

  constructor(
    readonly records: SessionRecord[],
    readonly truths: Map<string, WorkerTruth>,
  ) {}

  list(): SessionRecord[] { return this.records; }
  workerTruth(sessionId: string): WorkerTruth {
    const value = this.truths.get(sessionId);
    if (value === undefined) throw new Error(`No truth for ${sessionId}`);
    return value;
  }
  onSessionUpdate(listener: (sessionId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(sessionId: string): void {
    for (const listener of this.listeners) listener(sessionId);
  }
}

class FakeBudgets implements LocalWorkerBudgetPort {
  readonly adjustments: LocalWorkerBudgetAdjustment[] = [];
  private readonly listeners = new Set<(workerId: string, budget: WorkerBudgetRecord) => void>();
  nextReplay = false;

  constructor(readonly records = new Map<string, WorkerBudgetRecord>()) {}

  getBudget(workerId: string): WorkerBudgetRecord | undefined { return this.records.get(workerId); }
  onBudgetUpdate(listener: (workerId: string, budget: WorkerBudgetRecord) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async adjustBudget(input: LocalWorkerBudgetAdjustment): Promise<WorkerBudgetMutationResult> {
    this.adjustments.push(input);
    const current = this.records.get(input.subjectId);
    if (current === undefined) throw new Error("missing budget");
    const amount = input.direction === "extend"
      ? current.declaration.allocation.amount + input.amount
      : current.declaration.allocation.amount - input.amount;
    const budget = WorkerBudgetRecordSchema.parse({
      ...current,
      revision: current.revision + 1,
      declaration: {
        ...current.declaration,
        allocation: { ...current.declaration.allocation, amount },
      },
      updatedAt: NOW,
    });
    this.records.set(input.subjectId, budget);
    this.emit(input.subjectId);
    return {
      mutationId: input.mutationId,
      operation: "budget-adjust",
      subjectId: input.subjectId,
      revision: budget.revision,
      changed: !this.nextReplay,
      idempotentReplay: this.nextReplay,
      budget,
    };
  }
  emit(workerId: string): void {
    const budget = this.records.get(workerId);
    if (budget === undefined) return;
    for (const listener of this.listeners) listener(workerId, budget);
  }
}

function knownBudget(): WorkerBudgetRecord {
  const created = createWorkerBudgetRecord({
    schemaVersion: 1,
    resource: "weekly",
    allocation: { unit: "percent", amount: 20 },
    policy: { softLimitRatio: 0.8, hardLimitRatio: 1, softAction: "wrap-up", hardAction: "stop" },
  }, "2026-08-24T10:00:00.000Z");
  return WorkerBudgetRecordSchema.parse({
    ...created,
    revision: 2,
    measurement: {
      status: "known",
      unit: "percent",
      amount: 5,
      source: "provider-telemetry",
      quality: "approximate",
      observedAt: "2026-08-24T10:01:00.000Z",
      staleAfterMs: 60_000,
    },
    providerRemaining: {
      status: "available",
      unit: "percent",
      amount: 42,
      quality: "approximate",
      observedAt: "2026-08-24T10:01:00.000Z",
      staleAfterMs: 60_000,
    },
    enforcement: {
      state: "soft-notified",
      revision: 2,
      reachedAt: "2026-08-24T10:01:00.000Z",
      notifiedAt: "2026-08-24T10:01:01.000Z",
    },
    updatedAt: "2026-08-24T10:01:01.000Z",
  });
}

function harness() {
  const records = [
    session(ORCHESTRATOR_ID, { kind: "orchestrator", name: "Fleet Orc" }),
    session(WORKER_ID, {
      parentSessionId: ORCHESTRATOR_ID,
      role: "worker",
      name: "Inspect local telemetry",
      model: "gpt-5.6-terra",
      effort: "medium",
      observedModel: {
        model: "gpt-5.6-sol",
        effort: "high",
        observedAt: "2026-08-24T10:01:00.000Z",
      },
    }),
    session(UNBUDGETED_ID, { role: "fallback summary" }),
  ];
  const registry = new FakeRegistry(records, new Map([
    [ORCHESTRATOR_ID, truth({ state: "idle", detail: "Idle" })],
    [WORKER_ID, truth()],
    [UNBUDGETED_ID, truth({ state: "idle", detail: "Idle after 0 completed turn(s)" })],
  ]));
  const budgets = new FakeBudgets(new Map([[WORKER_ID, knownBudget()]]));
  const service = new LocalWorkerControlService({ registry, budgets, now: () => NOW });
  return { service, registry, budgets };
}

describe("LocalWorkerControlService", () => {
  it("projects hierarchy, canonical truth, elapsed time, model provenance, and budget freshness", () => {
    const { service } = harness();
    const snapshot = service.snapshot();
    expect(snapshot.workers).toHaveLength(2);
    expect(snapshot.workers[0]).toMatchObject({
      sessionId: WORKER_ID,
      parent: { sessionId: ORCHESTRATOR_ID, kind: "orchestrator" },
      provider: "codex",
      role: "worker",
      model: {
        value: "gpt-5.6-sol",
        effort: "high",
        provenance: "observed",
      },
      taskSummary: "Inspect local telemetry",
      lifecycle: {
        state: "working",
        terminal: false,
        elapsedMs: 120_000,
      },
      budget: {
        revision: 2,
        allocatedAmount: 20,
        consumedAmount: 5,
        remainingAmount: 15,
        measurement: {
          source: "provider-telemetry",
          accuracy: "approximate",
          freshness: "stale",
        },
        providerRemaining: {
          amount: 42,
          unit: "percent",
          freshness: "stale",
          accuracy: "approximate",
        },
        policy: {
          softLimit: {
            thresholdAmount: 16,
            action: "wrap-up",
            triggeredAt: "2026-08-24T10:01:00.000Z",
          },
          hardLimit: { thresholdAmount: 20, action: "stop", triggeredAt: null },
        },
        enforcement: {
          state: "soft-notified",
          revision: 2,
          reachedAt: "2026-08-24T10:01:00.000Z",
          actionAt: "2026-08-24T10:01:01.000Z",
        },
      },
      commands: {
        inspect: true,
        stop: true,
        extendBudget: true,
        reduceBudget: true,
        pause: false,
        resume: false,
        open: false,
      },
    });
    expect(snapshot.workers[0]).not.toHaveProperty("pid");
    expect(snapshot.workers[0]).not.toHaveProperty("controller");
  });

  it("keeps unbudgeted and native-default facts explicit", () => {
    const { service } = harness();
    expect(service.snapshot().workers[1]).toMatchObject({
      sessionId: UNBUDGETED_ID,
      parent: null,
      model: { value: null, effort: null, provenance: "unknown", observedAt: null },
      taskSummary: "fallback summary",
      budget: null,
      commands: { extendBudget: false, reduceBudget: false },
    });
  });

  it("routes stop and revision-guarded adjustments through owner ports", async () => {
    const { service, registry, budgets } = harness();
    await expect(service.command({
      schemaVersion: 1,
      action: "extend-budget",
      workerId: WORKER_ID,
      reason: "finish verification",
      mutationId: "local:extend:1",
      expectedRevision: 2,
      amount: 5,
    })).resolves.toMatchObject({ status: "updated", revision: 3 });
    expect(budgets.adjustments[0]).toEqual({
      subjectId: WORKER_ID,
      direction: "extend",
      amount: 5,
      expectedRevision: 2,
      mutationId: "local:extend:1",
      reason: "finish verification",
    });

    budgets.nextReplay = true;
    await expect(service.command({
      schemaVersion: 1,
      action: "reduce-budget",
      workerId: WORKER_ID,
      reason: "retry same reduction",
      mutationId: "local:reduce:1",
      expectedRevision: 3,
      amount: 1,
    })).resolves.toMatchObject({ status: "idempotent", revision: 4 });

    await expect(service.command({
      schemaVersion: 1,
      action: "stop",
      workerId: WORKER_ID,
      reason: "operator stop",
      mutationId: "local:stop:1",
    })).resolves.toMatchObject({ status: "accepted", revision: null });
    expect(registry.stop).toHaveBeenCalledWith(WORKER_ID);
  });

  it("publishes monotonic full snapshots and detaches observers without touching workers", () => {
    const { service, registry, budgets } = harness();
    const snapshots: number[] = [];
    service.onUpdate((snapshot) => snapshots.push(snapshot.cursor));
    registry.emit(WORKER_ID);
    budgets.emit(WORKER_ID);
    expect(snapshots).toEqual([1, 2]);

    service.close();
    registry.emit(WORKER_ID);
    budgets.emit(WORKER_ID);
    expect(snapshots).toEqual([1, 2]);
    expect(registry.stop).not.toHaveBeenCalled();
  });

  it("keeps terminal stop idempotent, permits extension, and refuses reduction", async () => {
    const { service, registry, budgets } = harness();
    registry.truths.set(WORKER_ID, truth({ state: "stopped", terminal: true, detail: "Stopped on request" }));
    registry.records.find((record) => record.id === WORKER_ID)!.executionState = "cancelled";

    expect(service.snapshot().workers.find(({ sessionId }) => sessionId === WORKER_ID)?.commands)
      .toMatchObject({ stop: false, extendBudget: true, reduceBudget: false });

    await expect(service.command({
      schemaVersion: 1,
      action: "stop",
      workerId: WORKER_ID,
      reason: "retry stop",
      mutationId: "local:stop:retry",
    })).resolves.toMatchObject({ status: "already-terminal" });
    expect(registry.stop).not.toHaveBeenCalled();

    await expect(service.command({
      schemaVersion: 1,
      action: "extend-budget",
      workerId: WORKER_ID,
      reason: "allow explicit resume elsewhere",
      mutationId: "local:extend:late",
      expectedRevision: 2,
      amount: 1,
    })).resolves.toMatchObject({ status: "updated", revision: 3 });
    expect(budgets.adjustments).toContainEqual(expect.objectContaining({
      subjectId: WORKER_ID,
      direction: "extend",
    }));

    await expect(service.command({
      schemaVersion: 1,
      action: "reduce-budget",
      workerId: WORKER_ID,
      reason: "cannot tighten terminal worker",
      mutationId: "local:reduce:late",
      expectedRevision: 3,
      amount: 1,
    })).rejects.toMatchObject({ code: "WORKER_TERMINAL" });
  });

  it("rejects unknown, orchestrator, and unbudgeted command targets", async () => {
    const { service } = harness();
    const stop = (workerId: string) => service.command({
      schemaVersion: 1,
      action: "stop",
      workerId,
      reason: "invalid target",
      mutationId: `local:stop:${workerId}`,
    });
    await expect(stop("44444444-4444-4444-8444-444444444444"))
      .rejects.toEqual(expect.objectContaining<Partial<LocalWorkerControlError>>({ code: "WORKER_NOT_FOUND" }));
    await expect(stop(ORCHESTRATOR_ID))
      .rejects.toEqual(expect.objectContaining<Partial<LocalWorkerControlError>>({ code: "NOT_A_WORKER" }));
    await expect(service.command({
      schemaVersion: 1,
      action: "reduce-budget",
      workerId: UNBUDGETED_ID,
      reason: "no budget",
      mutationId: "local:reduce:none",
      expectedRevision: 1,
      amount: 1,
    })).rejects.toMatchObject({ code: "WORKER_NOT_BUDGETED" });
  });
});
