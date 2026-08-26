import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkerCoordinationService } from "../../src/broker/worker-coordination.js";
import type { WorkerBudgetObservation } from "../../src/broker/session-registry.js";
import { SessionRecordSchema, type SessionRecord } from "../../src/domain/session.js";
import type { WorkerTruth } from "../../src/domain/worker-truth.js";
import {
  WorkerBudgetDeclarationSchema,
  type WorkerBudgetDeclaration,
} from "../../src/domain/worker-budget.js";
import { WorkerBudgetEnforcer } from "../../src/broker/worker-budget-enforcer.js";
import { WorkerCoordinationStore } from "../../src/persistence/worker-coordination-store.js";
import type { ParsedProviderBudgetTelemetry } from "../../src/runtime/provider-budget-telemetry.js";

const BASE_MS = Date.parse("2026-08-24T10:00:00.000Z");
const WORKER_ID = "00000000-0000-4000-8000-000000000161";
const PARENT_ID = "00000000-0000-4000-8000-000000000162";
const controller = {
  controllerId: "orchestrator:fleet:mik-161",
  familyId: "orchestrator:fleet:mik-161",
  scope: { kind: "fleet" as const, scopeId: "fleet:mik-161" },
};
const directories: string[] = [];
type BrokerInstructionInput = {
  actorSessionId: string;
  targetSessionId: string;
  message: string;
  messageId?: string;
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function record(): SessionRecord {
  const timestamp = new Date(BASE_MS).toISOString();
  return SessionRecordSchema.parse({
    id: WORKER_ID,
    provider: "codex",
    cwd: "/tmp/cyberdeck-mik-161",
    detached: true,
    sandbox: "workspace-write",
    name: "budgeted-worker",
    parentSessionId: PARENT_ID,
    kind: "worker",
    generation: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    executionState: "active",
    attachmentState: "detached",
    pid: 16_161,
    exitCode: null,
    childIds: [],
  });
}

function declaration(
  unit: "percent" | "tokens" | "wall-clock-ms" = "wall-clock-ms",
  amount = 1_000,
): WorkerBudgetDeclaration {
  return WorkerBudgetDeclarationSchema.parse({
    resource: unit === "percent" ? "weekly" : "session",
    allocation: { unit, amount },
  });
}

function workingTruth(): WorkerTruth {
  return {
    state: "working",
    terminal: false,
    completedTurns: 0,
    canonicalTurns: 0,
    pendingInstructions: 0,
    composerOccupied: false,
    modalOpen: false,
    detail: "Provider turn in flight",
  };
}

class FakeRegistry {
  readonly stop = vi.fn(async (_sessionId: string) => undefined);
  private readonly listeners = new Set<(sessionId: string) => void>();
  truth = workingTruth();
  observation: WorkerBudgetObservation = { generation: 1, canonicalTurns: 0 };

  constructor(readonly worker = record()) {}

  get(sessionId: string): SessionRecord {
    if (sessionId !== this.worker.id) throw new Error(`Unknown session ${sessionId}`);
    return this.worker;
  }

  list(): SessionRecord[] {
    return [this.worker];
  }

  onSessionUpdate(listener: (sessionId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  workerTruth(sessionId: string): WorkerTruth {
    this.get(sessionId);
    return this.truth;
  }

  workerBudgetObservation(sessionId: string): WorkerBudgetObservation {
    this.get(sessionId);
    return this.observation;
  }
}

async function harness() {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cyberdeck-budget-enforcer-"));
  directories.push(stateDirectory);
  let nowMs = BASE_MS;
  const store = new WorkerCoordinationStore(stateDirectory);
  const coordination = new WorkerCoordinationService({
    store,
    now: () => new Date(nowMs).toISOString(),
  });
  await coordination.initialize();
  const registry = new FakeRegistry();
  return {
    stateDirectory,
    store,
    coordination,
    registry,
    now: () => nowMs,
    advance(milliseconds: number) { nowMs += milliseconds; },
    async restartCoordination() {
      const restarted = new WorkerCoordinationService({
        store: new WorkerCoordinationStore(stateDirectory),
        now: () => new Date(nowMs).toISOString(),
      });
      await restarted.initialize();
      return restarted;
    },
  };
}

function enforcer(input: {
  registry: FakeRegistry;
  coordination: WorkerCoordinationService;
  now: () => number;
  enqueueBroker?: (input: BrokerInstructionInput) => Promise<unknown>;
  telemetry?: () => Promise<ParsedProviderBudgetTelemetry>;
  credentialSet?: (controllerId: string, workerId: string, credential: {
    leaseToken: string;
    leaseVersion: number;
  }) => void;
}) {
  return new WorkerBudgetEnforcer({
    registry: input.registry,
    coordination: input.coordination,
    instructions: {
      enqueueBroker: (input.enqueueBroker ?? vi.fn(async () => undefined)) as never,
    },
    ...(input.telemetry === undefined
      ? {}
      : {
          transcripts: {
            readProviderBudgetTelemetry: input.telemetry as never,
          },
        }),
    ...(input.credentialSet === undefined
      ? {}
      : { credentials: { set: input.credentialSet } }),
    now: input.now,
    intervalMs: 5_000,
  });
}

async function registerBudget(
  subject: WorkerBudgetEnforcer,
  worker: SessionRecord,
  budget = declaration(),
) {
  await subject.register({
    record: worker,
    name: worker.name ?? worker.id,
    declaration: budget,
    controller,
  });
}

describe("WorkerBudgetEnforcer", () => {
  it("registers budget durably and captures issued lease credential", async () => {
    const context = await harness();
    const credentialSet = vi.fn();
    const subject = enforcer({ ...context, credentialSet });

    await registerBudget(subject, context.registry.worker);

    expect(context.coordination.getBudget(WORKER_ID)).toMatchObject({
      revision: 1,
      declaration: {
        resource: "session",
        allocation: { unit: "wall-clock-ms", amount: 1_000 },
      },
    });
    expect(credentialSet).toHaveBeenCalledWith(
      controller.controllerId,
      WORKER_ID,
      { leaseToken: expect.any(String), leaseVersion: 1 },
    );
    const transactions = (await readFile(context.store.path, "utf8")).trim().split("\n");
    expect(transactions).toHaveLength(1);
    expect(JSON.parse(transactions[0]!)).toMatchObject({
      subjects: [{ subjectId: WORKER_ID, budget: { revision: 1 } }],
      receipts: [{ mutationId: `worker-budget:register:${WORKER_ID}` }],
    });
    const restarted = await context.restartCoordination();
    expect(restarted.getBudget(WORKER_ID)).toEqual(context.coordination.getBudget(WORKER_ID));
  });

  it("persists soft threshold before enqueueing broker wrap-up nudge", async () => {
    const context = await harness();
    const statesAtEnqueue: string[] = [];
    const enqueueBroker = vi.fn(async (_input: BrokerInstructionInput) => {
      statesAtEnqueue.push(context.coordination.getBudget(WORKER_ID)?.enforcement.state ?? "missing");
    });
    const subject = enforcer({ ...context, enqueueBroker });
    await registerBudget(subject, context.registry.worker);
    context.advance(800);

    await subject.refresh(WORKER_ID);

    expect(enqueueBroker).toHaveBeenCalledTimes(1);
    expect(statesAtEnqueue).toEqual(["soft-pending"]);
    expect(enqueueBroker).toHaveBeenCalledWith({
      actorSessionId: PARENT_ID,
      targetSessionId: WORKER_ID,
      message: expect.stringContaining("Wrap up current work now"),
      messageId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
    });
    expect(context.coordination.getBudget(WORKER_ID)).toMatchObject({
      measurement: { status: "known", amount: 800, source: "wall-clock" },
      enforcement: { state: "soft-notified", revision: 1 },
    });

    await subject.refresh(WORKER_ID);
    expect(enqueueBroker).toHaveBeenCalledTimes(1);
  });

  it("blocks consumption at hard threshold before existing registry stop executes", async () => {
    const context = await harness();
    let subject: WorkerBudgetEnforcer;
    context.registry.stop.mockImplementation(async () => {
      expect(context.coordination.getBudget(WORKER_ID)?.enforcement.state).toBe("hard-reached");
      expect(() => subject.assertMayConsume(WORKER_ID)).toThrow(expect.objectContaining({
        code: "WORKER_BUDGET_EXHAUSTED",
      }));
    });
    subject = enforcer(context);
    await registerBudget(subject, context.registry.worker);
    context.advance(1_000);

    await subject.refresh(WORKER_ID);

    expect(context.registry.stop).toHaveBeenCalledWith(WORKER_ID);
    expect(context.coordination.getBudget(WORKER_ID)).toMatchObject({
      measurement: { status: "known", amount: 1_000 },
      enforcement: { state: "hard-stop-requested", revision: 1 },
    });
    expect(() => subject.assertMayConsume(WORKER_ID)).toThrow(expect.objectContaining({
      code: "WORKER_BUDGET_EXHAUSTED",
    }));
  });

  it("recovers durable soft-pending state and retries same deterministic nudge", async () => {
    const context = await harness();
    const failedMessages: string[] = [];
    const failingQueue = vi.fn(async (input: { messageId?: string }) => {
      failedMessages.push(input.messageId ?? "");
      throw new Error("instruction transport unavailable");
    });
    const first = enforcer({ ...context, enqueueBroker: failingQueue as never });
    await registerBudget(first, context.registry.worker);
    context.advance(800);

    await expect(first.refresh(WORKER_ID)).rejects.toThrow("instruction transport unavailable");
    expect(context.coordination.getBudget(WORKER_ID)?.enforcement.state).toBe("soft-pending");

    const restartedCoordination = await context.restartCoordination();
    const recoveredMessages: string[] = [];
    const recoveredQueue = vi.fn(async (input: { messageId?: string }) => {
      recoveredMessages.push(input.messageId ?? "");
    });
    const recovered = enforcer({
      ...context,
      coordination: restartedCoordination,
      enqueueBroker: recoveredQueue as never,
    });
    await recovered.start();
    recovered.close();

    expect(recoveredQueue).toHaveBeenCalledTimes(1);
    expect(new Set(recoveredMessages)).toEqual(new Set(failedMessages));
    expect(restartedCoordination.getBudget(WORKER_ID)?.enforcement.state).toBe("soft-notified");
  });

  it("recovers durable hard-reached state and retries existing stop path", async () => {
    const context = await harness();
    context.registry.stop.mockRejectedValueOnce(new Error("stop transport unavailable"));
    const first = enforcer(context);
    await registerBudget(first, context.registry.worker);
    context.advance(1_000);

    await expect(first.refresh(WORKER_ID)).rejects.toThrow("stop transport unavailable");
    expect(context.coordination.getBudget(WORKER_ID)?.enforcement.state).toBe("hard-reached");
    expect(() => first.assertMayConsume(WORKER_ID)).toThrow(expect.objectContaining({
      code: "WORKER_BUDGET_EXHAUSTED",
    }));

    const restartedCoordination = await context.restartCoordination();
    const recoveredRegistry = new FakeRegistry(context.registry.worker);
    const recovered = enforcer({
      ...context,
      registry: recoveredRegistry,
      coordination: restartedCoordination,
    });
    await recovered.start();
    recovered.close();

    expect(recoveredRegistry.stop).toHaveBeenCalledOnce();
    expect(recoveredRegistry.stop).toHaveBeenCalledWith(WORKER_ID);
    expect(restartedCoordination.getBudget(WORKER_ID)?.enforcement.state).toBe(
      "hard-stop-requested",
    );
  });

  it("derives percent consumption from provider remaining delta and preserves missing telemetry as unknown", async () => {
    const context = await harness();
    const snapshots: ParsedProviderBudgetTelemetry[] = [
      {
        providerUsage: {
          window: "weekly",
          usedPercent: 30,
          remainingPercent: 70,
          observedAt: new Date(BASE_MS).toISOString(),
        },
      },
      {
        providerUsage: {
          window: "weekly",
          usedPercent: 34,
          remainingPercent: 66,
          observedAt: new Date(BASE_MS + 1_000).toISOString(),
        },
      },
    ];
    const telemetry = vi.fn(async () => snapshots.shift() ?? {});
    const subject = enforcer({ ...context, telemetry });
    await registerBudget(subject, context.registry.worker, declaration("percent", 20));

    await subject.refresh(WORKER_ID);
    expect(context.coordination.getBudget(WORKER_ID)).toMatchObject({
      measurement: { status: "known", unit: "percent", amount: 0, quality: "approximate" },
      providerRemaining: { status: "available", unit: "percent", amount: 70 },
    });
    context.advance(1_000);
    await subject.refresh(WORKER_ID);
    expect(context.coordination.getBudget(WORKER_ID)).toMatchObject({
      measurement: { status: "known", unit: "percent", amount: 4, quality: "approximate" },
      providerRemaining: { status: "available", unit: "percent", amount: 66 },
      enforcement: { state: "active" },
    });

    const missingContext = await harness();
    const missing = enforcer(missingContext);
    await registerBudget(missing, missingContext.registry.worker, declaration("percent", 20));
    await missing.refresh(WORKER_ID);
    expect(missingContext.coordination.getBudget(WORKER_ID)).toMatchObject({
      measurement: { status: "unknown" },
      providerRemaining: { status: "unavailable" },
      enforcement: { state: "active" },
    });
  });

  // A resumed provider's token counter restarts at zero. Tokens the earlier generation consumed
  // must stay counted, or a worker could reset its way under a hard cap it had already spent.
  it("accumulates token consumption across process generations", async () => {
    const context = await harness();
    const enqueueBroker = vi.fn(async (_input: BrokerInstructionInput) => undefined);
    const subject = enforcer({ ...context, enqueueBroker });
    await registerBudget(subject, context.registry.worker, declaration("tokens", 1_000));

    context.registry.observation = { generation: 1, canonicalTurns: 0, tokenCount: 700 };
    await subject.refresh(WORKER_ID);
    expect(context.coordination.getBudget(WORKER_ID)).toMatchObject({
      measurement: {
        status: "known",
        unit: "tokens",
        amount: 700,
        source: "terminal-token-counter",
        generation: 1,
        generationBaseline: 0,
      },
      enforcement: { state: "active" },
    });

    // Resume: generation 2's counter starts over, on top of the 700 generation 1 spent.
    context.registry.observation = { generation: 2, canonicalTurns: 0, tokenCount: 50 };
    await subject.refresh(WORKER_ID);
    expect(context.coordination.getBudget(WORKER_ID)).toMatchObject({
      measurement: { status: "known", amount: 750, generation: 2, generationBaseline: 700 },
      enforcement: { state: "active" },
    });

    // The baseline holds within the generation: the counter adds onto 700, it does not restack.
    context.registry.observation = { generation: 2, canonicalTurns: 0, tokenCount: 150 };
    await subject.refresh(WORKER_ID);
    expect(context.coordination.getBudget(WORKER_ID)).toMatchObject({
      measurement: { status: "known", amount: 850, generation: 2, generationBaseline: 700 },
      enforcement: { state: "soft-notified" },
    });
    expect(enqueueBroker).toHaveBeenCalledTimes(1);

    context.registry.observation = { generation: 2, canonicalTurns: 0, tokenCount: 300 };
    await subject.refresh(WORKER_ID);
    expect(context.registry.stop).toHaveBeenCalledWith(WORKER_ID);
    expect(context.coordination.getBudget(WORKER_ID)).toMatchObject({
      measurement: { status: "known", amount: 1_000, generation: 2, generationBaseline: 700 },
      enforcement: { state: "hard-stop-requested" },
    });
  });
});
