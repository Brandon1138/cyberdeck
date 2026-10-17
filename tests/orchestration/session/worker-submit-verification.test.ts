import { afterEach, describe, expect, it, vi } from "vitest";
import { WakeHeldError } from "../../../src/domain/instruction.js";
import { AttentionWakeHeldError } from "../../../src/domain/orchestrator-attention.js";
import { admitSubmitRetry, SubmitVerifier, SUBMIT_VERIFY_MAX_CHECKS, SUBMIT_VERIFY_MS } from "../../../src/orchestration/session/worker-submit-verification.js";
import type { RenderedInstruction } from "../../../src/orchestration/session/worker-turn-state.js";

afterEach(() => vi.useRealTimers());

function fixture() {
  vi.useFakeTimers(); vi.setSystemTime(0);
  let epoch = 1, active = true, pending = true;
  const entry: RenderedInstruction = { instructionId: "attention-wake", expectedTurn: 1,
    renderedAt: new Date(0).toISOString(), state: "rendered", messageHead: "[cyberdeck attention]", submitPresses: 0 };
  const observe = vi.fn(() => ({ activity: "awaiting-input", composer: {
    modalOpen: false, occupied: true, content: "[cyberdeck attention]" } }));
  const pressed = vi.fn(() => { entry.submitPresses! += 1; });
  const host = { epoch: () => epoch, active: () => active, pending: () => pending, observe, press: pressed };
  const attempt = vi.fn((_entry: RenderedInstruction, _key: Buffer, current = () => true) =>
    admitSubmitRetry(entry, { ...host, active: () => current() && host.active() }));
  const exhausted = vi.fn();
  const verifier = new SubmitVerifier({ ...host, pending: () => pending ? [entry] : [], press: attempt, exhausted });
  entry.admission = async (apply) => apply();
  return { entry, host, observe, pressed, attempt, exhausted, verifier,
    changeEpoch() { epoch += 1; }, deactivate() { active = false; }, remove() { pending = false; } };
}

describe("guarded submit verification remediation", () => {
  it.each(["operator", "policy"])("S2-F2 retries a temporary %s hold without pressing through it", async (hold) => {
    const f = fixture();
    f.entry.beforeResubmit = () => {
      if (Date.now() < 3_000) throw hold === "operator"
        ? new WakeHeldError("wake-operator-active") : new AttentionWakeHeldError("notification-wake-off");
    };
    try {
      f.verifier.arm(); await vi.advanceTimersByTimeAsync(SUBMIT_VERIFY_MS);
      expect(f.pressed).not.toHaveBeenCalled(); expect(f.attempt).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(6_000);
      expect(f.pressed).toHaveBeenCalledTimes(2); expect(f.exhausted).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally { f.verifier.release(); }
  });

  it("S2-F2 bounds a permanent admission hold without presses or a spinning timer", async () => {
    const f = fixture();
    f.entry.admission = async () => { throw new AttentionWakeHeldError("notification-wake-off"); };
    try {
      f.verifier.arm(); await vi.advanceTimersByTimeAsync(60_000);
      expect(f.attempt).toHaveBeenCalledTimes(SUBMIT_VERIFY_MAX_CHECKS);
      expect(f.pressed).not.toHaveBeenCalled(); expect(f.exhausted).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    } finally { f.verifier.release(); }
  });

  it("stops an obsolete attention entry rather than retrying it", async () => {
    const f = fixture(); f.entry.admission = async () => { throw new AttentionWakeHeldError("attention-obsolete", true); };
    try {
      f.verifier.arm(); await vi.advanceTimersByTimeAsync(60_000);
      expect(f.attempt).toHaveBeenCalledTimes(1); expect(f.pressed).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    } finally { f.verifier.release(); }
  });

  it.each(["release", "re-arm", "epoch", "inactive", "removed", "completed", "human draft", "modal"])(
    "S2-F2 fences delayed async admission after %s", async (change) => {
      const f = fixture(); let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      f.entry.admission = async (apply) => { await gate; return apply(); };
      try {
        f.verifier.arm(); await vi.advanceTimersByTimeAsync(SUBMIT_VERIFY_MS);
        expect(f.attempt).toHaveBeenCalledTimes(1); expect(f.pressed).not.toHaveBeenCalled();
        if (change === "release") f.verifier.release();
        if (change === "re-arm") f.verifier.arm();
        if (change === "epoch") f.changeEpoch();
        if (change === "inactive") f.deactivate();
        if (change === "removed") f.remove();
        if (change === "completed") f.entry.state = "completed";
        if (change === "human draft") f.observe.mockReturnValue({ activity: "awaiting-input", composer: {
          modalOpen: false, occupied: true, content: "operator's unrelated draft" } });
        if (change === "modal") f.observe.mockReturnValue({ activity: "needs-input", composer: {
          modalOpen: true, occupied: true, content: "[cyberdeck attention]" } });
        release(); await vi.advanceTimersByTimeAsync(0);
        expect(f.pressed).not.toHaveBeenCalled();
        if (change === "re-arm" || change === "modal") {
          f.observe.mockReturnValue({ activity: "awaiting-input", composer: {
            modalOpen: false, occupied: true, content: "[cyberdeck attention]" } });
          await vi.advanceTimersByTimeAsync(SUBMIT_VERIFY_MS);
          expect(f.pressed).toHaveBeenCalledTimes(1);
        } else { await vi.advanceTimersByTimeAsync(60_000); expect(f.pressed).not.toHaveBeenCalled(); }
      } finally { release(); f.verifier.release(); }
    });
});
