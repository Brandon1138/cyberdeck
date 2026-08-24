import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WorkerCoordinationService,
  type RegisterSubjectInput,
} from "../../src/broker/worker-coordination.js";
import type { WorkerBudgetDeclaration } from "../../src/domain/worker-budget.js";
import { WorkerBudgetDeclarationSchema } from "../../src/domain/worker-budget.js";
import { WorkerCoordinationStore } from "../../src/persistence/worker-coordination-store.js";

const directories: string[] = [];
const BASE_MS = Date.parse("2026-08-24T10:00:00.000Z");
const actor = {
  controllerId: "orchestrator:fleet:test",
  familyId: "orchestrator:fleet:test",
  scope: { kind: "fleet" as const, scopeId: "fleet:test" },
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function declaration(amount = 20): WorkerBudgetDeclaration {
  return WorkerBudgetDeclarationSchema.parse({
    resource: "weekly",
    allocation: { unit: "percent", amount },
  });
}

async function harness(directory?: string) {
  const stateDirectory = directory ?? await mkdtemp(join(tmpdir(), "cyberdeck-worker-budget-"));
  if (directory === undefined) directories.push(stateDirectory);
  let nowMs = BASE_MS;
  const store = new WorkerCoordinationStore(stateDirectory);
  const service = new WorkerCoordinationService({
    store,
    now: () => new Date(nowMs).toISOString(),
  });
  await service.initialize();
  return {
    stateDirectory,
    store,
    service,
    advance(milliseconds: number) { nowMs += milliseconds; },
    now(offset = 0) { return new Date(nowMs + offset).toISOString(); },
  };
}

async function register(
  service: WorkerCoordinationService,
  budget?: WorkerBudgetDeclaration,
): Promise<string> {
  const workerId = randomUUID();
  const input: RegisterSubjectInput = {
    mutationId: `register:${workerId}`,
    actor,
    subjectId: workerId,
    origin: {
      creatorControllerId: actor.controllerId,
      creatorSessionId: randomUUID(),
      taskId: `task:${workerId}`,
      threadId: `thread:${workerId}`,
      createdAt: new Date(BASE_MS).toISOString(),
    },
    lifecycle: "working",
    resources: {
      sessionId: workerId,
      eventStreamId: `stream:${workerId}`,
    },
    controller: actor,
    ...(budget === undefined ? {} : { budget }),
    reason: "test worker registration",
  };
  await service.registerSubject(input);
  return workerId;
}

describe("WorkerCoordinationService budgets", () => {
  it("registers initial budget and receipt in one fsynced transaction", async () => {
    const { service, store } = await harness();
    const workerId = await register(service, declaration());

    expect(service.getBudget(workerId)).toMatchObject({
      revision: 1,
      declaration: {
        resource: "weekly",
        allocation: { unit: "percent", amount: 20 },
      },
      measurement: { status: "unknown" },
      enforcement: { state: "active" },
    });
    const lines = (await readFile(store.path, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      subjects: [{ subjectId: workerId, budget: { revision: 1 } }],
      receipts: [{ mutationId: `register:${workerId}`, operation: "register" }],
    });
  });

  it("binds declaration replay to request payload", async () => {
    const { service } = await harness();
    const workerId = await register(service);
    const request = {
      mutationId: `budget:declare:${workerId}`,
      subjectId: workerId,
      declaration: declaration(),
      reason: "operator allocated weekly allowance",
    };
    const first = await service.declareBudget(request);
    await expect(service.declareBudget(request)).resolves.toEqual({
      ...first,
      idempotentReplay: true,
    });
    await expect(service.declareBudget({
      ...request,
      declaration: declaration(25),
    })).rejects.toMatchObject({ code: "MUTATION_ID_COLLISION" });
  });

  it("keeps cumulative consumption monotonic and revision stable", async () => {
    const { service, advance, now } = await harness();
    const workerId = await register(service, declaration());
    const observedAt = now();
    await service.observeBudget({
      mutationId: `budget:observe:1:${workerId}`,
      subjectId: workerId,
      measurement: {
        status: "known",
        unit: "percent",
        amount: 5,
        source: "provider-telemetry",
        quality: "approximate",
        observedAt,
        staleAfterMs: 60_000,
      },
      reason: "provider snapshot",
    });
    advance(1_000);
    const lower = await service.observeBudget({
      mutationId: `budget:observe:2:${workerId}`,
      subjectId: workerId,
      measurement: {
        status: "known",
        unit: "percent",
        amount: 4,
        source: "provider-telemetry",
        quality: "approximate",
        observedAt: now(),
        staleAfterMs: 60_000,
      },
      reason: "lower cumulative snapshot",
    });
    const stale = await service.observeBudget({
      mutationId: `budget:observe:3:${workerId}`,
      subjectId: workerId,
      measurement: {
        status: "known",
        unit: "percent",
        amount: 8,
        source: "provider-telemetry",
        quality: "approximate",
        observedAt: new Date(BASE_MS - 1).toISOString(),
        staleAfterMs: 60_000,
      },
      reason: "stale snapshot",
    });

    expect(lower.changed).toBe(false);
    expect(stale.changed).toBe(false);
    expect(service.getBudget(workerId)).toMatchObject({
      revision: 1,
      measurement: { status: "known", amount: 5, observedAt },
    });
  });

  it("uses allocation revision CAS for extension and reduction", async () => {
    const { service } = await harness();
    const workerId = await register(service, declaration());
    const extended = await service.adjustBudget({
      mutationId: `budget:extend:${workerId}`,
      subjectId: workerId,
      expectedRevision: 1,
      direction: "extend",
      amount: 5,
      reason: "operator approved extension",
    });
    expect(extended).toMatchObject({
      revision: 2,
      budget: { declaration: { allocation: { amount: 25 } } },
    });
    await expect(service.adjustBudget({
      mutationId: `budget:stale-reduce:${workerId}`,
      subjectId: workerId,
      expectedRevision: 1,
      direction: "reduce",
      amount: 5,
      reason: "stale menu state",
    })).rejects.toMatchObject({ code: "BUDGET_REVISION_CONFLICT" });
    await expect(service.adjustBudget({
      mutationId: `budget:invalid-reduce:${workerId}`,
      subjectId: workerId,
      expectedRevision: 2,
      direction: "reduce",
      amount: 25,
      reason: "cannot reduce allowance to zero",
    })).rejects.toMatchObject({ code: "BUDGET_ADJUSTMENT_INVALID" });
  });

  it("persists soft and hard actions, then reactivates after extension", async () => {
    const { service, advance, now } = await harness();
    const workerId = await register(service, declaration());
    const listener = vi.fn((subjectId: string) => {
      expect(service.getBudget(subjectId)).toBeDefined();
    });
    const unsubscribe = service.onBudgetUpdate(listener);

    await service.observeBudget({
      mutationId: `budget:soft:${workerId}`,
      subjectId: workerId,
      measurement: {
        status: "known",
        unit: "percent",
        amount: 16,
        source: "provider-telemetry",
        quality: "approximate",
        observedAt: now(),
        staleAfterMs: 60_000,
      },
      reason: "soft threshold measurement",
    });
    expect(service.getBudget(workerId)?.enforcement.state).toBe("soft-pending");
    await service.advanceBudgetEnforcement({
      mutationId: `budget:soft-notified:${workerId}`,
      subjectId: workerId,
      expectedRevision: 1,
      state: "soft-notified",
      reason: "wrap-up instruction persisted",
    });
    advance(1_000);
    await service.observeBudget({
      mutationId: `budget:hard:${workerId}`,
      subjectId: workerId,
      measurement: {
        status: "known",
        unit: "percent",
        amount: 20,
        source: "provider-telemetry",
        quality: "approximate",
        observedAt: now(),
        staleAfterMs: 60_000,
      },
      reason: "hard threshold measurement",
    });
    expect(service.getBudget(workerId)?.enforcement.state).toBe("hard-reached");
    await service.advanceBudgetEnforcement({
      mutationId: `budget:hard-stopped:${workerId}`,
      subjectId: workerId,
      expectedRevision: 1,
      state: "hard-stop-requested",
      reason: "existing worker stop path requested",
    });
    expect(service.getBudget(workerId)?.enforcement.state).toBe("hard-stop-requested");

    const extended = await service.adjustBudget({
      mutationId: `budget:reactivate:${workerId}`,
      subjectId: workerId,
      expectedRevision: 1,
      direction: "extend",
      amount: 10,
      reason: "operator extended allowance",
    });
    expect(extended.budget.enforcement.state).toBe("active");
    expect(listener).toHaveBeenCalledTimes(5);
    unsubscribe();
  });
});
