import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { StoredWorkerEvent } from "../../src/domain/worker-coordination.js";
import {
  IntegrationBroker,
  cleanupBrokers,
  controller,
  outcomeFor,
  registerWorker,
  submit,
  tokenFor,
  workerEvent,
} from "./worker-coordination-harness.js";

afterEach(cleanupBrokers);

const NOISY = { eventRateLimit: 500, maxQueuedEventsPerWorker: 512 };

describe("worker coordination: event delivery and coalescing", () => {
  it("delivers an EXCEPTION immediately while progress coalesces behind it", async () => {
    const broker = await IntegrationBroker.open(NOISY);
    const owner = controller("delivery");
    const worker = await registerWorker(broker.service, { controller: owner, waveId: "wave-events" });
    const token = worker.token!;
    const version = worker.version!;

    for (const sequence of [1, 2, 3]) {
      const ack = await submit(broker.service, owner, token, workerEvent(worker, version, sequence, {
        evidenceRefs: [`ref:${sequence}`],
        changedAssumptions: [`assumption:${sequence}`],
        structuredFacts: { [`fact${sequence}`]: sequence },
      }));
      expect(ack.code).toBe("accepted");
      if (sequence > 1) expect(ack.supersededEventIds).toHaveLength(1);
    }

    const activeProgress = broker.service.projectEvents({ filter: { kinds: ["PROGRESS"] } }).events;
    expect(activeProgress).toHaveLength(1);
    const coalesced = activeProgress[0]!;
    expect(coalesced.summary).toBe("progress 3");
    expect(coalesced.evidenceRefs).toEqual(["ref:1", "ref:2", "ref:3"]);
    expect(coalesced.changedAssumptions).toEqual([
      "assumption:1",
      "assumption:2",
      "assumption:3",
    ]);
    expect(coalesced.structuredFacts).toEqual({ fact1: 1, fact2: 2, fact3: 3 });
    expect(coalesced.continuation).toBe("continuing");
    expect(broker.service.getSubject(worker.workerId)?.lifecycle).toBe("working");
    expect(broker.service.getSubject(worker.workerId)?.decisionGate?.state).toBe("none");

    const failure = workerEvent(worker, version, 4, {
      kind: "EXCEPTION",
      severity: "error",
      interventionRequired: true,
      summary: "dependency install failed",
      continuation: "blocked",
    });
    const failureAck = await submit(broker.service, owner, token, failure);
    expect(failureAck).toMatchObject({ code: "accepted", eventId: failure.eventId, sequence: 4 });
    expect(failureAck.supersededEventIds).toBeUndefined();

    const unresolved = broker.service.projectEvents({ filter: { intervention: "unresolved" } });
    expect(unresolved.events.map(({ eventId }) => eventId)).toEqual([failure.eventId]);
    expect(unresolved.hasMore).toBe(false);
    // The exception does not move the worker itself; lifecycle stays a controller decision.
    expect(broker.service.getSubject(worker.workerId)?.lifecycle).toBe("working");
  });

  it("keeps EXCEPTION and DECISION_REQUEST pinned until they are explicitly resolved", async () => {
    const broker = await IntegrationBroker.open(NOISY);
    const owner = controller("pinning");
    const worker = await registerWorker(broker.service, { controller: owner });
    const token = worker.token!;
    const version = worker.version!;

    const firstFailure = workerEvent(worker, version, 1, {
      kind: "EXCEPTION",
      severity: "error",
      interventionRequired: true,
      summary: "first failure",
      continuation: "blocked",
    });
    const secondFailure = workerEvent(worker, version, 2, {
      kind: "EXCEPTION",
      severity: "critical",
      interventionRequired: true,
      summary: "second failure",
      continuation: "blocked",
    });
    const decision = workerEvent(worker, version, 3, {
      kind: "DECISION_REQUEST",
      severity: "warning",
      interventionRequired: true,
      summary: "which migration strategy should I take",
      recommendedAction: "expand-and-contract",
      continuation: "awaiting-response",
    });
    for (const event of [firstFailure, secondFailure, decision]) {
      const ack = await submit(broker.service, owner, token, event);
      expect(ack.code).toBe("accepted");
      expect(ack.supersededEventIds).toBeUndefined();
    }

    // Later progress must not coalesce or evict any pinned event.
    await submit(broker.service, owner, token, workerEvent(worker, version, 4));
    expect(broker.service.projectEvents({ filter: { intervention: "unresolved" } })
      .events.map(({ eventId }) => eventId))
      .toEqual([firstFailure.eventId, secondFailure.eventId, decision.eventId]);

    const acknowledged = await broker.service.resolveEvent({
      mutationId: "resolve-first-failure",
      controller: owner,
      leaseToken: token,
      eventId: firstFailure.eventId,
      resolution: "acknowledged",
      reason: "controller triaged the failure",
    });
    expect(acknowledged.code).toBe("accepted");

    expect(broker.service.projectEvents({ filter: { intervention: "unresolved" } })
      .events.map(({ eventId }) => eventId))
      .toEqual([secondFailure.eventId, decision.eventId]);
    expect(broker.service.projectEvents({ filter: { intervention: "resolved" } })
      .events.map(({ eventId }) => eventId))
      .toEqual([firstFailure.eventId]);
    const resolved = broker.service.projectEvents({ filter: { intervention: "resolved" } }).events[0]!;
    expect(resolved.state).toBe("acknowledged");
    expect(resolved.resolvedBy).toEqual(owner);
    expect(resolved.resolvedAt).toBe(broker.now());
  });

  it("carries unresolved interventions across a controller transfer and a broker restart", async () => {
    const broker = await IntegrationBroker.open({ ...NOISY, leaseDurationMs: 120_000 });
    const first = controller("intervention-first");
    const second = controller("intervention-second");
    const worker = await registerWorker(broker.service, { controller: first });
    const failure = workerEvent(worker, worker.version!, 1, {
      kind: "EXCEPTION",
      severity: "error",
      interventionRequired: true,
      summary: "worker needs a human decision",
      continuation: "blocked",
    });
    await submit(broker.service, first, worker.token!, failure);

    const handoff = await broker.service.transfer({
      mutationId: "intervention-handoff",
      actor: first,
      selector: { scope: "single", subjectId: worker.workerId },
      controller: first,
      leaseToken: worker.token!,
      newController: second,
      reason: "handoff with an open intervention",
    });
    expect(outcomeFor(handoff, worker.workerId).code).toBe("TRANSFERRED");
    const successorToken = tokenFor(handoff, worker.workerId);
    expect(broker.service.projectEvents({ filter: { intervention: "unresolved" } })
      .events.map(({ eventId }) => eventId)).toEqual([failure.eventId]);

    await broker.restart();
    const afterRestart = broker.service.projectEvents({ filter: { intervention: "unresolved" } });
    expect(afterRestart.events.map(({ eventId }) => eventId)).toEqual([failure.eventId]);
    expect(afterRestart.events[0]?.state).toBe("active");

    // The retired controller cannot close the intervention it opened.
    const staleResolution = {
      mutationId: "stale-resolution",
      controller: first,
      leaseToken: worker.token!,
      eventId: failure.eventId,
      resolution: "closed",
      reason: "stale controller tries to close",
    } as const;
    const rejected = await broker.service.resolveEvent(staleResolution);
    expect(rejected).toMatchObject({ code: "rejected", errorCode: "OWNERSHIP_LOST" });
    await expect(broker.service.resolveEvent(staleResolution)).resolves.toEqual(rejected);
    expect(broker.service.projectEvents({ filter: { intervention: "unresolved" } })
      .events).toHaveLength(1);

    await broker.service.resolveEvent({
      mutationId: "successor-resolution",
      controller: second,
      leaseToken: successorToken,
      eventId: failure.eventId,
      resolution: "closed",
      reason: "successor handled the intervention",
    });
    expect(broker.service.projectEvents({ filter: { intervention: "unresolved" } })
      .events).toHaveLength(0);

    await broker.restart();
    const closed = broker.service.projectEvents({ filter: { intervention: "resolved" } }).events[0]!;
    expect(closed.state).toBe("closed");
    expect(closed.resolvedBy).toEqual(second);
  });

  it("coalesces progress per worker and per kind, never across them", async () => {
    const broker = await IntegrationBroker.open(NOISY);
    const owner = controller("coalescing");
    const left = await registerWorker(broker.service, { controller: owner, waveId: "wave-coalesce" });
    const right = await registerWorker(broker.service, { controller: owner, waveId: "wave-coalesce" });

    await submit(broker.service, owner, left.token!, workerEvent(left, left.version!, 1));
    await submit(broker.service, owner, right.token!, workerEvent(right, right.version!, 1));
    const risk = workerEvent(left, left.version!, 2, {
      kind: "RISK",
      severity: "warning",
      summary: "flaky integration dependency",
    });
    await submit(broker.service, owner, left.token!, risk);
    const secondLeftProgress = await submit(
      broker.service,
      owner,
      left.token!,
      workerEvent(left, left.version!, 3, { summary: "left progress 3" }),
    );
    expect(secondLeftProgress.supersededEventIds).toHaveLength(1);

    const byWorker = (workerId: string): StoredWorkerEvent[] =>
      broker.service.projectEvents({ filter: { workerIds: [workerId] } }).events;
    expect(byWorker(left.workerId).map(({ kind, summary }) => ({ kind, summary }))).toEqual([
      { kind: "RISK", summary: "flaky integration dependency" },
      { kind: "PROGRESS", summary: "left progress 3" },
    ]);
    expect(byWorker(right.workerId).map(({ summary }) => summary)).toEqual(["progress 1"]);
    expect(broker.service.projectEvents({ filter: { waveId: "wave-coalesce" } }).events)
      .toHaveLength(3);
  });
});

describe("worker coordination: checkpoints and decision gates", () => {
  it("correlates a checkpoint answer and treats a repeated request as the same checkpoint", async () => {
    const broker = await IntegrationBroker.open(NOISY);
    const owner = controller("checkpoints");
    const worker = await registerWorker(broker.service, { controller: owner });
    const token = worker.token!;
    const version = worker.version!;

    const request = {
      mutationId: "checkpoint-one",
      controller: owner,
      leaseToken: token,
      correlationId: "correlation:one",
      workerId: worker.workerId,
      focus: "test coverage",
      question: "which paths are still untested",
    };
    const checkpoint = await broker.service.requestCheckpoint(request);
    expect(checkpoint).toMatchObject({
      correlationId: "correlation:one",
      state: "pending",
      mode: "non-blocking",
      requestedBy: owner,
    });
    // Same mutation id replays the receipt; a fresh mutation id on the same correlation id
    // returns the existing checkpoint instead of opening a second one.
    expect(await broker.service.requestCheckpoint(request)).toEqual(checkpoint);
    expect(await broker.service.requestCheckpoint({ ...request, mutationId: "checkpoint-retry" }))
      .toEqual(checkpoint);
    expect(broker.service.listCheckpoints(worker.workerId, "pending")).toHaveLength(1);
    expect(broker.service.getSubject(worker.workerId)?.decisionGate?.state).toBe("none");

    const wrongKind = workerEvent(worker, version, 1, {
      checkpointCorrelationId: "correlation:one",
    });
    expect(await submit(broker.service, owner, token, wrongKind)).toMatchObject({
      code: "rejected",
      errorCode: "CHECKPOINT_CORRELATION_INVALID",
    });
    const unknownCorrelation = workerEvent(worker, version, 1, {
      kind: "CHECKPOINT",
      summary: "answer to a checkpoint that was never opened",
      checkpointCorrelationId: "correlation:missing",
    });
    expect(await submit(broker.service, owner, token, unknownCorrelation)).toMatchObject({
      code: "rejected",
      errorCode: "CHECKPOINT_CORRELATION_INVALID",
    });

    const answer = workerEvent(worker, version, 1, {
      kind: "CHECKPOINT",
      summary: "three adapters still untested",
      checkpointCorrelationId: "correlation:one",
    });
    expect(await submit(broker.service, owner, token, answer)).toMatchObject({ code: "accepted" });
    const answered = broker.service.listCheckpoints(worker.workerId)[0]!;
    expect(answered).toMatchObject({
      state: "answered",
      answeredByEventId: answer.eventId,
      answeredAt: broker.now(),
    });
    expect(broker.service.listCheckpoints(worker.workerId, "pending")).toHaveLength(0);

    // A second answer to a settled checkpoint is refused.
    const lateAnswer = workerEvent(worker, version, 2, {
      kind: "CHECKPOINT",
      summary: "duplicate answer",
      checkpointCorrelationId: "correlation:one",
    });
    expect(await submit(broker.service, owner, token, lateAnswer)).toMatchObject({
      code: "rejected",
      errorCode: "CHECKPOINT_CORRELATION_INVALID",
    });

    await broker.restart();
    expect(broker.service.listCheckpoints(worker.workerId)[0]).toEqual(answered);
  });

  it("drives an explicit decision gate through pause, answer, and resume", async () => {
    const broker = await IntegrationBroker.open({ ...NOISY, leaseDurationMs: 120_000 });
    const owner = controller("decision-gate");
    const worker = await registerWorker(broker.service, { controller: owner });
    const token = worker.token!;
    const version = worker.version!;

    const decision = workerEvent(worker, version, 1, {
      kind: "DECISION_REQUEST",
      severity: "warning",
      interventionRequired: true,
      summary: "schema migration needs a call",
      recommendedAction: "expand-and-contract",
      continuation: "awaiting-response",
    });
    await submit(broker.service, owner, token, decision);

    const single = { scope: "single" as const, subjectId: worker.workerId };
    const paused = await broker.service.updateLifecycle({
      mutationId: "gate-pause-lifecycle",
      actor: owner,
      selector: single,
      subjectId: worker.workerId,
      controller: owner,
      leaseToken: token,
      lifecycle: "waiting",
      reason: "worker blocked on a decision",
    });
    expect(outcomeFor(paused, worker.workerId).code).toBe("ALREADY_CONTROLLED");

    const gate = await broker.service.requestCheckpoint({
      mutationId: "gate-open",
      controller: owner,
      leaseToken: token,
      correlationId: "gate:one",
      workerId: worker.workerId,
      question: "expand-and-contract or a hard cutover",
      mode: "decision-gate",
    });
    expect(gate.mode).toBe("decision-gate");
    expect(broker.service.getSubject(worker.workerId)?.decisionGate).toEqual({
      state: "decision-gate",
      correlationId: "gate:one",
      pausedAt: broker.now(),
    });

    await broker.restart();
    expect(broker.service.getSubject(worker.workerId)?.decisionGate?.state).toBe("decision-gate");
    expect(broker.service.getSubject(worker.workerId)?.lifecycle).toBe("waiting");

    const answer = workerEvent(worker, version, 2, {
      kind: "CHECKPOINT",
      summary: "taking expand-and-contract",
      checkpointCorrelationId: "gate:one",
    });
    expect(await submit(broker.service, owner, token, answer)).toMatchObject({ code: "accepted" });
    expect(broker.service.getSubject(worker.workerId)?.decisionGate).toEqual({ state: "none" });
    expect(broker.service.listCheckpoints(worker.workerId, "answered")).toHaveLength(1);

    await broker.service.resolveEvent({
      mutationId: "gate-resolve-event",
      controller: owner,
      leaseToken: token,
      eventId: decision.eventId,
      resolution: "answered",
      reason: "decision delivered to the worker",
    });
    const resumed = await broker.service.updateLifecycle({
      mutationId: "gate-resume-lifecycle",
      actor: owner,
      selector: single,
      subjectId: worker.workerId,
      controller: owner,
      leaseToken: token,
      lifecycle: "working",
      reason: "worker resumes after the decision",
    });
    expect(outcomeFor(resumed, worker.workerId).code).toBe("ALREADY_CONTROLLED");
    expect(broker.service.getSubject(worker.workerId)?.lifecycle).toBe("working");
    expect(broker.service.projectEvents({ filter: { intervention: "unresolved" } }).events)
      .toHaveLength(0);
  });

  it("keeps the active decision gate when an older gate is answered", async () => {
    const broker = await IntegrationBroker.open(NOISY);
    const owner = controller("two-gates");
    const worker = await registerWorker(broker.service, { controller: owner });
    const token = worker.token!;
    const version = worker.version!;

    await broker.service.requestCheckpoint({
      mutationId: "gate-a",
      controller: owner,
      leaseToken: token,
      correlationId: "gate:a",
      workerId: worker.workerId,
      mode: "decision-gate",
    });
    await broker.service.requestCheckpoint({
      mutationId: "gate-b",
      controller: owner,
      leaseToken: token,
      correlationId: "gate:b",
      workerId: worker.workerId,
      mode: "decision-gate",
    });
    expect(broker.service.getSubject(worker.workerId)?.decisionGate?.correlationId).toBe("gate:b");

    await submit(broker.service, owner, token, workerEvent(worker, version, 1, {
      kind: "CHECKPOINT",
      summary: "answering the first gate only",
      checkpointCorrelationId: "gate:a",
    }));

    expect(broker.service.getSubject(worker.workerId)?.decisionGate).toMatchObject({
      state: "decision-gate",
      correlationId: "gate:b",
    });
    expect(broker.service.listCheckpoints(worker.workerId, "pending")
      .map(({ correlationId }) => correlationId)).toEqual(["gate:b"]);
  });
});

describe("worker coordination: bounded and adversarial event streams", () => {
  it("deduplicates by event id and rejects a reused id carrying a different payload", async () => {
    const broker = await IntegrationBroker.open(NOISY);
    const owner = controller("dedup");
    const worker = await registerWorker(broker.service, { controller: owner });
    const token = worker.token!;
    const version = worker.version!;

    const original = workerEvent(worker, version, 1, { kind: "RISK", summary: "risk one" });
    const first = await submit(broker.service, owner, token, original, "dedup:first");
    expect(first.code).toBe("accepted");

    // Same mutation id: receipt replay returns the original ack verbatim.
    expect(await submit(broker.service, owner, token, original, "dedup:first")).toEqual(first);
    // New mutation id, byte-identical event: recognised as a duplicate delivery.
    expect(await submit(broker.service, owner, token, original, "dedup:retry")).toMatchObject({
      code: "duplicate",
      eventId: original.eventId,
      sequence: 1,
    });
    // Same id, different payload: refused outright.
    expect(await submit(
      broker.service,
      owner,
      token,
      { ...original, summary: "risk one, rewritten" },
      "dedup:collision",
    )).toMatchObject({ code: "rejected", errorCode: "EVENT_ID_COLLISION" });

    expect(broker.service.projectEvents({ filter: { kinds: ["RISK"] } }).events).toHaveLength(1);
    await broker.restart();
    expect(await submit(broker.service, owner, token, original, "dedup:after-restart"))
      .toMatchObject({ code: "duplicate" });
  });

  it("reports sequence gaps and refuses stale non-progress sequences", async () => {
    const broker = await IntegrationBroker.open(NOISY);
    const owner = controller("sequences");
    const worker = await registerWorker(broker.service, { controller: owner });
    const token = worker.token!;
    const version = worker.version!;

    expect(await submit(broker.service, owner, token, workerEvent(worker, version, 1)))
      .toMatchObject({ code: "accepted", sequence: 1 });

    const jumped = await submit(broker.service, owner, token, workerEvent(worker, version, 5));
    expect(jumped).toMatchObject({
      code: "accepted",
      sequence: 5,
      expectedSequence: 2,
      sequenceGap: { expected: 2, received: 5 },
    });

    // Late progress is superseded rather than rejected; late pinned kinds are refused.
    expect(await submit(broker.service, owner, token, workerEvent(worker, version, 3)))
      .toMatchObject({ code: "superseded", sequence: 3, expectedSequence: 6 });
    expect(await submit(broker.service, owner, token, workerEvent(worker, version, 3, {
      kind: "EXCEPTION",
      severity: "error",
      interventionRequired: true,
      summary: "late failure report",
      continuation: "blocked",
    }))).toMatchObject({
      code: "rejected",
      errorCode: "SEQUENCE_OUT_OF_ORDER",
      sequence: 3,
      expectedSequence: 6,
    });

    await broker.restart();
    expect(await submit(broker.service, owner, token, workerEvent(worker, version, 7)))
      .toMatchObject({ code: "accepted", sequenceGap: { expected: 6, received: 7 } });
  });

  it("rejects events that do not match the worker identity or the current lease", async () => {
    const broker = await IntegrationBroker.open({ ...NOISY, leaseDurationMs: 120_000 });
    const owner = controller("identity");
    const worker = await registerWorker(broker.service, {
      controller: owner,
      waveId: "wave-identity",
    });
    const token = worker.token!;
    const version = worker.version!;

    expect(await submit(broker.service, owner, token, workerEvent(worker, version, 1, {
      taskId: "task:not-this-worker",
    }))).toMatchObject({ code: "rejected", errorCode: "TASK_IDENTITY_MISMATCH" });
    expect(await submit(broker.service, owner, token, workerEvent(worker, version, 1, {
      waveId: "wave-somewhere-else",
    }))).toMatchObject({ code: "rejected", errorCode: "TASK_IDENTITY_MISMATCH" });
    expect(await submit(broker.service, owner, token, workerEvent(worker, version + 1, 1)))
      .toMatchObject({ code: "rejected", errorCode: "OWNERSHIP_LOST" });
    expect(await submit(broker.service, owner, "not-the-lease-token", workerEvent(worker, version, 1)))
      .toMatchObject({ code: "rejected", errorCode: "LEASE_TOKEN_INVALID" });
    expect(await submit(broker.service, owner, token, {
      ...workerEvent(worker, version, 1),
      summary: "x".repeat(2_048),
    })).toMatchObject({ code: "rejected", errorCode: "FIELD_LIMIT_EXCEEDED" });
    expect(await submit(broker.service, owner, token, {
      ...workerEvent(worker, version, 1),
      structuredFacts: { blob: "x".repeat(20_000) },
    })).toMatchObject({ code: "rejected", errorCode: "PAYLOAD_LIMIT_EXCEEDED" });
    const orphanEvent = workerEvent(
      { workerId: randomUUID(), taskId: "task:never-registered", waveId: undefined },
      version,
      1,
    );
    expect(await submit(broker.service, owner, token, orphanEvent))
      .toMatchObject({ code: "rejected", errorCode: "SUBJECT_NOT_FOUND" });

    expect(broker.service.projectEvents().events).toHaveLength(0);
    expect(await submit(broker.service, owner, token, workerEvent(worker, version, 1)))
      .toMatchObject({ code: "accepted" });
  });

  it("rate limits one noisy worker without starving its siblings", async () => {
    const broker = await IntegrationBroker.open({
      eventRateLimit: 3,
      eventRateWindowMs: 60_000,
      maxQueuedEventsPerWorker: 512,
      leaseDurationMs: 600_000,
    });
    const owner = controller("noisy");
    const noisy = await registerWorker(broker.service, { controller: owner, waveId: "wave-noise" });
    const quiet = await registerWorker(broker.service, { controller: owner, waveId: "wave-noise" });

    for (const sequence of [1, 2, 3]) {
      expect(await submit(broker.service, owner, noisy.token!, workerEvent(noisy, noisy.version!, sequence)))
        .toMatchObject({ code: "accepted" });
    }
    const throttled = await submit(
      broker.service,
      owner,
      noisy.token!,
      workerEvent(noisy, noisy.version!, 4),
    );
    expect(throttled).toMatchObject({ code: "rejected", errorCode: "RATE_LIMITED" });
    expect(throttled.message).toContain("3 per 60000ms");

    expect(await submit(broker.service, owner, quiet.token!, workerEvent(quiet, quiet.version!, 1)))
      .toMatchObject({ code: "accepted" });

    broker.advance(60_001);
    expect(await submit(broker.service, owner, noisy.token!, workerEvent(noisy, noisy.version!, 4)))
      .toMatchObject({ code: "accepted", sequence: 4 });
  });

  it("evicts unpinned events at the queue limit and refuses once every slot is pinned", async () => {
    const broker = await IntegrationBroker.open({
      eventRateLimit: 500,
      maxQueuedEventsPerWorker: 3,
    });
    const owner = controller("bounded-queue");
    const worker = await registerWorker(broker.service, { controller: owner });
    const token = worker.token!;
    const version = worker.version!;

    const risk = workerEvent(worker, version, 1, { kind: "RISK", summary: "early risk" });
    const failure = (sequence: number) => workerEvent(worker, version, sequence, {
      kind: "EXCEPTION",
      severity: "error",
      interventionRequired: true,
      summary: `failure ${sequence}`,
      continuation: "blocked",
    });
    await submit(broker.service, owner, token, risk);
    await submit(broker.service, owner, token, failure(2));
    await submit(broker.service, owner, token, failure(3));
    expect(broker.service.projectEvents().events).toHaveLength(3);

    const checkpoint = workerEvent(worker, version, 4, {
      kind: "CHECKPOINT",
      summary: "status roll-up",
    });
    expect(await submit(broker.service, owner, token, checkpoint))
      .toMatchObject({ code: "accepted" });
    const active = broker.service.projectEvents().events;
    expect(active.map(({ summary }) => summary)).toEqual([
      "failure 2",
      "failure 3",
      "status roll-up",
    ]);
    const evicted = broker.service.projectEvents({ filter: { intervention: "any" } })
      .events.find((event) => event.eventId === risk.eventId)!;
    expect(evicted.state).toBe("closed");
    expect(evicted.resolvedBy?.controllerId).toBe("cyberdeck-broker");

    // Once every active slot is pinned the queue refuses new work instead of dropping evidence.
    expect(await submit(broker.service, owner, token, failure(5)))
      .toMatchObject({ code: "accepted" });
    expect(await submit(broker.service, owner, token, failure(6))).toMatchObject({
      code: "rejected",
      errorCode: "QUEUE_LIMIT_EXCEEDED",
    });
    expect(broker.service.projectEvents({ filter: { intervention: "unresolved" } }).events)
      .toHaveLength(3);

    // Draining one pinned event makes room again.
    const oldestPinned = broker.service.projectEvents({ filter: { intervention: "unresolved" } })
      .events[0]!;
    await broker.service.resolveEvent({
      mutationId: "drain-oldest-pinned",
      controller: owner,
      leaseToken: token,
      eventId: oldestPinned.eventId,
      resolution: "closed",
      reason: "controller handled the failure",
    });
    expect(await submit(broker.service, owner, token, failure(7)))
      .toMatchObject({ code: "accepted" });
  });

  it("pages a high-volume event stream through a bounded cursor projection", async () => {
    const broker = await IntegrationBroker.open({
      eventRateLimit: 500,
      maxQueuedEventsPerWorker: 512,
      maxProjectionPageSize: 10,
    });
    const owner = controller("projection");
    const worker = await registerWorker(broker.service, { controller: owner, waveId: "wave-volume" });
    const token = worker.token!;
    const version = worker.version!;

    const submitted: string[] = [];
    for (let sequence = 1; sequence <= 40; sequence += 1) {
      const event = workerEvent(worker, version, sequence, {
        kind: "RISK",
        summary: `risk ${sequence}`,
      });
      expect(await submit(broker.service, owner, token, event)).toMatchObject({ code: "accepted" });
      submitted.push(event.eventId);
    }

    expect(broker.service.projectEvents({ limit: 1_000 }).events).toHaveLength(10);
    expect(broker.service.projectEvents({ limit: 0 }).events).toHaveLength(1);

    const pages: number[] = [];
    const seen: string[] = [];
    let cursor = 0;
    let hasMore = true;
    while (hasMore) {
      const page = broker.service.projectEvents({ cursor, limit: 25 });
      pages.push(page.events.length);
      seen.push(...page.events.map(({ eventId }) => eventId));
      expect(page.nextCursor).toBeGreaterThan(cursor);
      cursor = page.nextCursor;
      hasMore = page.hasMore;
    }
    expect(pages).toEqual([10, 10, 10, 10]);
    expect(seen).toEqual(submitted);
    expect(new Set(seen).size).toBe(40);

    // The exhausted cursor is resumable: only newly stored events come back.
    expect(broker.service.projectEvents({ cursor }).events).toHaveLength(0);
    const later = workerEvent(worker, version, 41, { kind: "RISK", summary: "risk 41" });
    await submit(broker.service, owner, token, later);
    expect(broker.service.projectEvents({ cursor }).events.map(({ eventId }) => eventId))
      .toEqual([later.eventId]);

    await broker.restart();
    expect(broker.service.projectEvents({ cursor: 0, limit: 10 }).events
      .map(({ eventId }) => eventId)).toEqual(submitted.slice(0, 10));
  });
});
