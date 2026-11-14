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
