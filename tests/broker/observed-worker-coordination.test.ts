import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ObservedWorkerCoordinationService } from "../../src/broker/observed-worker-coordination.js";
import type { ControllerIdentity, WorkerEvent } from "../../src/domain/worker-coordination.js";
import { WorkerCoordinationStore } from "../../src/persistence/worker-coordination-store.js";

const directories: string[] = [];
const baseMs = Date.parse("2026-10-07T10:00:00.000Z");

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function controller(name: string): ControllerIdentity {
  return {
    controllerId: `controller:${name}`,
    familyId: `family:${name}`,
    scope: { kind: "worktree", scopeId: `repo:${name}`, worktreePath: `/tmp/${name}` },
  };
}

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), "cyberdeck-observed-coordination-"));
  directories.push(directory);
  const service = new ObservedWorkerCoordinationService({
    store: new WorkerCoordinationStore(directory),
    now: () => new Date(baseMs).toISOString(),
    leaseDurationMs: 30_000,
    gracePeriodMs: 5_000,
  });
  await service.initialize();
  return service;
}

async function register(service: ObservedWorkerCoordinationService, owner: ControllerIdentity) {
  const workerId = randomUUID();
  const result = await service.registerSubject({
    mutationId: `register:${workerId}`,
    actor: owner,
    subjectId: workerId,
    origin: {
      creatorControllerId: owner.controllerId,
      creatorSessionId: randomUUID(),
      taskId: `task:${workerId}`,
      threadId: `thread:${workerId}`,
      createdAt: new Date(baseMs).toISOString(),
    },
    lifecycle: "working",
    resources: {
      sessionId: workerId,
      worktreePath: `/tmp/worktrees/${workerId}`,
      taskPayloadRef: `task-payload:${workerId}`,
      transcriptRef: `transcript:${workerId}`,
      resultStateRef: `result:${workerId}`,
      eventStreamId: `stream:${workerId}`,
    },
    controller: owner,
    reason: "test registration",
  });
  return {
    workerId,
    token: result.outcomes[0]!.leaseToken!,
    version: result.outcomes[0]!.leaseVersion!,
  };
}

function event(workerId: string, leaseVersion: number, sequence: number): WorkerEvent {
  return {
    schemaVersion: 1,
    eventId: `event:${workerId}:${sequence}`,
    sequence,
    workerId,
    taskId: `task:${workerId}`,
    controllerLeaseVersion: leaseVersion,
    kind: "PROGRESS",
    severity: "info",
    interventionRequired: false,
    summary: `progress ${sequence}`,
    evidenceRefs: [],
    changedAssumptions: [],
    continuation: "continuing",
    timestamp: new Date(baseMs + sequence).toISOString(),
  };
}

describe("ObservedWorkerCoordinationService", () => {
  it("tells event observers about accepted events only, after the substrate persisted them", async () => {
    const service = await harness();
    const owner = controller("owner");
    const worker = await register(service, owner);
    const observer = vi.fn();
    const stop = service.onEventSubmitted(observer);

    const accepted = await service.submitEvent({
      mutationId: "submit-1",
      controller: owner,
      leaseToken: worker.token,
      event: event(worker.workerId, worker.version, 1),
    });
    expect(accepted.code).toBe("accepted");
    expect(observer).toHaveBeenCalledTimes(1);
    expect(observer).toHaveBeenCalledWith(
      expect.objectContaining({ workerId: worker.workerId, sequence: 1, kind: "PROGRESS" }),
      expect.objectContaining({ code: "accepted" }),
    );

    const rejected = await service.submitEvent({
      mutationId: "submit-2",
      controller: owner,
      leaseToken: "not-the-token",
      event: event(worker.workerId, worker.version, 2),
    });
    expect(rejected.code).toBe("rejected");
    expect(observer).toHaveBeenCalledTimes(1);

    const duplicate = await service.submitEvent({
      mutationId: "submit-1",
      controller: owner,
      leaseToken: worker.token,
      event: event(worker.workerId, worker.version, 1),
    });
    expect(duplicate.code).toBe("accepted");
    expect(observer).toHaveBeenCalledTimes(1);

    stop();
    await service.submitEvent({
      mutationId: "submit-3",
      controller: owner,
      leaseToken: worker.token,
      event: event(worker.workerId, worker.version, 3),
    });
    expect(observer).toHaveBeenCalledTimes(1);
  });

  it("isolates a throwing observer from the acknowledgement", async () => {
    const service = await harness();
    const owner = controller("owner");
    const worker = await register(service, owner);
    service.onEventSubmitted(() => { throw new Error("observer failed"); });
    const second = vi.fn();
    service.onEventSubmitted(second);
    await expect(service.submitEvent({
      mutationId: "submit-1",
      controller: owner,
      leaseToken: worker.token,
      event: event(worker.workerId, worker.version, 1),
    })).resolves.toMatchObject({ code: "accepted" });
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("tells handoff observers about committed batches with the durable handoff record", async () => {
    const service = await harness();
    const source = controller("source");
    const recipient = controller("recipient");
    const worker = await register(service, source);
    const observer = vi.fn();
    service.onHandoffCommitted(observer);
    const request = {
      mutationId: "handoff-1",
      actor: controller("operator"),
      recipient,
      recipientSessionId: "55555555-5555-4555-8555-555555555555",
      directive: "Pick this up",
      members: [{ subjectId: worker.workerId, name: "docs sweep" }],
      reason: "operator directed handoff",
    };
    const result = await service.handoffBatch(request);
    expect(result.committed).toBe(true);
    expect(observer).toHaveBeenCalledTimes(1);
    expect(observer.mock.calls[0]![1]).toMatchObject({
      committed: true,
      handoff: expect.objectContaining({
        recipient: expect.objectContaining({ controllerId: recipient.controllerId }),
        state: "pending",
      }),
    });

    const aborted = await service.handoffBatch({
      ...request,
      mutationId: "handoff-2",
      members: [{ subjectId: randomUUID() }],
    }).catch((error: unknown) => error);
    expect(observer).toHaveBeenCalledTimes(1);
    expect(aborted).toBeDefined();
  });
});
