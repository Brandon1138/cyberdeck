import { describe, expect, it } from "vitest";
import { MascotActivityPulse } from "../../src/client/fleet/mascot-pulse.js";
import type { FleetThread } from "../../src/client/fleet/state.js";

function thread(id: string, attentionState: "working" | "done", kind = "orchestrator", generation = 1): FleetThread {
  return { record: { id, attentionState, kind, generation, pid: 42, executionState: "active" } } as FleetThread;
}

describe("mascot start acknowledgement", () => {
  it("starts settled around existing work and ignores worker activity", () => {
    const existing = thread("existing", "working");
    const pulse = new MascotActivityPulse([existing]);
    expect(pulse.update([existing, thread("worker", "working", "worker")], 0))
      .toEqual({ cursorVisible: true, nextFrameIn: undefined });
  });

  it("blinks three times for a new Working transition, then stays visible during sustained work", () => {
    const idle = thread("orc", "done");
    const working = thread("orc", "working");
    const pulse = new MascotActivityPulse([idle]);
    expect(pulse.update([working], 0).nextFrameIn).toBe(350);
    expect([350, 700, 1050, 1400, 1750].map((now) => pulse.update([working], now).cursorVisible))
      .toEqual([false, true, false, true, false]);
    for (const now of [2100, 2450, 60_000]) {
      expect(pulse.update([working], now)).toEqual({ cursorVisible: true, nextFrameIn: undefined });
    }
    pulse.update([idle], 61_000);
    expect(pulse.update([working], 62_000).nextFrameIn).toBe(350);
  });

  it("acknowledges a newly resumed generation even when its durable session was working", () => {
    const pulse = new MascotActivityPulse([thread("orc", "working")]);
    expect(pulse.update([thread("orc", "working", "orchestrator", 2)], 0).nextFrameIn).toBe(350);
  });

  it("coalesces overlapping starts without extending the blink period", () => {
    const first = thread("one", "working");
    const second = thread("two", "working");
    const pulse = new MascotActivityPulse([]);
    pulse.update([first], 0);
    expect(pulse.update([first, second], 1750).cursorVisible).toBe(false);
    expect(pulse.update([first, second], 2100)).toEqual({ cursorVisible: true, nextFrameIn: undefined });
  });
});
