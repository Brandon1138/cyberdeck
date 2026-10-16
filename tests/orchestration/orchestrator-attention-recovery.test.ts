import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { orchestratorController } from "../../src/domain/orchestrator.js";
import { OrchestratorAttentionStore } from "../../src/persistence/orchestrator-attention-store.js";
import { ThreadTranscriptStore } from "../../src/persistence/thread-transcript-store.js";
import { ACTOR, WORKER, OTHER, attentionHarness, cleanupAttentionHarnesses, NOW } from "../support/attention-harness.js";

afterEach(cleanupAttentionHarnesses);

describe("attention recovery and owner replacement", () => {
  it.each([false, true])("recovers a real cancelled owner receipt even after later activity (observed=%s)", async (observed) => {
    const f = await attentionHarness(); const armed = await f.attention.arm(f.request());
    if (!observed) f.attention.stop();
    await f.transcripts.commitProviderTurns({ sessionId: ACTOR, provider: "codex", turnNumber: 1,
      turns: [{ providerTurnId: "aborted-owner", providerOccurredAt: NOW, text: "Provider turn was cancelled",
        transport: "provider-native", data: { outcome: "cancelled" } }] });
    f.records.set(ACTOR, { ...f.records.get(ACTOR)!, attentionState: "interrupted" });
    f.emit(ACTOR, { state: "interrupted", completedTurns: 1 }); await f.attention.flush();
    if (observed) expect(await f.store.get(armed.controllerId)).toMatchObject({ status: "cancelled" });
    await f.complete("Ordinary later owner activity", 2, ACTOR);
    f.records.set(ACTOR, { ...f.records.get(ACTOR)!, attentionState: "working" });
    f.attention.stop();
    const restarted = f.makeControl(new OrchestratorAttentionStore(f.directory), { transcripts: new ThreadTranscriptStore(f.directory) });
    await restarted.attention.start();
    expect(await f.store.get(armed.controllerId)).toMatchObject({ status: "cancelled", cancelReason: "Orchestrator turn cancelled after arming" });
    expect(f.registry.resume).not.toHaveBeenCalled();
  });

  it("ordinary owner completion keeps the wait armed and exact worker outcome metadata survives recovery", async () => {
    const f = await attentionHarness(); const armed = await f.attention.arm(f.request());
    await f.complete("Owner finished its arm turn", 1, ACTOR); await f.attention.flush();
    expect(await f.store.get(armed.controllerId)).toMatchObject({ status: "armed" });
    await f.transcripts.commitProviderTurns({ sessionId: WORKER, provider: "codex", turnNumber: 1,
      turns: [{ providerTurnId: "aborted-worker", providerOccurredAt: NOW, text: "Cancelled result",
        transport: "provider-native", data: { outcome: "cancelled", arbitraryProviderData: "PRIVATE" } }] });
    f.attention.stop();
    const restarted = f.makeControl(new OrchestratorAttentionStore(f.directory), { transcripts: new ThreadTranscriptStore(f.directory) });
    await restarted.attention.start();
    const page = await restarted.notifications.read({ actorSessionId: ACTOR, attentionEpoch: armed.epoch });
    expect(page.attention!.workers[0]!.completion).toMatchObject({ turn: 1, text: "Cancelled result",
      data: { outcome: "cancelled", semanticTurnId: "codex:aborted-worker", transport: "provider-native", provider: "codex" } });
    expect(page.attention!.workers[0]!.completion!.data).not.toHaveProperty("arbitraryProviderData");
  });

  it("a replacement primary discovers only epoch/status and explicitly retries CAS while the departed actor stays fenced", async () => {
    const f = await attentionHarness(); const first = await f.attention.arm(f.request());
    const page = await f.notifications.read({ actorSessionId: ACTOR, attentionEpoch: first.epoch });
    await f.attention.bindingRemoved(f.bound); f.bindings.delete(ACTOR);
    const replacement = { ...f.bound, sessionId: OTHER, grant: { ...f.bound.grant, subjectSessionId: OTHER } };
    f.bindings.set(OTHER, replacement); f.records.set(OTHER, { ...f.records.get(OTHER)!, kind: "orchestrator" });
    await f.attention.bindingChanged(replacement);
    const request = f.request({ actorSessionId: OTHER });
    const conflict = await f.attention.arm(request).catch((error: unknown) => error) as Error & { code: string };
    expect(conflict.code).toBe("ATTENTION_ALREADY_ARMED");
    expect(conflict.message).toContain(`epoch=${first.epoch} status=cancelled`);
    expect(conflict.message).not.toContain(first.statement.objective);
    const discoveredEpoch = /epoch=([a-f0-9-]{36})/.exec(conflict.message)![1];
    const next = await f.attention.arm({ ...request, previousEpoch: discoveredEpoch });
    expect(next).toMatchObject({ actorSessionId: OTHER, status: "armed" }); expect(next.epoch).not.toBe(first.epoch);
    await expect(f.attention.arm(f.request({ actorSessionId: OTHER, previousEpoch: discoveredEpoch })))
      .rejects.toMatchObject({ code: "ATTENTION_ALREADY_ARMED" });
    await expect(f.attention.cancel({ actorSessionId: OTHER, epoch: first.epoch })).rejects.toMatchObject({ code: "STALE_ATTENTION_EPOCH" });
    await expect(f.attention.acknowledge(OTHER, first.epoch, page.attention!.receiptId)).rejects.toMatchObject({ code: "STALE_ATTENTION_EPOCH" });
    await expect(f.attention.arm(f.request())).rejects.toMatchObject({ code: "ACTOR_NOT_AUTHORIZED" });
    await expect(f.attention.cancel({ actorSessionId: ACTOR, epoch: next.epoch })).rejects.toMatchObject({ code: "ACTOR_NOT_AUTHORIZED" });
    expect(await f.store.get(next.controllerId)).toMatchObject({ epoch: next.epoch, status: "armed" });
  });

  it.each(["scope", "read", "enqueue"])("startup cancels only the wait that lost %s authority without reading its sources", async (loss) => {
    const f = await attentionHarness(); const first = await f.attention.arm(f.request());
    const peerId = randomUUID();
    const peer = { ...f.bound, key: `fleet:peer:${peerId}`, kind: "peer" as const, sessionId: peerId,
      grant: { ...f.bound.grant, subjectSessionId: peerId } };
    f.bindings.set(peerId, peer); f.records.set(peerId, { ...f.records.get(ACTOR)!, id: peerId });
    await f.coordination.handoffBatch({ mutationId: randomUUID(), actor: f.controller, recipient: orchestratorController(peer),
      recipientSessionId: peerId, directive: "Own the other worker", members: [{ subjectId: OTHER }], reason: "Test independent recovery" });
    const good = await f.attention.arm(f.request({ actorSessionId: peerId, targets: [{ sessionId: OTHER, completionTarget: 1 }] }));
    await f.attention.flush(); f.attention.stop();
    f.bindings.set(ACTOR, { ...f.bound, grant: { ...f.bound.grant,
      ...(loss === "scope" ? { scope: { kind: "self" as const } }
        : { capabilities: f.bound.grant.capabilities.filter((capability) => capability !== `thread.${loss}`) }) } });
    const ledger = vi.spyOn(f.transcripts, "readCompletionLedger");
    const restarted = f.makeControl(new OrchestratorAttentionStore(f.directory));
    await expect(restarted.attention.start()).resolves.toBeUndefined();
    expect(await f.store.get(first.controllerId)).toMatchObject({ status: "cancelled", cancelReason: "Orchestrator source authority lost" });
    expect(await f.store.get(good.controllerId)).toMatchObject({ epoch: good.epoch, status: "armed", recovery: "ready" });
    expect(ledger.mock.calls.map(([id]) => id)).not.toContain(ACTOR);
    expect(ledger.mock.calls.map(([id]) => id)).not.toContain(WORKER);
    expect(ledger.mock.calls.map(([id]) => id)).toContain(OTHER);
  });

  it("rechecks grants after capture and durably cancels only that wait", async () => {
    const f = await attentionHarness(); const armed = await f.attention.arm(f.request()); f.attention.stop();
    const read = f.transcripts.readCompletionLedger.bind(f.transcripts);
    vi.spyOn(f.transcripts, "readCompletionLedger").mockImplementation(async (id) => {
      const ledger = await read(id);
      if (id === WORKER) f.bindings.set(ACTOR, { ...f.bound, grant: { ...f.bound.grant, scope: { kind: "self" } } });
      return ledger;
    });
    await expect(f.makeControl(new OrchestratorAttentionStore(f.directory)).attention.start()).resolves.toBeUndefined();
    expect(await f.store.get(armed.controllerId)).toMatchObject({ status: "cancelled", cancelReason: "Orchestrator source authority lost" });
  });

  it("does not convert source I/O failures into authority cancellation", async () => {
    const f = await attentionHarness(); const armed = await f.attention.arm(f.request()); f.attention.stop();
    const failure = Object.assign(new Error("ledger I/O failure"), { code: "EIO" });
    vi.spyOn(f.transcripts, "readCompletionLedger").mockRejectedValue(failure);
    await expect(f.makeControl(new OrchestratorAttentionStore(f.directory)).attention.start()).rejects.toBe(failure);
    expect(await f.store.get(armed.controllerId)).toMatchObject({ status: "armed", epoch: armed.epoch });
  });

  it("fails startup if persisting an authority-loss cancellation fails", async () => {
    const f = await attentionHarness(); const armed = await f.attention.arm(f.request()); f.attention.stop();
    f.bindings.set(ACTOR, { ...f.bound, grant: { ...f.bound.grant, scope: { kind: "self" } } });
    const failure = Object.assign(new Error("attention I/O failure"), { code: "EIO" });
    const store = new OrchestratorAttentionStore(f.directory, async () => { throw failure; });
    await expect(f.makeControl(store).attention.start()).rejects.toBe(failure);
    expect(await f.store.get(armed.controllerId)).toMatchObject({ status: "armed", epoch: armed.epoch });
  });
});
