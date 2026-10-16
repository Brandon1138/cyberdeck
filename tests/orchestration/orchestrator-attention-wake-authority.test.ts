import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InstructionQueue } from "../../src/orchestration/instruction-queue.js";
import { admitSubmitRetry } from "../../src/orchestration/session/worker-submit-verification.js";
import type { RenderedInstruction } from "../../src/orchestration/session/worker-turn-state.js";
import { ACTOR, WORKER, NOW } from "../support/attention-harness.js";
import { schedulingHarness, cleanupSchedulingHarnesses } from "../support/attention-scheduling-harness.js";

function barrier<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
afterEach(cleanupSchedulingHarnesses);

describe("attention wake application authority and crash boundaries", () => {
  it("does not apply an asynchronous decision after cancellation", async () => {
    const entered = barrier(), release = barrier();
    const h = await schedulingHarness(async () => { entered.resolve(); await release.promise; return { outcome: "WAKE", reason: "fixture" }; });
    const arm = await h.attention.arm(h.request());
    const evaluating = h.scheduler.reconcile(arm.controllerId); await entered.promise;
    await h.attention.cancel({ actorSessionId: ACTOR, epoch: arm.epoch }); release.resolve(); await evaluating;
    expect(h.writes).toEqual([]); expect(await h.queue.list()).toEqual([]);
    expect((await h.store.get(arm.controllerId))!.status).toBe("cancelled");
  });

  it("fences a decision from an earlier scheduler generation after stop", async () => {
    const entered = barrier(), release = barrier();
    const h = await schedulingHarness(async () => { entered.resolve(); await release.promise; return { outcome: "WAKE", reason: "fixture" }; });
    const arm = await h.attention.arm(h.request()); const evaluating = h.scheduler.reconcile(arm.controllerId); await entered.promise;
    h.scheduler.stop(); release.resolve(); await evaluating;
    expect((await h.store.get(arm.controllerId))!.decision).toBeUndefined(); expect(h.writes).toEqual([]);
  });

  it("rejects stale suppression and evaluates accumulated arrivals during a decision", async () => {
    const entered = barrier(), release = barrier(); let calls = 0;
    const counts: number[] = [];
    const h = await schedulingHarness(async (input) => {
      counts.push(input.sources.workers[0]!.reports.length);
      if (calls++ === 0) { entered.resolve(); await release.promise; }
      return { outcome: "DO_NOT_WAKE", reason: "fixture" };
    });
    const arm = await h.attention.arm(h.request());
    const evaluating = h.scheduler.reconcile(arm.controllerId); await entered.promise;
    await h.report("Arrived during evaluation"); await h.attention.flush(); release.resolve(); await evaluating;
    expect(counts).toEqual([0, 1]);
    const state = (await h.store.get(arm.controllerId))!;
    expect(state.decision!.coverage[0]!.eventOrdinal).toBe(1); expect(state.coverage.consumed).toEqual([]);
  });

  it.each(["cancel", "grant", "binding", "stop", "missing"])("fences %s after atomic intent persistence and before enqueue delivery", async (change) => {
    const h = await schedulingHarness(); const arm = await h.attention.arm(h.request()); await h.drain();
    const update = h.attention.schedulingUpdate.bind(h.attention); let injected = false;
    vi.spyOn(h.attention, "schedulingUpdate").mockImplementation(async (...args) => {
      const persisted = await update(...args);
      if (!injected && persisted?.pendingIntent !== undefined) {
        injected = true;
        if (change === "cancel") await h.attention.cancel({ actorSessionId: ACTOR, epoch: arm.epoch });
        if (change === "grant") h.bindings.set(ACTOR, { ...h.bound, grant: { ...h.bound.grant, capabilities: ["thread.read"] } });
        if (change === "binding") h.bindings.delete(ACTOR);
        if (change === "stop") h.stopped.add(ACTOR);
        if (change === "missing") h.records.set(ACTOR, { ...h.records.get(ACTOR)!, exitCode: 1, attentionState: "interrupted" });
      }
      return persisted;
    });
    await h.complete(); await h.drain();
    expect(injected).toBe(true); expect(h.writes).toEqual([]); expect(h.registry.resume).not.toHaveBeenCalled();
    expect((await h.queue.list()).every((entry) => entry.status === (change === "missing" ? "queued" : "cancelled"))).toBe(true);
  });

  it("holds epoch serialization during the final asynchronous binding lookup", async () => {
    const h = await schedulingHarness(); const arm = await h.attention.arm(h.request()); await h.drain();
    const entered = barrier(), release = barrier(); let finalLookups = 0, pause = false;
    const lookup = h.controlOptions.bindings.findBySessionId;
    vi.spyOn(h.controlOptions.bindings, "findBySessionId").mockImplementation(async (id) => {
      if (pause && ++finalLookups === 3) { entered.resolve(); await release.promise; }
      return lookup(id);
    });
    h.beforeAdmission(async () => { pause = true; }); await h.complete(); await h.attention.flush();
    const delivery = h.scheduler.reconcile(arm.controllerId); await entered.promise;
    let cancelled = false;
    const cancellation = h.attention.cancel({ actorSessionId: ACTOR, epoch: arm.epoch }).then(() => { cancelled = true; });
    await Promise.resolve(); expect(cancelled).toBe(false); expect(h.writes).toEqual([]);
    release.resolve(); await Promise.all([delivery, cancellation]);
    expect(h.writes).toHaveLength(1); expect(cancelled).toBe(true);
    expect((await h.store.get(arm.controllerId))!.status).toBe("cancelled");
  });

  it("refuses revoked authority returned by the final binding lookup", async () => {
    const h = await schedulingHarness(); const arm = await h.attention.arm(h.request()); await h.drain();
    const lookup = h.controlOptions.bindings.findBySessionId; let pause = false, calls = 0;
    vi.spyOn(h.controlOptions.bindings, "findBySessionId").mockImplementation(async (id) => {
      if (pause && ++calls === 3) h.bindings.set(ACTOR, { ...h.bound, grant: { ...h.bound.grant, capabilities: ["thread.enqueue"] } });
      return lookup(id);
    });
    h.beforeAdmission(async () => { pause = true; }); await h.complete(); await h.drain();
    expect(h.writes).toEqual([]); expect((await h.queue.list())[0]!.status).toBe("cancelled");
    expect((await h.store.get(arm.controllerId))!.status).toBe("cancelled");
  });

  it("withdraws a stale epoch after re-arm without changing ordinary queue ownership", async () => {
    const h = await schedulingHarness(); const first = await h.attention.arm(h.request()); await h.drain();
    h.setHold("provider-modal"); await h.complete(); await h.drain();
    const old = (await h.queue.list())[0]!;
    h.emit(WORKER, { state: "working" });
    const second = await h.attention.arm(h.request({ previousEpoch: first.epoch, targets: [{ sessionId: WORKER, completionTarget: 2 }] }));
    h.setHold(undefined); await h.drain(); await h.queue.flush(ACTOR);
    expect(second.epoch).not.toBe(first.epoch); expect((await h.queue.list()).find((entry) => entry.id === old.id)!.status).toBe("cancelled");
    expect(h.writes).toEqual([]);
  });

  it("never delivers an attention wake without an installed admission guard", async () => {
    const h = await schedulingHarness(); const arm = await h.attention.arm(h.request());
    const submit = vi.fn();
    const queue = new InstructionQueue({ get: h.registry.get, submitInstruction: submit,
      onControllerReleased: () => () => {}, onDeliveryBoundary: () => () => {}, onInstructionState: () => () => {} },
    h.controlOptions.bindings, h.instructionStore);
    const receipt = await queue.enqueueBroker({ actorSessionId: ACTOR, targetSessionId: ACTOR, message: "Attention",
      messageId: randomUUID(), submissionKind: "wake", wake: { controllerId: arm.controllerId, attentionEpoch: arm.epoch, cursor: 0, notificationIds: [] } });
    expect(receipt).toMatchObject({ status: "queued", holdReason: "attention-admission-unavailable" }); expect(submit).not.toHaveBeenCalled();
  });

  it("deduplicates concurrent stable broker enqueue attempts", async () => {
    const h = await schedulingHarness(); const messageId = randomUUID();
    const request = { actorSessionId: ACTOR, targetSessionId: ACTOR, message: "Legacy notice", messageId,
      submissionKind: "wake" as const, wake: { controllerId: h.controller.controllerId, cursor: 1, notificationIds: [] } };
    const receipts = await Promise.all([h.queue.enqueueBroker(request), h.queue.enqueueBroker(request), h.queue.enqueueBroker(request)]);
    expect(new Set(receipts.map((receipt) => receipt.id)).size).toBe(1); expect(await h.queue.list()).toHaveLength(1); expect(h.writes).toHaveLength(1);
  });

  it("fences a legacy wake once explicit attention owns the controller", async () => {
    const h = await schedulingHarness(); const arm = await h.attention.arm(h.request());
    const receipt = await h.queue.enqueueBroker({ actorSessionId: ACTOR, targetSessionId: ACTOR, message: "Legacy competing notice",
      messageId: randomUUID(), submissionKind: "wake", wake: { controllerId: arm.controllerId, cursor: 1, notificationIds: [] } });
    expect(receipt).toMatchObject({ status: "cancelled", holdReason: "attention-owns-wake-policy" }); expect(h.writes).toEqual([]);
  });

  it("does not retry submit verification after cancellation of a rendered wake", async () => {
    const h = await schedulingHarness(); const arm = await h.attention.arm(h.request()); await h.complete(); await h.drain();
    const instruction = (await h.queue.list())[0]!;
    const entry: RenderedInstruction = { instructionId: instruction.id, expectedTurn: 1, renderedAt: NOW, state: "rendered",
      messageHead: instruction.message.slice(0, 48), admission: (apply) => h.attention.admitWake(instruction, apply) };
    const press = vi.fn();
    const host = { epoch: () => 1, active: () => true, pending: () => true,
      observe: () => ({ activity: "awaiting-input", composer: { modalOpen: false, occupied: true, content: instruction.message } }), press };
    expect(await admitSubmitRetry(entry, host)).toBe(true); expect(press).toHaveBeenCalledTimes(1);
    await h.attention.cancel({ actorSessionId: ACTOR, epoch: arm.epoch });
    expect(await admitSubmitRetry(entry, host)).toBe(false); expect(press).toHaveBeenCalledTimes(1);
  });

  it("allows an exact page read before intent banking to discharge that same coverage", async () => {
    const h = await schedulingHarness(); const arm = await h.attention.arm(h.request()); await h.drain();
    await h.complete(); await h.attention.flush();
    const page = await h.notifications.read({ actorSessionId: ACTOR, attentionEpoch: arm.epoch });
    h.setHold("provider-modal"); await h.drain(); expect((await h.store.get(arm.controllerId))!.pendingIntent).toBeDefined();
    await h.notifications.read({ actorSessionId: ACTOR, attentionEpoch: arm.epoch, attentionReceiptId: page.attention!.receiptId }); await h.drain();
    expect((await h.store.get(arm.controllerId))!.pendingIntent).toBeUndefined(); expect(h.writes).toEqual([]);
  });
});
