import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkerCoordinationRuntime } from "../../src/persistence/worker-coordination-runtime.js";
import type { ControllerIdentity } from "../../src/domain/worker-coordination.js";
import {
  BROKER_ACTOR,
  IntegrationBroker,
  cleanupBrokers,
  controller,
  outcomeCodes,
  outcomeFor,
  registerWorker,
  submit,
  tokenFor,
  workerEvent,
} from "./worker-coordination-harness.js";

afterEach(cleanupBrokers);

describe("worker coordination: controller handoff and death", () => {
  it("persists a successful adoption batch as one transaction", async () => {
    const broker = await IntegrationBroker.open();
    const adopter = controller("batch-success");
    const first = await registerWorker(broker.service, { waveId: "wave-batch-success" });
    const second = await registerWorker(broker.service, { waveId: "wave-batch-success" });
    const before = (await readFile(broker.store.path, "utf8")).trim().split("\n").length;

    const result = await broker.service.adoptBatch({
      mutationId: "batch-success",
      actor: adopter,
      newController: adopter,
      members: [
        { subjectId: first.workerId, mode: "adopt" },
        { subjectId: second.workerId, mode: "adopt" },
      ],
      reason: "recover whole wave",
    });

    expect(result.committed).toBe(true);
    expect(result.outcomes.map((outcome) => outcome.code)).toEqual(["ACQUIRED", "ACQUIRED"]);
    const lines = (await readFile(broker.store.path, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(before + 1);
    expect(JSON.parse(lines.at(-1)!).subjects.map((subject: { subjectId: string }) => subject.subjectId))
      .toEqual([first.workerId, second.workerId]);
  });

  it("replays a committed adoption batch after restart without another append", async () => {
    const broker = await IntegrationBroker.open();
    const adopter = controller("batch-restart");
    const first = await registerWorker(broker.service, { waveId: "wave-batch-restart" });
    const second = await registerWorker(broker.service, { waveId: "wave-batch-restart" });
    const input = {
      mutationId: "batch-restart",
      actor: adopter,
      newController: adopter,
      members: [
        { subjectId: first.workerId, mode: "adopt" as const },
        { subjectId: second.workerId, mode: "adopt" as const },
      ],
      reason: "durable batch",
    };
    const committed = await broker.service.adoptBatch(input);
    const persisted = await readFile(broker.store.path, "utf8");

    await broker.restart();
    expect(broker.service.getSubject(first.workerId)?.lease.controller).toEqual(adopter);
    expect(broker.service.getSubject(second.workerId)?.lease.controller).toEqual(adopter);
    await expect(broker.service.adoptBatch(input)).resolves.toEqual({
      ...committed,
      idempotentReplay: true,
    });
    expect(await readFile(broker.store.path, "utf8")).toBe(persisted);
  });

  it("hands a live wave to a successor and fences the retiring controller across a restart", async () => {
    const broker = await IntegrationBroker.open({ leaseDurationMs: 120_000 });
    const retiring = controller("wave-retiring");
    const successor = controller("wave-successor");
    const workers = [];
    for (let index = 0; index < 3; index += 1) {
      workers.push(await registerWorker(broker.service, {
        controller: retiring,
        waveId: "wave-handoff",
        taskId: `task:handoff:${index}`,
      }));
    }
    const before = workers.map((worker) => broker.service.getSubject(worker.workerId)!);
    for (const worker of workers) {
      await submit(broker.service, retiring, worker.token!, workerEvent(worker, worker.version!, 1));
    }

    const staleTokens = Object.fromEntries(workers.map((worker) => [worker.workerId, worker.token!]));
    const handoff = await broker.service.transfer({
      mutationId: "wave-handoff",
      actor: retiring,
      selector: { scope: "group", waveId: "wave-handoff" },
      controller: retiring,
      leaseTokens: staleTokens,
      newController: successor,
      reason: "graceful controller handoff",
    });
    expect([...outcomeCodes(handoff).values()]).toEqual(["TRANSFERRED", "TRANSFERRED", "TRANSFERRED"]);

    for (const [index, worker] of workers.entries()) {
      const after = broker.service.getSubject(worker.workerId)!;
      expect(after.origin).toEqual(before[index]!.origin);
      expect(after.resources).toEqual(before[index]!.resources);
      expect(after.lifecycle).toBe(before[index]!.lifecycle);
      expect(after.lease.controller).toEqual(successor);
      expect(after.lease.version).toBe(2);
    }

    await broker.restart();
    expect(broker.service.projectEvents().events).toHaveLength(3);

    const staleRenew = await broker.service.renew({
      mutationId: "stale-wave-renew",
      actor: retiring,
      selector: { scope: "group", waveId: "wave-handoff" },
      controller: retiring,
      leaseTokens: staleTokens,
      reason: "retired controller process returned after restart",
    });
    expect([...outcomeCodes(staleRenew).values()]).toEqual([
      "OWNERSHIP_LOST",
      "OWNERSHIP_LOST",
      "OWNERSHIP_LOST",
    ]);
    expect(outcomeFor(staleRenew, workers[0]!.workerId).currentController).toEqual(successor);

    const staleAcquire = await broker.service.acquire({
      mutationId: "stale-wave-acquire",
      actor: retiring,
      selector: { scope: "group", waveId: "wave-handoff" },
      controller: retiring,
      reason: "retired controller attempts silent reacquisition",
    });
    expect([...outcomeCodes(staleAcquire).values()]).toEqual([
      "LEASE_CONFLICT",
      "LEASE_CONFLICT",
      "LEASE_CONFLICT",
    ]);
    for (const worker of workers) {
      const outcome = outcomeFor(staleAcquire, worker.workerId);
      expect(outcome.currentController).toEqual(successor);
      expect(outcome.leaseToken).toBeUndefined();
      expect(broker.service.getSubject(worker.workerId)?.lease.controller).toEqual(successor);
    }

    const successorRenew = await broker.service.renew({
      mutationId: "successor-heartbeat",
      actor: successor,
      selector: { scope: "group", waveId: "wave-handoff" },
      controller: successor,
      leaseTokens: Object.fromEntries(
        workers.map((worker) => [worker.workerId, tokenFor(handoff, worker.workerId)]),
      ),
      reason: "successor heartbeat clears the contest",
    });
    expect([...outcomeCodes(successorRenew).values()]).toEqual([
      "ALREADY_CONTROLLED",
      "ALREADY_CONTROLLED",
      "ALREADY_CONTROLLED",
    ]);
    for (const worker of workers) {
      const lease = broker.service.getSubject(worker.workerId)!.lease;
      expect(lease.state).toBe("active");
      expect(lease.contest).toBeUndefined();
      expect(lease.version).toBe(2);
    }
  });

  it("holds the lease through the grace window and only then orphans for adoption", async () => {
    const broker = await IntegrationBroker.open({ leaseDurationMs: 120_000, gracePeriodMs: 10_000 });
    const dying = controller("dying");
    const rescuer = controller("rescuer");
    const first = await registerWorker(broker.service, { controller: dying, waveId: "wave-death" });
    const second = await registerWorker(broker.service, { controller: dying, waveId: "wave-death" });

    await broker.service.observeControllerLiveness({
      mutationId: "observe-abrupt-death",
      actor: BROKER_ACTOR,
      controller: dying,
      state: "disconnected",
      reason: "controller transport closed without release",
    });

    broker.advance(9_000);
    const premature = await broker.service.adopt({
      mutationId: "adopt-inside-grace",
      actor: rescuer,
      selector: { scope: "inactive-controller", controllerId: dying.controllerId },
      newController: rescuer,
      reason: "adoption attempt before grace elapsed",
    });
    expect(premature.outcomes).toEqual([]);
    expect(broker.service.getSubject(first.workerId)?.lease.state).toBe("active");
    expect(broker.service.getSubject(first.workerId)?.lease.controller).toEqual(dying);

    broker.advance(1_001);
    const adopted = await broker.service.adopt({
      mutationId: "adopt-after-grace",
      actor: rescuer,
      selector: { scope: "inactive-controller", controllerId: dying.controllerId },
      newController: rescuer,
      reason: "controller died; recover the wave",
    });
    expect(outcomeCodes(adopted)).toEqual(new Map([
      [first.workerId, "ACQUIRED"],
      [second.workerId, "ACQUIRED"],
    ]));
    for (const worker of [first, second]) {
      const outcome = outcomeFor(adopted, worker.workerId);
      expect(outcome.currentController).toEqual(rescuer);
      expect(outcome.leaseVersion).toBe(2);
      expect(broker.service.getSubject(worker.workerId)?.lifecycle).toBe("working");
    }

    const fenced = await broker.service.renew({
      mutationId: "dead-controller-returns",
      actor: dying,
      selector: { scope: "group", waveId: "wave-death" },
      controller: dying,
      leaseTokens: {
        [first.workerId]: first.token!,
        [second.workerId]: second.token!,
      },
      reason: "dead controller process came back",
    });
    expect([...outcomeCodes(fenced).values()]).toEqual(["OWNERSHIP_LOST", "OWNERSHIP_LOST"]);

    const rescuerRenew = await broker.service.renew({
      mutationId: "rescuer-heartbeat",
      actor: rescuer,
      selector: { scope: "single", subjectId: first.workerId },
      controller: rescuer,
      leaseToken: tokenFor(adopted, first.workerId),
      reason: "adopter heartbeat",
    });
    expect(outcomeFor(rescuerRenew, first.workerId).code).toBe("ALREADY_CONTROLLED");
  });

  it("sweeps a dead controller to orphaned, keeps the audit trail, and adopts after a restart", async () => {
    const broker = await IntegrationBroker.open({ leaseDurationMs: 20_000, gracePeriodMs: 5_000 });
    const owner = controller("swept");
    const worker = await registerWorker(broker.service, { controller: owner });

    await broker.service.observeControllerLiveness({
      mutationId: "observe-sweep-target",
      actor: BROKER_ACTOR,
      controller: owner,
      state: "disconnected",
      reason: "heartbeat missed",
    });
    broker.advance(5_001);
    const swept = await broker.service.expireLeases({
      mutationId: "sweep",
      reason: "missed heartbeat past grace",
    });
    expect(outcomeFor(swept, worker.workerId).code).toBe("ORPHANED");

    const expiryAudits = broker.service
      .listAudits(worker.workerId)
      .filter((audit) => audit.operation === "expire");
    expect(expiryAudits.map((audit) => audit.newLeaseState)).toEqual(["expired", "orphaned"]);
    expect(expiryAudits.map((audit) => audit.outcome)).toEqual(["LEASE_EXPIRED", "ORPHANED"]);
    expect(expiryAudits[0]?.priorController).toEqual(owner);

    await broker.restart();
    const restored = broker.service.getSubject(worker.workerId)!;
    expect(restored.lease.state).toBe("orphaned");
    expect(restored.lease.tokenHash).toBeUndefined();
    expect(broker.service.listAudits(worker.workerId).filter(
      (audit) => audit.operation === "expire",
    )).toHaveLength(2);

    const adopter = controller("post-restart-adopter");
    const adopted = await broker.service.adopt({
      mutationId: "adopt-post-restart",
      actor: adopter,
      selector: { scope: "single", subjectId: worker.workerId },
      newController: adopter,
      reason: "recover orphan after broker restart",
    });
    expect(outcomeFor(adopted, worker.workerId)).toMatchObject({
      code: "ACQUIRED",
      currentController: adopter,
      leaseVersion: 2,
    });
    expect(broker.service.getSubject(worker.workerId)?.origin.creatorControllerId)
      .toBe(worker.result.outcomes[0]?.currentController?.controllerId);
  });

  it("adopts a silently expired controller by inactive-controller without taking a live one", async () => {
    const broker = await IntegrationBroker.open({ leaseDurationMs: 10_000, gracePeriodMs: 5_000 });
    const vanished = controller("vanished");
    const live = controller("live");
    const rescuer = controller("ttl-rescuer");
    const worker = await registerWorker(broker.service, { controller: vanished });

    broker.advance(10_001);
    const swept = await broker.service.expireLeases({
      mutationId: "ttl-sweep",
      reason: "lease ttl elapsed with no liveness signal",
    });
    expect(outcomeFor(swept, worker.workerId).code).toBe("ORPHANED");
    const liveWorker = await registerWorker(broker.service, { controller: live });

    const byController = await broker.service.adopt({
      mutationId: "adopt-by-inactive-controller",
      actor: rescuer,
      selector: { scope: "inactive-controller", controllerId: vanished.controllerId },
      newController: rescuer,
      reason: "recover ttl-expired worker",
    });
    expect(outcomeFor(byController, worker.workerId)).toMatchObject({
      code: "ACQUIRED",
      currentController: rescuer,
    });

    const liveAttempt = await broker.service.adopt({
      mutationId: "adopt-live-by-inactive-controller",
      actor: rescuer,
      selector: { scope: "inactive-controller", controllerId: live.controllerId },
      newController: rescuer,
      reason: "must not take controller observed live",
    });
    expect(liveAttempt.outcomes).toEqual([]);
    expect(broker.service.getSubject(liveWorker.workerId)?.lease.controller).toEqual(live);
  });
});

describe("worker coordination: contention and partial recovery", () => {
  it("elects exactly one winner among concurrent takeovers and tells losers who holds the lease", async () => {
    const broker = await IntegrationBroker.open({ leaseDurationMs: 60_000 });
    const worker = await registerWorker(broker.service);
    const contenders = ["alpha", "bravo", "charlie", "delta"].map(controller);

    const races = await Promise.all(contenders.map((contender) => broker.service.adopt({
      mutationId: `race:${contender.controllerId}`,
      actor: contender,
      selector: { scope: "single", subjectId: worker.workerId },
      newController: contender,
      reason: "simultaneous takeover",
    })));

    const outcomes = races.map((race) => outcomeFor(race, worker.workerId));
    const winners = outcomes.filter((outcome) => outcome.code === "ACQUIRED");
    const losers = outcomes.filter((outcome) => outcome.code === "LEASE_CONFLICT");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(3);

    const winner = winners[0]!;
    const holder = winner.currentController!;
    for (const loser of losers) {
      expect(loser.currentController).toEqual(holder);
      expect(loser.leaseExpiresAt).toBe(winner.leaseExpiresAt);
      expect(loser.leaseVersion).toBe(winner.leaseVersion);
      expect(loser.leaseToken).toBeUndefined();
      expect(loser.message).toContain(holder.controllerId);
      expect(loser.message).toContain(winner.leaseExpiresAt!);
    }

    const winnerRenew = await broker.service.renew({
      mutationId: "winner-heartbeat",
      actor: holder,
      selector: { scope: "single", subjectId: worker.workerId },
      controller: holder,
      leaseToken: winner.leaseToken!,
      reason: "winner keeps the lease",
    });
    expect(outcomeFor(winnerRenew, worker.workerId).code).toBe("ALREADY_CONTROLLED");
    expect(broker.service.getSubject(worker.workerId)?.lease.state).toBe("active");
    expect(broker.service.getSubject(worker.workerId)?.lease.contest).toBeUndefined();

    const beaten = contenders.find((entry) => entry.controllerId !== holder.controllerId)!;
    const beatenRenew = await broker.service.renew({
      mutationId: "loser-heartbeat",
      actor: beaten,
      selector: { scope: "single", subjectId: worker.workerId },
      controller: beaten,
      leaseToken: winner.leaseToken!,
      reason: "loser tries the winner's token",
    });
    expect(outcomeFor(beatenRenew, worker.workerId).code).toBe("OWNERSHIP_LOST");

    const liveContest = await Promise.all(
      ["echo", "foxtrot"].map(controller).map((challenger) => broker.service.acquire({
        mutationId: `live-race:${challenger.controllerId}`,
        actor: challenger,
        selector: { scope: "single", subjectId: worker.workerId },
        controller: challenger,
        reason: "acquire against a live incumbent",
      })),
    );
    for (const attempt of liveContest) {
      expect(outcomeFor(attempt, worker.workerId)).toMatchObject({
        code: "LEASE_CONFLICT",
        currentController: holder,
      });
    }
    expect(broker.service.getSubject(worker.workerId)?.lease.version).toBe(winner.leaseVersion);
  });

  it("adopts the eligible subset of a wave and reports ambiguous members without taking authority", async () => {
    const broker = await IntegrationBroker.open({ leaseDurationMs: 120_000, gracePeriodMs: 5_000 });
    const incumbent = controller("wave-incumbent");
    const dead = controller("wave-dead");
    const rescuer = controller("wave-rescuer");

    const live = await registerWorker(broker.service, { controller: incumbent, waveId: "wave-partial" });
    const orphanA = await registerWorker(broker.service, { waveId: "wave-partial" });
    const orphanB = await registerWorker(broker.service, { waveId: "wave-partial" });
    const finished = await registerWorker(broker.service, {
      waveId: "wave-partial",
      lifecycle: "done",
    });
    const abandoned = await registerWorker(broker.service, {
      controller: dead,
      waveId: "wave-partial",
    });

    await broker.service.observeControllerLiveness({
      mutationId: "wave-dead-observed",
      actor: BROKER_ACTOR,
      controller: dead,
      state: "disconnected",
      reason: "controller vanished mid-wave",
    });
    broker.advance(5_001);

    const recovery = await broker.service.adopt({
      mutationId: "partial-wave-recovery",
      actor: rescuer,
      selector: { scope: "group", waveId: "wave-partial" },
      newController: rescuer,
      reason: "partial wave recovery",
    });
    expect(outcomeCodes(recovery)).toEqual(new Map([
      [live.workerId, "LEASE_CONFLICT"],
      [orphanA.workerId, "ACQUIRED"],
      [orphanB.workerId, "ACQUIRED"],
      [finished.workerId, "WORKER_TERMINAL"],
      [abandoned.workerId, "ACQUIRED"],
    ]));

    // Ambiguous members keep their authority: the live incumbent's lease version, controller, and
    // token all still work, and the terminal worker was not mutated at all.
    const contested = broker.service.getSubject(live.workerId)!;
    expect(contested.lease.controller).toEqual(incumbent);
    expect(contested.lease.version).toBe(live.version);
    const incumbentRenew = await broker.service.renew({
      mutationId: "incumbent-survives-contest",
      actor: incumbent,
      selector: { scope: "single", subjectId: live.workerId },
      controller: incumbent,
      leaseToken: live.token!,
      reason: "incumbent proves it still owns the worker",
    });
    expect(outcomeFor(incumbentRenew, live.workerId).code).toBe("ALREADY_CONTROLLED");

    const terminal = broker.service.getSubject(finished.workerId)!;
    expect(terminal.lifecycle).toBe("done");
    expect(terminal.lease.state).toBe("orphaned");
    expect(terminal.lease.version).toBe(1);
    expect(terminal.lease.controller).toBeUndefined();

    expect(broker.service.listAudits().filter(
      (audit) => audit.mutationId === "partial-wave-recovery",
    )).toHaveLength(5);

    await broker.restart();
    for (const worker of [orphanA, orphanB, abandoned]) {
      expect(broker.service.getSubject(worker.workerId)?.lease.controller).toEqual(rescuer);
    }
    expect(broker.service.getSubject(live.workerId)?.lease.controller).toEqual(incumbent);
    expect(broker.service.getSubject(finished.workerId)?.lifecycle).toBe("done");
  });
});

describe("worker coordination: idempotency and stale authority", () => {
  it("replays every lease mutation identically after a broker restart", async () => {
    const broker = await IntegrationBroker.open({ leaseDurationMs: 30_000, gracePeriodMs: 5_000 });
    const first = controller("replay-first");
    const second = controller("replay-second");

    const registration = await registerWorker(broker.service, {
      controller: first,
      mutationId: "replay:register",
    });
    const workerId = registration.workerId;
    const single = { scope: "single" as const, subjectId: workerId };

    const renewInput = {
      mutationId: "replay:renew",
      actor: first,
      selector: single,
      controller: first,
      leaseToken: registration.token!,
      reason: "heartbeat",
    };
    const renewed = await broker.service.renew(renewInput);

    const lifecycleInput = {
      mutationId: "replay:lifecycle",
      actor: first,
      selector: single,
      subjectId: workerId,
      controller: first,
      leaseToken: registration.token!,
      lifecycle: "waiting" as const,
      reason: "worker is waiting on input",
    };
    const lifecycle = await broker.service.updateLifecycle(lifecycleInput);

    const transferInput = {
      mutationId: "replay:transfer",
      actor: first,
      selector: single,
      controller: first,
      leaseToken: registration.token!,
      newController: second,
      reason: "handoff",
    };
    const transferred = await broker.service.transfer(transferInput);

    const releaseInput = {
      mutationId: "replay:release",
      actor: second,
      selector: single,
      controller: second,
      leaseToken: tokenFor(transferred, workerId),
      reason: "successor releases",
    };
    const released = await broker.service.release(releaseInput);

    const acquireInput = {
      mutationId: "replay:acquire",
      actor: first,
      selector: single,
      controller: first,
      reason: "acquire released worker",
    };
    const acquired = await broker.service.acquire(acquireInput);

    const livenessInput = {
      mutationId: "replay:liveness",
      actor: BROKER_ACTOR,
      controller: first,
      state: "disconnected" as const,
      reason: "transport closed",
    };
    const liveness = await broker.service.observeControllerLiveness(livenessInput);

    broker.advance(5_001);
    const expireInput = { mutationId: "replay:expire", reason: "grace elapsed" };
    const expired = await broker.service.expireLeases(expireInput);

    const adoptInput = {
      mutationId: "replay:adopt",
      actor: second,
      selector: single,
      newController: second,
      reason: "adopt orphan",
    };
    const adopted = await broker.service.adopt(adoptInput);

    await broker.restart();

    const registrationReplay = await registerWorker(broker.service, {
      workerId,
      controller: first,
      mutationId: "replay:register",
    });
    expect(registrationReplay.result).toEqual({ ...registration.result, idempotentReplay: true });
    expect(await broker.service.renew(renewInput)).toEqual({ ...renewed, idempotentReplay: true });
    expect(await broker.service.updateLifecycle(lifecycleInput))
      .toEqual({ ...lifecycle, idempotentReplay: true });
    expect(await broker.service.transfer(transferInput))
      .toEqual({ ...transferred, idempotentReplay: true });
    expect(await broker.service.release(releaseInput))
      .toEqual({ ...released, idempotentReplay: true });
    expect(await broker.service.acquire(acquireInput))
      .toEqual({ ...acquired, idempotentReplay: true });
    expect(await broker.service.observeControllerLiveness(livenessInput))
      .toEqual({ ...liveness, idempotentReplay: true });
    expect(await broker.service.expireLeases(expireInput))
      .toEqual({ ...expired, idempotentReplay: true });
    expect(await broker.service.adopt(adoptInput)).toEqual({ ...adopted, idempotentReplay: true });

    // Replaying receipts must not advance the lease past the state the originals produced.
    const final = broker.service.getSubject(workerId)!;
    expect(final.lease.controller).toEqual(second);
    expect(final.lease.version).toBe(outcomeFor(adopted, workerId).leaseVersion);
    expect(final.lifecycle).toBe("waiting");
    expect(broker.service.listAudits(workerId).filter(
      (audit) => audit.operation === "transfer",
    )).toHaveLength(1);
  });

  it("rejects a mutation id reused for a different operation", async () => {
    const broker = await IntegrationBroker.open();
    const owner = controller("collision");
    const worker = await registerWorker(broker.service, {
      controller: owner,
      mutationId: "collision:one",
    });
    await expect(broker.service.renew({
      mutationId: "collision:one",
      actor: owner,
      selector: { scope: "single", subjectId: worker.workerId },
      controller: owner,
      leaseToken: worker.token!,
      reason: "reuse a register mutation id",
    })).rejects.toMatchObject({ code: "MUTATION_ID_COLLISION" });
  });

  it("never lets a stale controller reacquire silently on any authenticated path", async () => {
    const broker = await IntegrationBroker.open({ leaseDurationMs: 120_000 });
    const stale = controller("stale");
    const holder = controller("holder");
    const worker = await registerWorker(broker.service, { controller: stale });
    const single = { scope: "single" as const, subjectId: worker.workerId };

    await broker.service.release({
      mutationId: "stale-release",
      actor: stale,
      selector: single,
      controller: stale,
      leaseToken: worker.token!,
      reason: "clean shutdown",
    });
    const grant = await broker.service.acquire({
      mutationId: "holder-acquire",
      actor: holder,
      selector: single,
      controller: holder,
      reason: "new controller takes the released worker",
    });
    expect(outcomeFor(grant, worker.workerId).code).toBe("ACQUIRED");

    const staleRenew = await broker.service.renew({
      mutationId: "stale-renew",
      actor: stale,
      selector: single,
      controller: stale,
      leaseToken: worker.token!,
      reason: "stale heartbeat",
    });
    expect(outcomeFor(staleRenew, worker.workerId).code).toBe("OWNERSHIP_LOST");

    const staleTransfer = await broker.service.transfer({
      mutationId: "stale-transfer",
      actor: stale,
      selector: single,
      controller: stale,
      leaseToken: worker.token!,
      newController: stale,
      reason: "stale controller tries to grant itself the lease",
    });
    expect(outcomeFor(staleTransfer, worker.workerId).code).toBe("OWNERSHIP_LOST");
    expect(broker.service.getSubject(worker.workerId)?.lease.controller).toEqual(holder);

    const staleLifecycle = await broker.service.updateLifecycle({
      mutationId: "stale-lifecycle",
      actor: stale,
      selector: single,
      subjectId: worker.workerId,
      controller: stale,
      leaseToken: worker.token!,
      lifecycle: "stopped",
      reason: "stale controller tries to stop the worker",
    });
    expect(outcomeFor(staleLifecycle, worker.workerId).code).toBe("OWNERSHIP_LOST");
    expect(broker.service.getSubject(worker.workerId)?.lifecycle).toBe("working");

    await expect(submit(
      broker.service,
      stale,
      worker.token!,
      workerEvent(worker, worker.version!, 1),
    )).resolves.toMatchObject({
      code: "rejected",
      errorCode: "OWNERSHIP_LOST",
      message: expect.stringContaining(holder.controllerId),
    });

    await expect(broker.service.requestCheckpoint({
      mutationId: "stale-checkpoint",
      controller: stale,
      leaseToken: worker.token!,
      correlationId: "stale-correlation",
      workerId: worker.workerId,
    })).rejects.toMatchObject({ code: "OWNERSHIP_LOST" });

    const staleAcquire = await broker.service.acquire({
      mutationId: "stale-acquire",
      actor: stale,
      selector: single,
      controller: stale,
      reason: "stale controller races the holder",
    });
    expect(outcomeFor(staleAcquire, worker.workerId)).toMatchObject({
      code: "LEASE_CONFLICT",
      currentController: holder,
    });

    // Only an explicit grant restores authority.
    const regrant = await broker.service.transfer({
      mutationId: "explicit-regrant",
      actor: holder,
      selector: single,
      controller: holder,
      leaseToken: tokenFor(grant, worker.workerId),
      newController: stale,
      reason: "explicit handback",
    });
    expect(outcomeFor(regrant, worker.workerId).code).toBe("TRANSFERRED");
    const restored = await broker.service.renew({
      mutationId: "restored-heartbeat",
      actor: stale,
      selector: single,
      controller: stale,
      leaseToken: tokenFor(regrant, worker.workerId),
      reason: "heartbeat with the granted token",
    });
    expect(outcomeFor(restored, worker.workerId).code).toBe("ALREADY_CONTROLLED");
  });

  it("invalidates the previous token when the same controller family reacquires", async () => {
    const broker = await IntegrationBroker.open({ leaseDurationMs: 120_000 });
    const owner = controller("same-family");
    const worker = await registerWorker(broker.service, { controller: owner });
    const single = { scope: "single" as const, subjectId: worker.workerId };

    const reacquired = await broker.service.acquire({
      mutationId: "family-reacquire",
      actor: owner,
      selector: single,
      controller: owner,
      reason: "replacement process for the same stable family",
    });
    const outcome = outcomeFor(reacquired, worker.workerId);
    expect(outcome.code).toBe("ALREADY_CONTROLLED");
    expect(outcome.leaseVersion).toBe(2);
    expect(outcome.leaseToken).not.toBe(worker.token);

    const withOldToken = await broker.service.renew({
      mutationId: "old-token-heartbeat",
      actor: owner,
      selector: single,
      controller: owner,
      leaseToken: worker.token!,
      reason: "previous generation heartbeat",
    });
    expect(outcomeFor(withOldToken, worker.workerId).code).toBe("OWNERSHIP_LOST");

    const withNewToken = await broker.service.renew({
      mutationId: "new-token-heartbeat",
      actor: owner,
      selector: single,
      controller: owner,
      leaseToken: outcome.leaseToken!,
      reason: "current generation heartbeat",
    });
    expect(outcomeFor(withNewToken, worker.workerId).code).toBe("ALREADY_CONTROLLED");
  });
});

describe("worker coordination: durability", () => {
  it("keeps memory consistent when the durable append fails and recovers once it is repaired", async () => {
    const broker = await IntegrationBroker.open({ leaseDurationMs: 120_000 });
    const owner = controller("durable");
    const worker = await registerWorker(broker.service, { controller: owner });
    const logPath = broker.store.path;
    const stateDirectory = dirname(logPath);
    const saved = await readFile(logPath, "utf8");
    const before = broker.service.getSubject(worker.workerId)!;

    // Replace the state directory with a regular file so every append fails while opening.
    await rm(stateDirectory, { recursive: true, force: true });
    await writeFile(stateDirectory, "not a directory", "utf8");

    broker.advance(1_000);
    const renewInput = {
      mutationId: "renew-through-fault",
      actor: owner,
      selector: { scope: "single" as const, subjectId: worker.workerId },
      controller: owner,
      leaseToken: worker.token!,
      reason: "heartbeat while the log is unwritable",
    };
    await expect(broker.service.renew(renewInput)).rejects.toThrow();

    const during = broker.service.getSubject(worker.workerId)!;
    expect(during.lease.renewedAt).toBe(before.lease.renewedAt);
    expect(during.lease.expiresAt).toBe(before.lease.expiresAt);
    expect(during.updatedAt).toBe(before.updatedAt);

    await rm(stateDirectory, { force: true });
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await writeFile(logPath, saved, { encoding: "utf8", mode: 0o600 });

    // The failed attempt recorded no receipt, so the same mutation id is still a first attempt.
    const retried = await broker.service.renew(renewInput);
    expect(retried.idempotentReplay).toBe(false);
    expect(outcomeFor(retried, worker.workerId).code).toBe("ALREADY_CONTROLLED");

    await broker.restart();
    const durable = broker.service.getSubject(worker.workerId)!;
    expect(durable.lease.renewedAt).toBe(broker.now());
    expect(durable.lease.controller).toEqual(owner);
    expect(await broker.service.renew(renewInput)).toEqual({ ...retried, idempotentReplay: true });
  });

  it("replays lease and intervention state through the broker runtime composition boundary", async () => {
    const broker = await IntegrationBroker.open({ leaseDurationMs: 120_000 });
    const owner = controller("runtime");
    const worker = await registerWorker(broker.service, { controller: owner });
    const exception = workerEvent(worker, worker.version!, 1, {
      kind: "EXCEPTION",
      severity: "error",
      interventionRequired: true,
      summary: "worker hit an unrecoverable dependency failure",
      continuation: "blocked",
    });
    await submit(broker.service, owner, worker.token!, exception);

    const runtime = new WorkerCoordinationRuntime({
      stateDirectory: broker.directory,
      service: { now: () => broker.now(), leaseDurationMs: 120_000 },
    });
    const migration = await runtime.start();
    expect(migration).toEqual({ migrated: 0, alreadyMigrated: 0, orphaned: 0 });
    expect(runtime.migrationResult()).toEqual(migration);
    expect(runtime.service.getSubject(worker.workerId)?.lease.controller).toEqual(owner);
    expect(runtime.service.projectEvents({ filter: { intervention: "unresolved" } })
      .events.map(({ eventId }) => eventId)).toEqual([exception.eventId]);
    await expect(runtime.start()).rejects.toThrow(/already started/);

    const successor: ControllerIdentity = controller("runtime-successor");
    const handoff = await runtime.service.transfer({
      mutationId: "runtime-handoff",
      actor: owner,
      selector: { scope: "single", subjectId: worker.workerId },
      controller: owner,
      leaseToken: worker.token!,
      newController: successor,
      reason: "handoff observed through the runtime",
    });
    expect(outcomeFor(handoff, worker.workerId).code).toBe("TRANSFERRED");

    await broker.restart();
    expect(broker.service.getSubject(worker.workerId)?.lease.controller).toEqual(successor);
    expect(broker.service.projectEvents({ filter: { intervention: "unresolved" } })
      .events.map(({ eventId }) => eventId)).toEqual([exception.eventId]);
  });
});
