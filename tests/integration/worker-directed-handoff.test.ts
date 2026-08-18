import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  IntegrationBroker,
  cleanupBrokers,
  controller,
  outcomeCodes,
  registerWorker,
} from "./worker-coordination-harness.js";

afterEach(cleanupBrokers);

const RECIPIENT = controller("receiving-orc");
const OPERATOR = {
  controllerId: "cyberdeck-operator",
  familyId: "cyberdeck-operator",
  scope: { kind: "fleet" as const, scopeId: "local-broker" },
};

function manualRegistration(workerId: string) {
  return {
    origin: {
      creatorControllerId: "legacy-unresolved",
      taskId: workerId,
      threadId: workerId,
      createdAt: "2026-08-18T09:00:00.000Z",
    },
    lifecycle: "working" as const,
    resources: {
      sessionId: workerId,
      worktreePath: `/tmp/manual/${workerId}`,
      transcriptRef: `thread:${workerId}`,
      resultStateRef: `session:${workerId}`,
      eventStreamId: `worker:${workerId}`,
    },
  };
}

describe("directed handoff: the operator moves workers onto one orchestrator", () => {
  it("moves every lease and writes the directive in a single durable transaction", async () => {
    const broker = await IntegrationBroker.open();
    const origin = controller("dispatching-orc");
    const first = await registerWorker(broker.service, { controller: origin, waveId: "wave-handoff" });
    const second = await registerWorker(broker.service, { controller: origin, waveId: "wave-handoff" });
    const recipientSessionId = randomUUID();
    const before = (await readFile(broker.store.path, "utf8")).trim().split("\n").length;

    const result = await broker.service.handoffBatch({
      mutationId: "handoff-success",
      actor: OPERATOR,
      recipient: RECIPIENT,
      recipientSessionId,
      directive: "Finish the review comments, then report back",
      members: [{ subjectId: first.workerId, name: "docs sweep" }, { subjectId: second.workerId }],
      reason: "operator directed handoff",
    });

    expect(result.committed).toBe(true);
    expect([...outcomeCodes(result).values()]).toEqual(["TRANSFERRED", "TRANSFERRED"]);
    for (const worker of [first, second]) {
      const subject = broker.service.getSubject(worker.workerId)!;
      expect(subject.lease.controller).toEqual(RECIPIENT);
      expect(subject.lease.state).toBe("active");
      // The version bump is the fencing: the old holder's next authenticated call fails on it.
      expect(subject.lease.version).toBe(2);
    }

    const lines = (await readFile(broker.store.path, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(before + 1);
    const appended = JSON.parse(lines.at(-1)!);
    expect(appended.subjects.map((subject: { subjectId: string }) => subject.subjectId))
      .toEqual([first.workerId, second.workerId]);
    expect(appended.handoffs).toHaveLength(1);
    expect(appended.handoffs[0].directive).toBe("Finish the review comments, then report back");
    expect(appended.handoffs[0].manifest.map((entry: { workerId: string }) => entry.workerId))
      .toEqual([first.workerId, second.workerId]);
    expect(appended.handoffs[0].manifest[0].name).toBe("docs sweep");
    expect(appended.handoffs[0].manifest[0].priorControllerId).toBe(origin.controllerId);
    expect(appended.audits.map((audit: { operation: string }) => audit.operation))
      .toEqual(["handoff", "handoff"]);
    // The operator moved their own fleet; the audit must not read as the recipient taking it.
    expect(appended.audits[0].actor.controllerId).toBe("cyberdeck-operator");
  });

  it("fences the previous holder out of the workers it no longer owns", async () => {
    const broker = await IntegrationBroker.open();
    const origin = controller("outgoing-orc");
    const worker = await registerWorker(broker.service, { controller: origin });

    await broker.service.handoffBatch({
      mutationId: "handoff-fencing",
      actor: OPERATOR,
      recipient: RECIPIENT,
      recipientSessionId: randomUUID(),
      directive: "take this over",
      members: [{ subjectId: worker.workerId }],
      reason: "operator directed handoff",
    });

    const staleRenew = await broker.service.renew({
      mutationId: "stale-after-handoff",
      actor: origin,
      selector: { scope: "single", subjectId: worker.workerId },
      controller: origin,
      leaseTokens: { [worker.workerId]: worker.token! },
      reason: "previous holder polls on the lease it lost",
    });
    expect([...outcomeCodes(staleRenew).values()]).toEqual(["OWNERSHIP_LOST"]);
  });

  it("registers a worker the substrate has never seen inside the same transaction", async () => {
    const broker = await IntegrationBroker.open();
    const manual = randomUUID();
    const recipientSessionId = randomUUID();

    const result = await broker.service.handoffBatch({
      mutationId: "handoff-manual",
      actor: OPERATOR,
      recipient: RECIPIENT,
      recipientSessionId,
      directive: "pick up the worker I started by hand",
      members: [{ subjectId: manual, name: "hand-started", register: manualRegistration(manual) }],
      reason: "operator directed handoff",
    });

    expect(result.committed).toBe(true);
    // Nothing held it before, so this is an acquisition rather than a transfer.
    expect([...outcomeCodes(result).values()]).toEqual(["ACQUIRED"]);
    expect(result.handoff!.manifest[0]!.priorControllerId).toBeUndefined();
    const subject = broker.service.getSubject(manual)!;
    expect(subject.lease.controller).toEqual(RECIPIENT);
    expect(subject.origin.creatorControllerId).toBe("legacy-unresolved");
    expect(subject.resources.worktreePath).toBe(`/tmp/manual/${manual}`);
    const committedLeaseVersion = subject.lease.version;

    // A service-level retry rebuilds this member from the subject that now exists, so it no longer
    // carries the one-time registration spec. That is still the same operator request and must
    // replay the committed receipt rather than collide with it.
    const replay = await broker.service.handoffBatch({
      mutationId: "handoff-manual",
      actor: OPERATOR,
      recipient: RECIPIENT,
      recipientSessionId,
      directive: "pick up the worker I started by hand",
      members: [{ subjectId: manual, name: "hand-started" }],
      reason: "operator directed handoff",
    });
    expect(replay.committed).toBe(true);
    expect(replay.handoff?.handoffId).toBe(result.handoff?.handoffId);
    expect(broker.service.getSubject(manual)?.lease.version).toBe(committedLeaseVersion);
  });

  it("aborts the whole batch when one member is terminal, leaving no lease moved", async () => {
    const broker = await IntegrationBroker.open();
    const origin = controller("origin-orc");
    const healthy = await registerWorker(broker.service, { controller: origin });
    const finished = await registerWorker(broker.service, {
      controller: origin,
      lifecycle: "done",
    });
    const manual = randomUUID();

    const result = await broker.service.handoffBatch({
      mutationId: "handoff-abort",
      actor: OPERATOR,
      recipient: RECIPIENT,
      recipientSessionId: randomUUID(),
      directive: "take the wave",
      members: [
        { subjectId: healthy.workerId },
        { subjectId: finished.workerId },
        { subjectId: manual, register: manualRegistration(manual) },
      ],
      reason: "operator directed handoff",
    });

    expect(result.committed).toBe(false);
    expect(result.handoff).toBeUndefined();
    expect(outcomeCodes(result).get(finished.workerId)).toBe("WORKER_TERMINAL");
    expect(outcomeCodes(result).get(healthy.workerId)).toBe("NOT_ELIGIBLE");
    // No partial transfer, and no half-created subject for the member that had to be registered.
    expect(broker.service.getSubject(healthy.workerId)?.lease.controller).toEqual(origin);
    expect(broker.service.getSubject(healthy.workerId)?.lease.version).toBe(1);
    expect(broker.service.getSubject(manual)).toBeUndefined();
    expect(broker.service.listHandoffs()).toEqual([]);
  });

  it("refuses a subject that is not a worker without moving the rest", async () => {
    const broker = await IntegrationBroker.open();
    const worker = await registerWorker(broker.service);
    const orchestrator = randomUUID();
    await broker.service.registerSubject({
      mutationId: `register-orc:${orchestrator}`,
      actor: OPERATOR,
      subjectId: orchestrator,
      subjectKind: "orchestrator",
      origin: {
        creatorControllerId: "legacy-unresolved",
        taskId: orchestrator,
        threadId: orchestrator,
        createdAt: "2026-08-18T09:00:00.000Z",
      },
      lifecycle: "working",
      resources: {
        sessionId: orchestrator,
        transcriptRef: `thread:${orchestrator}`,
        resultStateRef: `session:${orchestrator}`,
        eventStreamId: `worker:${orchestrator}`,
      },
      reason: "orchestrator subject",
    });

    const result = await broker.service.handoffBatch({
      mutationId: "handoff-not-a-worker",
      actor: OPERATOR,
      recipient: RECIPIENT,
      recipientSessionId: randomUUID(),
      directive: "take them both",
      members: [{ subjectId: worker.workerId }, { subjectId: orchestrator }],
      reason: "operator directed handoff",
    });

    expect(result.committed).toBe(false);
    expect(outcomeCodes(result).get(orchestrator)).toBe("NOT_ELIGIBLE");
    expect(broker.service.getSubject(worker.workerId)?.lease.version).toBe(1);
  });

  it("throws rather than half-processing a batch that names one worker twice", async () => {
    const broker = await IntegrationBroker.open();
    const worker = await registerWorker(broker.service);
    await expect(broker.service.handoffBatch({
      mutationId: "handoff-duplicate",
      actor: OPERATOR,
      recipient: RECIPIENT,
      recipientSessionId: randomUUID(),
      directive: "twice",
      members: [{ subjectId: worker.workerId }, { subjectId: worker.workerId }],
      reason: "operator directed handoff",
    })).rejects.toThrow(/duplicate subject/);
  });

  it("refuses a member with no lease record and no registration to create one", async () => {
    const broker = await IntegrationBroker.open();
    await expect(broker.service.handoffBatch({
      mutationId: "handoff-unknown",
      actor: OPERATOR,
      recipient: RECIPIENT,
      recipientSessionId: randomUUID(),
      directive: "take the ghost",
      members: [{ subjectId: randomUUID() }],
      reason: "operator directed handoff",
    })).rejects.toThrow(/no lease record/);
  });

  it("replays one mutation id rather than transferring twice", async () => {
    const broker = await IntegrationBroker.open();
    const worker = await registerWorker(broker.service, { controller: controller("origin-orc") });
    const input = {
      mutationId: "handoff-idempotent",
      actor: OPERATOR,
      recipient: RECIPIENT,
      recipientSessionId: randomUUID(),
      directive: "take it once",
      members: [{ subjectId: worker.workerId }],
      reason: "operator directed handoff",
    };

    const first = await broker.service.handoffBatch(input);
    const lines = (await readFile(broker.store.path, "utf8")).trim().split("\n").length;
    const second = await broker.service.handoffBatch(input);

    expect(second.committed).toBe(true);
    expect(second.handoff?.handoffId).toBe(first.handoff!.handoffId);
    expect((await readFile(broker.store.path, "utf8")).trim().split("\n")).toHaveLength(lines);
    expect(broker.service.getSubject(worker.workerId)?.lease.version).toBe(2);
  });

  it("replays a lost delivery response until explicit acknowledgement, durably across restart", async () => {
    const broker = await IntegrationBroker.open();
    const worker = await registerWorker(broker.service, { controller: controller("origin-orc") });
    const committed = await broker.service.handoffBatch({
      mutationId: "handoff-durable",
      actor: OPERATOR,
      recipient: RECIPIENT,
      recipientSessionId: randomUUID(),
      directive: "survive the restart",
      members: [{ subjectId: worker.workerId }],
      reason: "operator directed handoff",
    });

    await broker.restart();
    expect(broker.service.listHandoffs({ controllerId: RECIPIENT.controllerId, state: "pending" }))
      .toHaveLength(1);
    // Another controller cannot see a record addressed to the recipient.
    expect(broker.service.pendingHandoffs({ controllerId: "controller:someone-else", limit: 1 }))
      .toEqual([]);

    const delivered = broker.service.pendingHandoffs({ controllerId: RECIPIENT.controllerId, limit: 1 });
    expect(delivered.map((handoff) => handoff.handoffId)).toEqual([committed.handoff!.handoffId]);
    expect(delivered[0]!.directive).toBe("survive the restart");
    // Model a response lost after the read: no state changed, so the exact directive replays.
    const replayed = broker.service.pendingHandoffs({ controllerId: RECIPIENT.controllerId, limit: 1 });
    expect(replayed).toEqual(delivered);

    await expect(broker.service.acknowledgeHandoffs({
      controllerId: "controller:someone-else",
      handoffIds: [committed.handoff!.handoffId],
    })).rejects.toMatchObject({ code: "HANDOFF_NOT_FOUND" });

    const acknowledged = await broker.service.acknowledgeHandoffs({
      controllerId: RECIPIENT.controllerId,
      handoffIds: [committed.handoff!.handoffId],
    });
    expect(acknowledged[0]).toMatchObject({
      handoffId: committed.handoff!.handoffId,
      state: "acknowledged",
    });
    expect(broker.service.pendingHandoffs({ controllerId: RECIPIENT.controllerId, limit: 1 }))
      .toEqual([]);

    // Acknowledgement is durable, and retry after a lost acknowledgement response is idempotent.
    await broker.restart();
    expect(broker.service.pendingHandoffs({ controllerId: RECIPIENT.controllerId, limit: 1 }))
      .toEqual([]);
    expect((await broker.service.acknowledgeHandoffs({
      controllerId: RECIPIENT.controllerId,
      handoffIds: [committed.handoff!.handoffId],
    }))[0]?.state).toBe("acknowledged");
    expect(broker.service.listHandoffs({ controllerId: RECIPIENT.controllerId })[0]?.state)
      .toBe("acknowledged");
  });

  it("pages pending handoffs oldest-first and leaves the remainder pending", async () => {
    const broker = await IntegrationBroker.open();
    const handoffIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const worker = await registerWorker(broker.service, { controller: controller(`origin-${index}`) });
      const result = await broker.service.handoffBatch({
        mutationId: `handoff-page-${index}`,
        actor: OPERATOR,
        recipient: RECIPIENT,
        recipientSessionId: randomUUID(),
        directive: `page ${index}`,
        members: [{ subjectId: worker.workerId }],
        reason: "operator directed handoff",
      });
      handoffIds.push(result.handoff!.handoffId);
    }

    const firstPage = broker.service.pendingHandoffs({
      controllerId: RECIPIENT.controllerId,
      limit: 2,
    });
    expect(firstPage.map((handoff) => handoff.handoffId)).toEqual(handoffIds.slice(0, 2));
    expect(broker.service.listHandoffs({ controllerId: RECIPIENT.controllerId, state: "pending" }))
      .toHaveLength(3);

    await broker.service.acknowledgeHandoffs({
      controllerId: RECIPIENT.controllerId,
      handoffIds: firstPage.map((handoff) => handoff.handoffId),
    });
    expect(broker.service.pendingHandoffs({ controllerId: RECIPIENT.controllerId, limit: 2 })
      .map((handoff) => handoff.handoffId)).toEqual(handoffIds.slice(2));
    expect(broker.service.listHandoffs({ controllerId: RECIPIENT.controllerId, state: "pending" }))
      .toHaveLength(1);
  });
});
