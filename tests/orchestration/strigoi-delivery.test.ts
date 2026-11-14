import { SessionStore } from "../../src/persistence/session-store.js";
import { appendFile } from "node:fs/promises";
import { InstructionStore } from "../../src/persistence/instruction-store.js";
import { StrigoiAdmission } from "../../src/orchestration/strigoi-admission.js";
import { effectiveInstruction, InstructionRecordSchema } from "../../src/domain/instruction.js";
import { indexedInstructionReceipt } from "../../src/persistence/instruction-target-index.js";
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { StrigoiDelivery } from "../../src/orchestration/strigoi-delivery.js";
import { InstructionQueue } from "../../src/orchestration/instruction-queue.js";
import { WorkflowService } from "../../src/orchestration/workflow-service.js";
import { recoveryFixture, NEXT, nextIdentity } from "./strigoi-worker-recovery-fixture.js";
import { ACTOR, WORKER, cleanupAttentionHarnesses } from "../support/attention-harness.js";
import type { InstructionStateUpdate, SessionInstructionPort } from "../../src/orchestration/session/session-ports.js";

async function fixture() {
  const f = await recoveryFixture();
  let update!: (value: InstructionStateUpdate) => void;
  const effects: string[] = [];
  let beforeWrite: (() => Promise<void>) | undefined;
  let busy = false;
  const registry = { ...f.registry, onControllerReleased: () => () => {}, onDeliveryBoundary: () => () => {},
    onInstructionState: (fn: typeof update) => { update = fn; return () => {}; },
    submitInstruction: vi.fn<SessionInstructionPort["submitInstruction"]>(async (_id, message, _source, _metadata, _instruction, admit) => {
      await beforeWrite?.();
      if (busy) return { state: "queued", hold: "composer-occupied", at: f.now() };
      const write = () => { effects.push(message); return { state: "rendered" as const, expectedTurn: effects.length, at: f.now() }; };
      return admit ? admit(write) : write();
    }) };
  const queue = new InstructionQueue(registry, f.bindings, f.evidence.instructionStore, undefined, f.admission);
  const workflows = new WorkflowService(registry, f.bindings, f.evidence.workflowStore, queue, f.admission);
  const delivery = new StrigoiDelivery({ repository: f.repository, bindings: f.bindings, admission: f.admission,
    registry, instructions: queue, workflows, demand: async () => false,
    observeInstruction: async record => indexedInstructionReceipt(record, await f.transcripts.readCompletionLedger(effectiveInstruction(record).targetSessionId)),
    authorizeWorker: async (_actor, target, apply) => { if (target !== WORKER) throw new Error("unexpected worker"); return apply(); } });
  queue.start();
  const finish = async () => { const s = await f.repository.read(); await f.mutate({ transition: { ...s.transition!, phase: "complete" } }); await f.admission.reopen(nextIdentity); await delivery.flush(); };
  const close = async () => { queue.stop(); await queue.drain(); f.liveness.dispose(); await cleanupAttentionHarnesses(); };
  return { ...f, queue, workflows, delivery, registry, effects, finish, close, setBusy: (value: boolean) => { busy = value; }, beforeWrite: (fn: () => Promise<void>) => { beforeWrite = fn; }, update: (value: InstructionStateUpdate) => update(value) };
}

it("continues cutover input once in order, preserving original identities and logical replay", async () => {
  const f = await fixture();
  try {
    const packet = await f.seal();
    const id = randomUUID();
    const first = await f.delivery.submit("first", id);
    await f.delivery.submit("second", randomUUID());
    expect(f.effects).toEqual([]);
    await f.cutover();
    expect(await f.delivery.reconcile(nextIdentity, packet)).toEqual([]);
    await f.finish();
    const receipt = (await f.queue.list()).find(r => r.id === first.id)!;
    expect(receipt).toMatchObject({ actorSessionId: ACTOR, targetSessionId: ACTOR, message: "first",
      logicalRecipient: { kind: "resident", key: "resident:strigoi" }, continuations: [expect.objectContaining({ effectiveActorSessionId: NEXT, effectiveTargetSessionId: NEXT })] });
    // Rendered head blocks subsequent work until provider consumption.
    expect(f.effects).toEqual(["first"]);
    f.update({ sessionId: NEXT, instructionId: first.id, state: "completed", at: f.now() });
    await f.queue.flush(NEXT);
    expect(f.effects).toEqual(["first", "second"]);
    expect((await f.delivery.submit("first", id)).id).toBe(first.id);
    expect((await f.queue.list()).length).toBe(2);
  } finally { await f.close(); }
});

it("continues a queued worker instruction once; completion/result races never replay it", async () => {
  const f = await fixture();
  try {
    f.setBusy(true);
    const original = await f.queue.enqueue({ actorSessionId: ACTOR, targetSessionId: WORKER, message: "worker task", messageId: randomUUID() });
    const packet = await f.seal(); await f.cutover();
    expect(await f.delivery.reconcile(nextIdentity, packet)).toEqual([]);
    f.setBusy(false); await f.finish();
    expect(f.effects).toEqual(["worker task"]);
    const done = { sessionId: WORKER, instructionId: original.id, state: "completed" as const, at: f.now() };
    f.update(done); f.update(done);
    await f.complete("the result"); await f.queue.flush(WORKER);
    expect(await f.delivery.reconcile(nextIdentity, packet)).toEqual([]);
    await f.delivery.flush();
    expect(f.effects).toEqual(["worker task"]);
    expect((await f.queue.list(WORKER))[0]).toMatchObject({ status: "completed", actorSessionId: ACTOR,
      targetSessionId: WORKER, continuations: [expect.objectContaining({ effectiveActorSessionId: NEXT, effectiveTargetSessionId: WORKER })] });
  } finally { await f.close(); }
});

it.each(["completed", "rendered"] as const)("does not retype %s records across restart/reconciliation", async status => {
  const f = await fixture();
  try {
    const now = f.now();
    const record = InstructionRecordSchema.parse({ id: randomUUID(), actorSessionId: ACTOR, targetSessionId: WORKER,
      messageId: randomUUID(), message: "already seen", status, createdAt: now, updatedAt: now, renderedAt: now });
    await f.evidence.instructionStore.put(record);
    const packet = await f.seal(); await f.cutover();
    const holds = await f.delivery.reconcile(nextIdentity, packet);
    expect(holds.map(h => h.code)).toEqual(status === "rendered" ? ["STRIGOI_INSTRUCTION_OUTCOME_UNRESOLVED"] : []);
    await f.finish(); await f.delivery.reconcile(nextIdentity, packet); await f.delivery.flush();
    expect(f.effects).toEqual([]);
    expect((await f.queue.list())[0]?.continuations).toBeUndefined();
  } finally { await f.close(); }
});

it("reconciles a lost queue completion from the native target index before continuation", async () => {
  const f = await fixture();
  try {
    f.setBusy(true);
    const record = await f.queue.enqueue({ actorSessionId: ACTOR, targetSessionId: WORKER, message: "lost receipt" });
    await f.transcripts.append({ sessionId: WORKER, kind: "instruction", source: "broker",
      data: { instructionId: record.id, instructionState: "rendered", expectedTurn: 1, renderedAt: f.now() } });
    await f.complete("completed while receipt was lost");
    const packet = await f.seal(); await f.cutover();
    expect(await f.delivery.reconcile(nextIdentity, packet)).toEqual([]);
    f.setBusy(false); await f.finish();
    expect(f.effects).toEqual([]);
    expect((await f.queue.list())[0]).toMatchObject({ status: "completed", actorSessionId: ACTOR });
  } finally { await f.close(); }
});

it("operator cancellation wins queued continuation and duplicate completion cannot resurrect it", async () => {
  const f = await fixture();
  try {
    const packet = await f.seal();
    const record = await f.delivery.submit("cancel me", randomUUID()); await f.cutover();
    const cancelled = f.queue.withdrawForOperator({ targetSessionId: ACTOR, instructionId: record.id, messageId: record.messageId,
      reason: "operator withdrew", authority: { path: "/operator/decision", sha256: "a".repeat(64) } });
    const continued = f.delivery.reconcile(nextIdentity, packet);
    expect((await cancelled).outcome).toBe("CANCELLED"); expect(await continued).toEqual([]);
    f.update({ sessionId: NEXT, instructionId: record.id, state: "completed", at: f.now() });
    await f.finish();
    expect(f.effects).toEqual([]);
    expect((await f.queue.list())[0]).toMatchObject({ status: "cancelled", withdrawal: { kind: "operator" } });
  } finally { await f.close(); }
});

it.each(["suspend", "revoke"] as const)("revalidates %s after provider preflight before any effect", async mode => {
  const f = await fixture();
  try {
    const packet = await f.seal(); await f.delivery.submit("race", randomUUID()); await f.cutover();
    await f.delivery.reconcile(nextIdentity, packet);
    f.beforeWrite(async () => {
      const s = await f.repository.read();
      await f.mutate(mode === "suspend" ? { desired: "suspended" } : { activeBinding: { ...s.activeBinding!, grant: { ...s.activeBinding!.grant, capabilities: [] } } });
    });
    await f.finish();
    expect(f.effects).toEqual([]);
    expect((await f.queue.list())[0]?.status).toBe("queued");
  } finally { await f.close(); }
});

it("keeps explicit archived targets stale and never silently addresses the resident", async () => {
  const f = await fixture();
  try {
    f.setBusy(true);
    const record = await f.queue.enqueue({ actorSessionId: ACTOR, targetSessionId: ACTOR, message: "explicit" });
    const packet = await f.seal(); await f.cutover();
    expect((await f.delivery.reconcile(nextIdentity, packet))[0]?.code).toBe("STRIGOI_STALE_TARGET");
    f.setBusy(false); await f.finish();
    expect(f.effects).toEqual([]);
    expect((await f.queue.list())[0]).toMatchObject({ id: record.id, targetSessionId: ACTOR, holdReason: "STRIGOI_STALE_TARGET" });
  } finally { await f.close(); }
});

it("reports exact session-bound workflow obligation IDs without migrating the reply", async () => {
  const f = await fixture();
  try {
    const run = await f.workflows.create({ actorSessionId: ACTOR, name: "pending reply", participantSessionIds: [WORKER] });
    const message = await f.workflows.send({ actorSessionId: WORKER, runId: run.id, targetSessionId: ACTOR, text: "need decision" });
    const packet = await f.seal(); await f.cutover();
    const holds = await f.delivery.reconcile(nextIdentity, packet);
    expect(holds).toEqual([expect.objectContaining({ code: "STRIGOI_WORKFLOW_CONTINUATION_REQUIRED", sourceIds: [run.id, message.messageId, ACTOR] })]);
    expect((await f.workflows.listAll())[0]?.participantSessionIds).not.toContain(NEXT);
    expect((await f.evidence.workflowStore.listMessages(run.id))[0]).toEqual(message);
    await f.finish(); await f.delivery.submit("unrelated routine input", randomUUID());
    expect(f.effects).toEqual(["unrelated routine input"]);
  } finally { await f.close(); }
});

it("uses live journal demand, including inputs accepted after seal, and conflicts on message reuse", async () => {
  const f = await fixture();
  try {
    const packet = await f.seal(); await f.cutover();
    expect(await f.delivery.needsAdoption(nextIdentity, packet)).toBe(false);
    const id = randomUUID(); await f.delivery.submit("pending", id);
    expect(await f.delivery.needsAdoption(nextIdentity, packet)).toBe(true);
    await expect(f.delivery.submit("different", id)).rejects.toMatchObject({ code: "STRIGOI_MESSAGE_CONFLICT" });
    const record = (await f.queue.list())[0]!;
    await f.queue.withdraw(record.targetSessionId, id);
    expect(await f.delivery.needsAdoption(nextIdentity, packet)).toBe(false);
  } finally { await f.close(); }
});

it("reconstructs from the same journal after an ambiguous native write without retyping or permitting withdrawal", async () => {
  const f = await fixture();
  let restarted: InstructionQueue | undefined;
  try {
    f.registry.submitInstruction.mockImplementationOnce(async (_id, message, _source, _metadata, _instruction, admit) =>
      admit!(async () => { f.effects.push(message); throw new Error("lost native write response"); }));
    const id = randomUUID();
    await expect(f.delivery.submit("unknown write", id)).rejects.toThrow("lost native write response");
    const record = (await f.queue.list())[0]!;
    expect(record).toMatchObject({ status: "accepted", submissionAttempt: { outcome: "unknown" } });
    f.queue.stop();
    const admission = new StrigoiAdmission(f.repository, f.bindings, f.registry);
    restarted = new InstructionQueue(f.registry, f.bindings, new InstructionStore(f.directory), undefined, admission);
    const delivery = new StrigoiDelivery({ repository: f.repository, bindings: f.bindings, registry: f.registry, admission,
      instructions: restarted, workflows: f.workflows, demand: async () => false,
      authorizeWorker: async (_actor, _target, apply) => apply(),
      observeInstruction: async r => indexedInstructionReceipt(r, await f.transcripts.readCompletionLedger(effectiveInstruction(r).targetSessionId)) });
    restarted.start(); await delivery.flush(); await delivery.submit("unknown write", id);
    expect(f.effects).toEqual(["unknown write"]);
    expect((await restarted.withdrawForOperator({ targetSessionId: ACTOR, instructionId: record.id, messageId: id,
      reason: "cannot withdraw written bytes", authority: { path: "/operator/decision", sha256: "b".repeat(64) } })).outcome).toBe("TOO_LATE");
    await f.transcripts.append({ sessionId: ACTOR, kind: "instruction", source: "broker",
      data: { instructionId: record.id, instructionState: "rendered", expectedTurn: 1, renderedAt: f.now() } });
    await f.complete("native completed", 1, ACTOR); await delivery.flush();
    expect((await restarted.list())[0]?.status).toBe("completed");
    expect(f.effects).toEqual(["unknown write"]);
  } finally { restarted?.stop(); await restarted?.drain(); await f.close(); }
});

it("keeps append-only receipts and all original envelope fields immutable in the journal", async () => {
  const f = await fixture();
  try {
    const packet = await f.seal(); const original = await f.delivery.submit("immutable original", randomUUID()); await f.cutover();
    await f.delivery.reconcile(nextIdentity, packet);
    const record = (await f.queue.list())[0]!;
    for (const mutation of [{ actorSessionId: NEXT }, { targetSessionId: NEXT }, { message: "rewritten" }, { continuations: [] }]) {
      await expect(f.evidence.instructionStore.put({ ...record, ...mutation })).rejects.toThrow();
    }
    expect((await new InstructionStore(f.directory).list(NEXT))[0]).toMatchObject({ id: original.id, actorSessionId: ACTOR, targetSessionId: ACTOR });
  } finally { await f.close(); }
});

it("reconciliation honors durable suspension before minting a receipt or delivering", async () => {
  const f = await fixture();
  try {
    const packet = await f.seal(); await f.delivery.submit("suspended", randomUUID()); await f.cutover();
    await f.mutate({ desired: "suspended" });
    await expect(f.delivery.reconcile(nextIdentity, packet)).rejects.toMatchObject({ code: "STRIGOI_STALE_RECOVERY" });
    await f.delivery.flush();
    expect(f.effects).toEqual([]); expect((await f.queue.list())[0]?.continuations).toBeUndefined();
  } finally { await f.close(); }
});


it("retains an archived queued workflow wake without blocking eligible same-target FIFO", async () => {
  const f = await fixture();
  try {
    f.setBusy(true);
    const run = await f.workflows.create({ actorSessionId: ACTOR, name: "old workflow wake", participantSessionIds: [WORKER] });
    const message = await f.workflows.send({ actorSessionId: ACTOR, runId: run.id, targetSessionId: WORKER, text: "old wake", wake: true });
    const original = (await f.queue.list(WORKER))[0]!;
    expect(original).toMatchObject({ status: "queued", workflowRunId: run.id, messageId: message.messageId });
    const packet = await f.seal(); await f.cutover();
    expect(await f.delivery.reconcile(nextIdentity, packet)).toContainEqual(expect.objectContaining({
      code: "STRIGOI_WORKFLOW_CONTINUATION_REQUIRED", sourceIds: [run.id, message.messageId, original.id],
    }));
    await f.finish();
    const first = await f.queue.enqueue({ actorSessionId: NEXT, targetSessionId: WORKER, message: "routine first" });
    const second = await f.queue.enqueue({ actorSessionId: NEXT, targetSessionId: WORKER, message: "routine second" });
    expect(f.effects).toEqual([]);
    expect((await f.queue.list(WORKER)).find(r => r.id === second.id)?.holdReason).toBe("composer-occupied");
    // Each rendered instruction occupies the scripted composer until its receipt arrives.
    f.setBusy(false);
    f.registry.submitInstruction.mockImplementation(async (_id, text, _source, _meta, _instruction, admit) => {
      if (f.effects.length === 1) return { state: "queued", hold: "composer-occupied", at: f.now() };
      return admit!(async () => { f.effects.push(text); return { state: "rendered", at: f.now() }; });
    });
    await f.queue.flush(WORKER);
    expect(f.effects).toEqual(["routine first"]);
    f.registry.submitInstruction.mockImplementation(async (_id, text, _source, _meta, _instruction, admit) =>
      admit!(async () => { f.effects.push(text); return { state: "rendered", at: f.now() }; }));
    f.update({ sessionId: WORKER, instructionId: first.id, state: "completed", at: f.now() });
    await f.queue.flush(WORKER);
    expect(f.effects).toEqual(["routine first", "routine second"]);
    const held = (await f.queue.list(WORKER)).find(r => r.id === original.id)!;
    expect(held).toMatchObject({ ...original, holdReason: "STRIGOI_WORKFLOW_CONTINUATION_REQUIRED", updatedAt: expect.any(String) });
    expect(held.continuations).toBeUndefined();
    expect(await f.evidence.workflowStore.listMessages(run.id)).toEqual([message]);
  } finally { await f.close(); }
});

it.each(["primary", "peer"] as const)("delivers to an established ordinary %s despite resident-only corruption", async kind => {
  const f = await fixture();
  try {
    const { resident: _resident, ...ordinary } = f.bound;
    await f.bindings.put({ ...ordinary, key: "fleet", kind: "primary", sessionId: WORKER,
      grant: { ...ordinary.grant, subjectSessionId: WORKER } });
    await f.bindings.put({ ...ordinary, key: kind === "peer" ? `fleet:peer:${NEXT}` : "workspace:/repo", kind,
      sessionId: NEXT, grant: { ...ordinary.grant, subjectSessionId: NEXT } });
    f.records.set(WORKER, { ...f.records.get(WORKER)!, kind: "orchestrator" });
    await appendFile(f.repository.path, "corrupt resident record\n");
    // Production startup fences retention and source capture when resident evidence is corrupt.
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await f.evidence.startup(f.transcripts, new SessionStore(f.directory))).toMatchObject({ skipDestructiveRetention: true });
    diagnostic.mockRestore();
    await expect(f.delivery.key(NEXT)).resolves.toBe(NEXT);
    const at = f.now();
    const direct = InstructionRecordSchema.parse({ id: randomUUID(), actorSessionId: WORKER, targetSessionId: NEXT,
      messageId: randomUUID(), message: "ordinary", status: "accepted", createdAt: at, updatedAt: at });
    await expect(f.delivery.prepare(direct, async () => {})).resolves.toBeUndefined();
    expect(await f.queue.enqueue({ actorSessionId: WORKER, targetSessionId: NEXT, message: "ordinary" })).toMatchObject({ status: "rendered" });
    expect(await f.queue.enqueue({ actorSessionId: NEXT, targetSessionId: WORKER, message: "ordinary reply" })).toMatchObject({ status: "rendered" });
    expect(f.effects).toEqual(["ordinary", "ordinary reply"]);
    for (const targetSessionId of [ACTOR, randomUUID()]) {
      await expect(f.delivery.key(targetSessionId)).rejects.toMatchObject({ code: "STRIGOI_CORRUPT_STATE" });
      await expect(f.delivery.prepare({ ...direct, targetSessionId }, async () => {})).rejects.toMatchObject({ code: "STRIGOI_CORRUPT_STATE" });
    }
    await expect(f.delivery.prepare({ ...direct, actorSessionId: ACTOR }, async () => {})).rejects.toMatchObject({ code: "STRIGOI_CORRUPT_STATE" });
    expect(f.effects).toEqual(["ordinary", "ordinary reply"]);
  } finally { await f.close(); }
});
