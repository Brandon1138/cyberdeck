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
