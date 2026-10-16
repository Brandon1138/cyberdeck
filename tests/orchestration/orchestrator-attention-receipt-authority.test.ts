import { afterEach, describe, expect, it } from "vitest";
import { OrchestratorAttentionStore } from "../../src/persistence/orchestrator-attention-store.js";
import { writeAtomicPrivateFile } from "../../src/persistence/atomic-private-file.js";
import { ACTOR, OTHER, attentionHarness, cleanupAttentionHarnesses } from "../support/attention-harness.js";

afterEach(cleanupAttentionHarnesses);

describe("authority at attention receipt delivery", () => {
  it.each(["grant", "scope", "remove", "replace", "cancel", "rearm", "stop", "native-cancel"])("refuses source delivery when %s changes during receipt persistence", async (change) => {
    const f = await attentionHarness(); await f.report("PRIVATE-RESULT-REVOKED-GRANT"); await f.notify();
    const armed = await f.attention.arm(f.request()); f.attention.stop();
    let injected = false; let lifecycle: Promise<unknown> | undefined;
    const store = new OrchestratorAttentionStore(f.directory, async (path, body) => {
      await writeAtomicPrivateFile(path, body);
      if (injected || JSON.parse(body).receipts.length === 0) return;
      injected = true;
      if (change === "grant") f.bindings.set(ACTOR, { ...f.bound, grant: { ...f.bound.grant, capabilities: ["thread.enqueue"] } });
      if (change === "scope") f.bindings.set(ACTOR, { ...f.bound, grant: { ...f.bound.grant, scope: { kind: "self" } } });
      if (change === "remove" || change === "replace") {
        f.bindings.delete(ACTOR);
        lifecycle = current.attention.bindingRemoved(f.bound);
        if (change === "replace") {
          const replacement = { ...f.bound, sessionId: OTHER, grant: { ...f.bound.grant, subjectSessionId: OTHER } };
          f.bindings.set(OTHER, replacement);
          lifecycle = lifecycle.then(() => current.attention.bindingChanged(replacement));
        }
      }
      if (change === "cancel") lifecycle = current.attention.cancel({ actorSessionId: ACTOR, epoch: armed.epoch });
      if (change === "rearm") lifecycle = current.attention.arm(f.request({ previousEpoch: armed.epoch }));
      if (change === "stop") { f.stopped.add(ACTOR); f.emit(ACTOR); }
      if (change === "native-cancel") {
        await f.transcripts.commitProviderTurns({ sessionId: ACTOR, provider: "codex", turnNumber: 1,
          turns: [{ providerTurnId: "aborted-during-receipt", providerOccurredAt: armed.armedAt,
            text: "Provider turn was cancelled", transport: "provider-native", data: { outcome: "cancelled" } }] });
        f.emit(ACTOR, { state: "interrupted", completedTurns: 1 });
      }
    });
    const current = f.makeControl(store); await current.attention.start();
    const expected = change === "grant" || change === "scope" ? "CAPABILITY_DENIED"
      : change === "remove" || change === "replace" ? "ACTOR_NOT_AUTHORIZED"
        : change === "rearm" ? "STALE_ATTENTION_EPOCH" : "ATTENTION_CANCELLED";
    try {
      await expect(current.notifications.read({ actorSessionId: ACTOR, attentionEpoch: armed.epoch })).rejects.toMatchObject({ code: expected });
    } finally { await lifecycle; }
    const state = (await store.get(armed.controllerId))!;
    expect(state.coverage.consumed).toEqual([]);
    expect(state.receipts.every((receipt) => receipt.acknowledgedAt === undefined)).toBe(true);
    expect(f.inbox.pendingCount(armed.controllerId)).toBe(1);
    if (change === "grant" || change === "scope") {
      expect(state.receipts).toHaveLength(1);
      f.bindings.set(ACTOR, f.bound);
      const page = await current.notifications.read({ actorSessionId: ACTOR, attentionEpoch: armed.epoch });
      expect(page.attention!.workers[0]!.reports[0]!.summary).toBe("PRIVATE-RESULT-REVOKED-GRANT");
      expect(page.attention!.consumed).toEqual([]);
    }
  });
});
