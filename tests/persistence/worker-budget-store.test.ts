import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkerCoordinationService } from "../../src/broker/worker-coordination.js";
import { WorkerBudgetDeclarationSchema } from "../../src/domain/worker-budget.js";
import { WorkerCoordinationStore } from "../../src/persistence/worker-coordination-store.js";

const directories: string[] = [];
const BASE_MS = Date.parse("2026-08-24T10:00:00.000Z");

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("worker budget persistence", () => {
  it("replays revision, measurement, provider freshness, and enforcement exactly", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "cyberdeck-budget-replay-"));
    directories.push(stateDirectory);
    let nowMs = BASE_MS;
    const now = () => new Date(nowMs).toISOString();
    const service = new WorkerCoordinationService({
      store: new WorkerCoordinationStore(stateDirectory),
      now,
    });
    await service.initialize();
    const workerId = randomUUID();
    const controller = {
      controllerId: "orchestrator:fleet:persistence",
      familyId: "orchestrator:fleet:persistence",
      scope: { kind: "fleet" as const, scopeId: "fleet:persistence" },
    };
    await service.registerSubject({
      mutationId: `register:${workerId}`,
      actor: controller,
      subjectId: workerId,
      origin: {
        creatorControllerId: controller.controllerId,
        taskId: `task:${workerId}`,
        threadId: `thread:${workerId}`,
        createdAt: now(),
      },
      lifecycle: "working",
      resources: { sessionId: workerId, eventStreamId: `stream:${workerId}` },
      controller,
      budget: WorkerBudgetDeclarationSchema.parse({
        resource: "weekly",
        allocation: { unit: "percent", amount: 20 },
      }),
      reason: "persistence fixture",
    });
    await service.observeBudget({
      mutationId: `observe:soft:${workerId}`,
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
      providerRemaining: {
        status: "available",
        unit: "percent",
        amount: 42,
        quality: "approximate",
        observedAt: now(),
        staleAfterMs: 60_000,
      },
      reason: "provider snapshot",
    });
    await service.advanceBudgetEnforcement({
      mutationId: `enforce:soft:${workerId}`,
      subjectId: workerId,
      expectedRevision: 1,
      state: "soft-notified",
      reason: "wrap-up delivered",
    });
    await service.adjustBudget({
      mutationId: `adjust:${workerId}`,
      subjectId: workerId,
      expectedRevision: 1,
      direction: "extend",
      amount: 5,
      reason: "operator extension",
    });
    nowMs += 1_000;
    await service.observeBudget({
      mutationId: `observe:hard:${workerId}`,
      subjectId: workerId,
      measurement: {
        status: "known",
        unit: "percent",
        amount: 25,
        source: "provider-telemetry",
        quality: "approximate",
        observedAt: now(),
        staleAfterMs: 60_000,
      },
      reason: "hard threshold snapshot",
    });
    await service.advanceBudgetEnforcement({
      mutationId: `enforce:hard:${workerId}`,
      subjectId: workerId,
      expectedRevision: 2,
      state: "hard-stop-requested",
      reason: "worker stop requested",
    });
    const beforeRestart = service.getBudget(workerId);
    expect(beforeRestart).toMatchObject({
      revision: 2,
      measurement: { status: "known", amount: 25, staleAfterMs: 60_000 },
      providerRemaining: { status: "available", amount: 42, staleAfterMs: 60_000 },
      enforcement: { state: "hard-stop-requested", revision: 2 },
    });

    const restarted = new WorkerCoordinationService({
      store: new WorkerCoordinationStore(stateDirectory),
      now,
    });
    await restarted.initialize();
    expect(restarted.getBudget(workerId)).toEqual(beforeRestart);
  });
});
