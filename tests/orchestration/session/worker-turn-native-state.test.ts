import { readFileSync } from "node:fs";
import { WorkerTurnObservationAdapter } from "../../../src/runtime/worker-turn-observation-adapter.js";
import { describe, expect, it } from "vitest";
import { NativeTurnActivity } from "../../../src/orchestration/session/worker-turn-native-state.js";
import type { WorkerTurnObservation } from "../../../src/orchestration/session/worker-turn-ports.js";

const createdAt = "2026-10-13T12:00:00.000Z";
function observation(activity: "working" | "idle", occurredAt = "2026-10-13T12:00:01.000Z", id = `native-${activity}`): WorkerTurnObservation {
  return { sessionId: "session", provider: "codex", turnNumber: 1, turns: [],
    nativeSourceAvailable: true, nativeActivity: activity,
    nativeActivityEvidence: { id, kind: activity === "working" ? "task_started" : "task_complete", occurredAt },
  };
}

describe("exact native activity observations", () => {
  it.each([false, true])("keeps the known native end when done precedes a stale Working footer (native=%s)", hasNative => {
    const native = new NativeTurnActivity(createdAt);
    native.noteInput(createdAt);
    native.observeScreen(1, "working", Date.parse("2026-10-13T12:00:00.500Z"), false, { id: 1, active: true });
    if (hasNative) native.observe(observation("idle"), 1, 1);
    native.observeScreen(2, "working", Date.parse("2026-10-13T12:00:04Z"), false, { id: 1, active: false });
    native.observeScreen(3, "awaiting-input", Date.parse("2026-10-13T12:00:05Z"), false, { id: 1, active: false });
    expect(native.ownsCurrentEnd(3)).toBe(hasNative);
    native.observeScreen(4, "working", Date.parse("2026-10-13T12:00:06Z"), false, { id: 1, active: false });
    native.observeScreen(5, "awaiting-input", Date.parse("2026-10-13T12:00:07Z"), false, { id: 1, active: false });
    expect(native.ownsCurrentEnd(5)).toBe(false);
  });
  it("waits for the Codex work cycle to close without dating its redraws as new work", () => {
    const native = new NativeTurnActivity(createdAt);
    native.noteInput(createdAt);
    native.observeScreen(1, "working", Date.parse("2026-10-13T12:00:00.500Z"), false, { id: 1, active: true });
    native.observeScreen(2, "working", Date.parse("2026-10-13T12:00:02.000Z"), false, { id: 1, active: true });
    native.observe(observation("idle"), 2, 2);
    expect(native.activity("working", 2)).toBe("working");
    expect(native.ownsCurrentEnd(2)).toBe(false);
    native.observeScreen(3, "awaiting-input", Date.parse("2026-10-13T12:00:02.100Z"), false, { id: 1, active: false });
    expect(native.activity("awaiting-input", 3)).toBe("awaiting-input");
    expect(native.ownsCurrentEnd(3)).toBe(true);
    // A new remote cycle, even with no local input, fences the previous receipt.
    native.observeScreen(4, "working", Date.parse("2026-10-13T12:00:03.000Z"), false, { id: 2, active: true });
    native.observe(observation("idle"), 4, 4);
    native.observeScreen(5, "awaiting-input", Date.parse("2026-10-13T12:00:04.000Z"), false, { id: 2, active: false });
    expect(native.activity("awaiting-input", 5)).not.toBe("awaiting-input");
    expect(native.ownsCurrentEnd(5)).toBe(false);
  });

  it("does not reuse a cycle's native end after newer input or unannounced positive work", () => {
    for (const newerInput of [false, true]) {
      const native = new NativeTurnActivity(createdAt);
      native.observeScreen(1, "working", Date.parse("2026-10-13T12:00:00.500Z"), false, { id: 1, active: true });
      native.observe(observation("idle"), 1, 1);
      native.observeScreen(2, "awaiting-input", Date.parse("2026-10-13T12:00:02.000Z"), false, { id: 1, active: false });
      if (newerInput) native.noteInput("2026-10-13T12:00:03.000Z");
      native.observeScreen(3, "working", Date.parse("2026-10-13T12:00:03.100Z"), false, { id: 1, active: false });
      native.observe(observation("idle"), 3, 3);
      native.observeScreen(4, "awaiting-input", Date.parse("2026-10-13T12:00:04.000Z"), false, { id: 1, active: false });
      expect(native.activity("awaiting-input", 4)).not.toBe("awaiting-input");
    }
  });

  it("recovers the same idle evidence after a transient native read failure without terminal bytes", () => {
    const native = new NativeTurnActivity(createdAt);
    native.noteInput(createdAt);
    native.observe(observation("idle"), 1, 1);
    expect(native.activity("unknown", 1)).toBe("awaiting-input");
    native.observe({ sessionId: "session", provider: "codex", turnNumber: 1, turns: [], nativeSourceAvailable: false,
      nativeSourceStatus: "source-error", nativeActivity: "unknown" }, 1, 1);
    expect(native.activity("unknown", 1)).toBe("unknown");
    native.observe(observation("idle"), 1, 1);
    expect(native.activity("unknown", 1)).toBe("awaiting-input");
  });

  it.each(["input", "working", "generation"])("does not revive idle after a read outage crosses a newer %s fence", fence => {
    const native = new NativeTurnActivity(createdAt);
    native.noteInput(createdAt);
    native.observe(observation("idle"), 1, 1);
    native.observe({ sessionId: "session", provider: "codex", turnNumber: 1, turns: [], nativeSourceAvailable: false,
      nativeSourceStatus: "source-error", nativeActivity: "unknown" }, 1, 1);
    const later = "2026-10-13T12:00:02.000Z";
    if (fence === "input") native.noteInput(later);
    if (fence === "working") native.observeScreen(2, "working", Date.parse(later));
    if (fence === "generation") native.reset(later);
    native.observe(observation("idle"), 2, 2);
    expect(native.activity("unknown", 2)).not.toBe("awaiting-input");
  });

  it("keeps proven native idle through unclassified attachment redraws", () => {
    const native = new NativeTurnActivity(createdAt);
    native.noteInput(createdAt);
    native.observe(observation("idle"), 1, 1);
    native.observeScreen(2, "unknown");
    expect(native.activity("unknown", 2)).toBe("awaiting-input");
  });

  it("preserves idle through redraw and admission without reusing it after real input", () => {
    const native = new NativeTurnActivity(createdAt);
    native.noteInput(createdAt);
    native.observe(observation("idle"), 1, 1);
    native.observeScreen(2, "awaiting-input");
    expect(native.activity("awaiting-input", 2)).toBe("awaiting-input");
    native.admit(3);
    expect(native.activity("awaiting-input", 3)).toBe("awaiting-input");
    native.noteInput("2026-10-13T12:00:02.000Z");
    native.observe(observation("idle"), 4, 4);
    expect(native.activity("unknown", 4)).toBe("unknown");
  });

  it("recognizes the ready surface after a delayed startup repaint without a new native receipt", () => {
    const native = new NativeTurnActivity(createdAt);
    native.noteInput(createdAt);
    native.observeScreen(1, "working", Date.parse("2026-10-13T12:00:02.000Z"), true);
    native.observe(observation("idle"), 1, 1);
    expect(native.activity("working", 1)).toBe("working");
    native.observeScreen(2, "unknown");
    expect(native.activity("unknown", 2)).toBe("working");
    native.observeScreen(3, "awaiting-input");
    expect(native.activity("awaiting-input", 3)).toBe("awaiting-input");
    native.observeScreen(4, "unknown");
    expect(native.activity("unknown", 4)).toBe("awaiting-input");
  });

  it("does not retain idle over newer positive work or a modal", () => {
    const native = new NativeTurnActivity(createdAt);
    native.observe(observation("idle"), 1, 1);
    native.observeScreen(2, "working");
    native.observeScreen(3, "unknown");
    expect(native.activity("unknown", 3)).not.toBe("awaiting-input");
    native.observeScreen(4, "awaiting-input");
    expect(native.activity("awaiting-input", 4)).not.toBe("awaiting-input");
    native.observeScreen(5, "needs-input");
    expect(native.activity("needs-input", 5)).toBe("needs-input");
  });

  it("does not turn an older completion into readiness when real newer work repaints idle", () => {
    const native = new NativeTurnActivity(createdAt);
    native.noteInput(createdAt);
    native.observeScreen(1, "working", Date.parse("2026-10-13T12:00:02.000Z"));
    native.observe(observation("idle"), 1, 1);
    native.observeScreen(2, "awaiting-input");
    expect(native.activity("awaiting-input", 2)).toBe("unknown");
    expect(native.ownsCurrentEnd(2)).toBe(false);
  });

  it("uses native lifecycle evidence and keeps currently observed modals visible", () => {
    const native = new NativeTurnActivity(createdAt);
    native.observe(observation("working"), 1, 1);
    expect(native.activity("awaiting-input", 1)).toBe("working");
    expect(native.activity("needs-input", 1)).toBe("needs-input");
  });

  it("does not apply an asynchronous native snapshot over newer input or terminal activity", () => {
    const native = new NativeTurnActivity(createdAt);
    native.observe(observation("idle"), 1, 2);
    expect(native.activity("working", 2)).toBe("working"); // Positive current screen work remains evidence.
    expect(native.activity("unknown", 2)).toBe("unknown"); // Stale idle proves no current readiness.
    native.observe(observation("working"), 2, 2);
    expect(native.activity("unknown", 2)).toBe("working");
    expect(native.activity("awaiting-input", 3)).toBe("working"); // A redraw alone does not end known native work.
    native.noteInput("2026-10-13T12:00:02.000Z");
    expect(native.activity("awaiting-input", 3)).toBe("unknown");
  });

  it("does not let a prior generation's completion make a resumed session idle", () => {
    const native = new NativeTurnActivity(createdAt);
    native.reset("2026-10-13T12:10:00.000Z");
    native.observe(observation("idle"), 1, 1);
    expect(native.activity("awaiting-input", 1)).toBe("unknown");
    native.observe(observation("idle", "2026-10-13T12:10:01.000Z"), 1, 1);
    expect(native.activity("awaiting-input", 1)).toBe("unknown"); // Re-timestamping the same ID is not fresh evidence.
    native.observe(observation("working", "2026-10-13T12:10:01.000Z", "resumed-start"), 1, 1);
    expect(native.activity("unknown", 1)).toBe("working");
  });

  it("does not revive an already seen receipt by changing its timestamp after new input", () => {
    const native = new NativeTurnActivity(createdAt);
    native.observe(observation("idle"), 1, 1);
    expect(native.activity("unknown", 1)).toBe("awaiting-input");
    native.noteInput("2026-10-13T12:00:02.000Z");
    native.observe(observation("idle", "2026-10-13T12:00:03.000Z"), 2, 2);
    expect(native.activity("awaiting-input", 2)).toBe("unknown");
    expect(native.activity("working", 2)).toBe("working");
    native.observe(observation("working", "2026-10-13T12:00:03.000Z", "next-start"), 2, 2);
    expect(native.activity("unknown", 2)).toBe("working");
  });
});


describe("fresh remote readiness after ancillary terminal work", () => {
  function stalled() {
    const native = new NativeTurnActivity(createdAt);
    native.noteInput(createdAt);
    native.observe(observation("idle"), 1, 1);
    native.observeScreen(2, "working", Date.parse("2026-10-13T12:00:03.000Z"), false, { id: 2, active: true });
    native.observeScreen(3, "awaiting-input", Date.parse("2026-10-13T12:00:04.000Z"), false, { id: 2, active: false });
    native.observe(observation("idle"), 3, 3);
    return native;
  }
  const ready = (): WorkerTurnObservation => ({ ...observation("idle"), nativeSessionId: "exact-thread",
    nativeReadiness: { nativeSessionId: "exact-thread", observedAt: "2026-10-13T12:00:05.000Z" } });
  it("reopens admission on a fresh bound idle read without inventing a completion", () => {
    const native = stalled();
    expect(native.needsReadiness("awaiting-input", 3)).toBe(true);
    expect(native.ownsCurrentEnd(3)).toBe(false);
    native.observe(ready(), 3, 3);
    expect(native.ownsCurrentEnd(3)).toBe(true);
    expect(native.activity("awaiting-input", 3)).toBe("awaiting-input");
    expect(native.turns(ready(), 3)).toEqual([]);
  });
  it.each(["input", "generation", "revision", "active-cycle", "wrong-thread", "read-error", "native-working", "old-read"])("preserves the %s fence", fence => {
    const native = stalled(), read = ready();
    if (fence === "input") native.noteInput("2026-10-13T12:00:02.000Z");
    if (fence === "generation") native.reset("2026-10-13T12:00:02.000Z");
    if (fence === "active-cycle") native.observeScreen(3, "working", Date.parse("2026-10-13T12:00:04.000Z"), false, {id: 3, active: true});
    if (fence === "wrong-thread") read.nativeReadiness!.nativeSessionId = "another-thread";
    if (fence === "read-error") read.nativeSourceStatus = "source-error";
    if (fence === "native-working") read.nativeActivity = "working";
    if (fence === "old-read") read.nativeReadiness!.observedAt = "2026-10-13T12:00:02.000Z";
    native.observe(read, 3, fence === "revision" ? 4 : 3);
    expect(native.ownsCurrentEnd(fence === "revision" ? 4 : 3)).toBe(false);
  });
});


it("recovers the retained real Codex ancillary-cycle bytes only with fresh runtime idle", () => {
 const adapter=new WorkerTurnObservationAdapter(), replay=adapter.createReplay(128*1024);
 const native=new NativeTurnActivity(createdAt);
 native.noteInput(createdAt);native.observe(observation("idle"),1,1);
 const bytes=readFileSync(new URL("../../fixtures/codex-ancillary-cycle.pty",import.meta.url));
 replay.appendBytes(bytes.subarray(0,32));native.observeScreen(2,adapter.activity("codex",replay),Date.parse("2026-10-13T12:00:03Z"),false,replay.workCycle?.("codex"));
 replay.appendBytes(bytes.subarray(32));native.observeScreen(3,"awaiting-input",Date.parse("2026-10-13T12:00:04Z"),false,replay.workCycle?.("codex"));
 native.observe(observation("idle"),3,3);expect(native.ownsCurrentEnd(3)).toBe(false);
 native.observe({...observation("idle"),nativeSessionId:"native",nativeReadiness:{nativeSessionId:"native",observedAt:"2026-10-13T12:00:05Z"}},3,3);
 expect(native.ownsCurrentEnd(3)).toBe(true);
});
