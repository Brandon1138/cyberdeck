import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACTOR, WORKER, OTHER, attentionHarness, cleanupAttentionHarnesses } from "../support/attention-harness.js";

afterEach(cleanupAttentionHarnesses);

describe("attention consumption receipts", () => {
  it("reading, notices and rendered input do not consume source coverage", async () => {
    const f = await attentionHarness(); await f.report("Read me"); await f.complete();
    const armed = await f.attention.arm(f.request()); await f.notify();
    await f.inbox.markNoticed(armed.controllerId, 1);
    await f.inbox.markDelivered(armed.controllerId, f.inbox.listPending(armed.controllerId, 0, 50).map((n) => n.id), "wake");
    f.emit(ACTOR, { state: "working" }); await f.attention.flush();
    const page = await f.notifications.read({ actorSessionId: ACTOR, attentionEpoch: armed.epoch });
    const state = (await f.store.get(armed.controllerId))!;
    expect(state.coverage.consumed).toEqual([]);
    expect(state.coverage.submitted).toEqual([]);
    expect(state.receipts[0]!.acknowledgedAt).toBeUndefined();
    expect(f.inbox.pendingCount(armed.controllerId)).toBe(1);
    await f.notifications.read({ actorSessionId: ACTOR, attentionEpoch: armed.epoch, attentionReceiptId: page.attention!.receiptId });
    expect((await f.store.get(armed.controllerId))!.coverage.consumed[0]).toMatchObject({ eventOrdinal: 1, completionTurn: 1 });
    expect(f.inbox.pendingCount(armed.controllerId)).toBe(0);
  });

  it("arrivals during acknowledgement remain outstanding and are returned in the next page", async () => {
    const f = await attentionHarness(); await f.report("Before read"); const firstNotice = await f.notify();
    const armed = await f.attention.arm(f.request());
    const page = await f.notifications.read({ actorSessionId: ACTOR, attentionEpoch: armed.epoch });
    const real = f.inbox.acknowledgeIds.bind(f.inbox);
    vi.spyOn(f.inbox, "acknowledgeIds").mockImplementationOnce(async (controllerId, ids) => {
      await f.report("During acknowledgement"); await f.complete("ARRIVED-DURING-ACK"); await f.notify();
      return real(controllerId, ids);
    });
    const next = await f.notifications.read({ actorSessionId: ACTOR, attentionEpoch: armed.epoch, attentionReceiptId: page.attention!.receiptId });
    const state = (await f.store.get(armed.controllerId))!;
    expect(state.coverage.consumed[0]).toMatchObject({ eventOrdinal: 1, completionTurn: 0 });
    // Progress supersession journals an ordinal for the prior report and one for its replacement.
    expect(state.coverage.captured[0]).toMatchObject({ eventOrdinal: 3, completionTurn: 1 });
    expect(next.attention!.workers[0]!.reports.map((event) => event.summary)).toContain("During acknowledgement");
    expect(next.attention!.workers[0]!.completion!.text).toBe("ARRIVED-DURING-ACK");
    expect(next.notifications.map((n) => n.id)).not.toContain(firstNotice.record!.id);
    expect(next.notifications).toHaveLength(1);
  });

  it("filtered pages acknowledge only notifications actually returned, even below the page cursor", async () => {
    const f = await attentionHarness(); const progress = await f.notify("progress"); const risk = await f.notify("risk");
    const armed = await f.attention.arm(f.request());
    const page = await f.notifications.read({ actorSessionId: ACTOR, attentionEpoch: armed.epoch, kinds: ["risk"] });
    expect(page.notifications.map((n) => n.id)).toEqual([risk.record!.id]);
    await f.notifications.read({ actorSessionId: ACTOR, attentionEpoch: armed.epoch, attentionReceiptId: page.attention!.receiptId });
    expect(f.inbox.listPending(armed.controllerId, 0, 50).map((n) => n.id)).toEqual([progress.record!.id]);
  });

  it("a crash between receipt persistence and inbox acknowledgement is idempotently recoverable", async () => {
    const f = await attentionHarness(); await f.report("Original"); const notice = await f.notify();
    const armed = await f.attention.arm(f.request());
    const page = await f.notifications.read({ actorSessionId: ACTOR, attentionEpoch: armed.epoch });
    vi.spyOn(f.inbox, "acknowledgeIds").mockRejectedValueOnce(new Error("crash after source acknowledgement"));
    const request = { actorSessionId: ACTOR, attentionEpoch: armed.epoch, attentionReceiptId: page.attention!.receiptId };
    await expect(f.notifications.read(request)).rejects.toThrow("crash after source");
    expect(f.inbox.pendingCount(armed.controllerId)).toBe(1);
    expect((await f.store.get(armed.controllerId))!.consumption!.receiptId).toBe(page.attention!.receiptId);
    f.attention.stop(); const restarted = f.makeControl(); await restarted.attention.start();
    await f.report("Later"); await f.notify();
    const replay = await restarted.notifications.read(request);
    expect(replay.notifications.map((n) => n.id)).not.toContain(notice.record!.id);
    expect(replay.notifications).toHaveLength(1);
    expect((await f.store.get(armed.controllerId))!.coverage.consumed[0]!.eventOrdinal).toBe(1);
  });

  it("rejects forged receipts and ambiguous mixed acknowledgement modes without consuming anything", async () => {
    const f = await attentionHarness(); await f.report("Pending"); await f.notify(); const armed = await f.attention.arm(f.request());
    await expect(f.notifications.read({ actorSessionId: ACTOR, attentionEpoch: armed.epoch, attentionReceiptId: randomUUID() }))
      .rejects.toMatchObject({ code: "STALE_ATTENTION_RECEIPT" });
    await expect(f.notifications.read({ actorSessionId: ACTOR, attentionEpoch: armed.epoch, acknowledgeThrough: 99 })).rejects.toThrow();
    expect((await f.store.get(armed.controllerId))!.coverage.consumed).toEqual([]);
    expect(f.inbox.pendingCount(armed.controllerId)).toBe(1);
  });

  it("legacy cursor acknowledgement retains its existing semantics and cannot consume attention", async () => {
    const f = await attentionHarness(); await f.report("Still outstanding"); await f.notify(); const armed = await f.attention.arm(f.request());
    const page = await f.notifications.read({ actorSessionId: ACTOR }); expect(page.attention).toBeUndefined();
    await f.notifications.read({ actorSessionId: ACTOR, acknowledgeThrough: page.nextCursor });
    expect(f.inbox.pendingCount(armed.controllerId)).toBe(0);
    expect((await f.store.get(armed.controllerId))!.coverage.consumed).toEqual([]);
    const attentionPage = await f.notifications.read({ actorSessionId: ACTOR, attentionEpoch: armed.epoch });
    expect(attentionPage.attention!.workers[0]!.reports).toHaveLength(1);
  });

  it("keeps overflow reconstructable and consumes only a bounded source page", async () => {
    const f = await attentionHarness();
    for (let i = 0; i < 61; i++) await f.report(`Report ${i}`);
    const armed = await f.attention.arm(f.request());
    expect(armed.coverage.captured[0]!.eventOrdinal).toBe(121);
    const first = await f.notifications.read({ actorSessionId: ACTOR, attentionEpoch: armed.epoch });
    expect(first.attention!.workers[0]!.reports).toHaveLength(50);
    expect(first.attention!.workers[0]!.moreReports).toBe(true);
    const second = await f.notifications.read({ actorSessionId: ACTOR, attentionEpoch: armed.epoch, attentionReceiptId: first.attention!.receiptId });
    expect(second.attention!.consumed[0]!.eventOrdinal).toBe(100);
    expect(second.attention!.workers[0]!.reports).toHaveLength(11);
    expect(second.attention!.workers[0]!.moreReports).toBe(false);
  });

  it("does not consume a second worker's unread reports when the shared page budget is exhausted", async () => {
    const f = await attentionHarness();
    for (let i = 0; i < 50; i++) await f.report(`First worker ${i}`);
    await f.report("Second worker", {}, OTHER);
    const armed = await f.attention.arm(f.request({ targets: [{ sessionId: WORKER, completionTarget: 1 }, { sessionId: OTHER, completionTarget: 1 }] }));
    const first = await f.notifications.read({ actorSessionId: ACTOR, attentionEpoch: armed.epoch });
    expect(first.attention!.workers[1]).toMatchObject({ reports: [], moreReports: true });
    const second = await f.notifications.read({ actorSessionId: ACTOR, attentionEpoch: armed.epoch, attentionReceiptId: first.attention!.receiptId });
    expect(second.attention!.workers[1]!.reports[0]!.summary).toBe("Second worker");
    expect(second.attention!.consumed.find((point) => point.sessionId === OTHER)!.eventOrdinal).toBe(0);
  });

  it("late acknowledgement of an older read cannot regress newer truth or source coverage", async () => {
    const f = await attentionHarness(); await f.report("First"); const armed = await f.attention.arm(f.request());
    const first = await f.notifications.read({ actorSessionId: ACTOR, attentionEpoch: armed.epoch });
    await f.report("Second"); await f.complete();
    const second = await f.notifications.read({ actorSessionId: ACTOR, attentionEpoch: armed.epoch });
    await f.attention.acknowledge(ACTOR, armed.epoch, second.attention!.receiptId);
    const newer = (await f.store.get(armed.controllerId))!.coverage.consumed;
    await f.attention.acknowledge(ACTOR, armed.epoch, first.attention!.receiptId);
    expect((await f.store.get(armed.controllerId))!.coverage.consumed).toEqual(newer);
  });

  it("retains only bounded read metadata and refuses an expired receipt conservatively", async () => {
    const f = await attentionHarness(); await f.report("Never acknowledged"); const armed = await f.attention.arm(f.request());
    const first = await f.notifications.read({ actorSessionId: ACTOR, attentionEpoch: armed.epoch });
    for (let i = 0; i < 9; i++) await f.notifications.read({ actorSessionId: ACTOR, attentionEpoch: armed.epoch });
    expect((await f.store.get(armed.controllerId))!.receipts).toHaveLength(8);
    await expect(f.attention.acknowledge(ACTOR, armed.epoch, first.attention!.receiptId)).rejects.toMatchObject({ code: "STALE_ATTENTION_RECEIPT" });
    expect((await f.store.get(armed.controllerId))!.coverage.consumed).toEqual([]);
  });

  it("missing exact completion text is surfaced and never consumed by a high-water-only claim", async () => {
    const f = await attentionHarness();
    vi.spyOn(f.transcripts, "readCompletionLedger").mockResolvedValue({ completedTurns: 1, canonicalTurns: 1, turns: [] });
    const armed = await f.attention.arm(f.request());
    const first = await f.notifications.read({ actorSessionId: ACTOR, attentionEpoch: armed.epoch });
    expect(first.attention!.gaps).toContainEqual({ sessionId: WORKER, reason: "completion-unavailable" });
    await f.attention.acknowledge(ACTOR, armed.epoch, first.attention!.receiptId);
    expect((await f.store.get(armed.controllerId))!.coverage.consumed[0]!.completionTurn).toBe(0);
  });

  it("retains known source coverage if a receipt is subsequently unavailable", async () => {
    const f = await attentionHarness(); await f.complete(); const armed = await f.attention.arm(f.request());
    vi.spyOn(f.transcripts, "readCompletionLedger").mockResolvedValue({ completedTurns: 0, canonicalTurns: 0, turns: [] });
    const page = await f.notifications.read({ actorSessionId: ACTOR, attentionEpoch: armed.epoch });
    expect(page.attention!.captured[0]!.completionTurn).toBe(1);
    expect(page.attention!.gaps).toContainEqual({ sessionId: WORKER, reason: "completion-unavailable" });
    await f.attention.acknowledge(ACTOR, armed.epoch, page.attention!.receiptId);
    expect((await f.store.get(armed.controllerId))!.coverage.consumed[0]!.completionTurn).toBe(0);
  });

  it("a replacement wait for another turn receives its own result", async () => {
    const f = await attentionHarness(); await f.complete("TURN-1"); const first = await f.attention.arm(f.request());
    const page = await f.notifications.read({ actorSessionId: ACTOR, attentionEpoch: first.epoch });
    await f.attention.acknowledge(ACTOR, first.epoch, page.attention!.receiptId);
    await f.complete("TURN-2", 2);
    const next = await f.attention.arm(f.request({ previousEpoch: first.epoch, targets: [{ sessionId: WORKER, completionTarget: 2 }] }));
    expect(next.coverage.consumed[0]!.completionTurn).toBe(0);
    const result = await f.notifications.read({ actorSessionId: ACTOR, attentionEpoch: next.epoch });
    expect(result.attention!.workers[0]!.completion).toMatchObject({ turn: 2, text: "TURN-2" });
  });
});
