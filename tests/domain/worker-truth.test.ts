import { describe, expect, it } from "vitest";
import {
  advanceInstruction,
  instructionReachedProvider,
  instructionTransitionAllowed,
  isTerminalWorkerTruth,
  projectWorkerTruth,
  type WorkerTruthInput,
} from "../../src/domain/worker-truth.js";

function input(overrides: Partial<WorkerTruthInput> = {}): WorkerTruthInput {
  return {
    executionState: "active",
    exitCode: null,
    activity: "awaiting-input",
    composer: { modalOpen: false, occupied: false },
    completedTurns: 0,
    canonicalTurns: 0,
    pendingInstructions: 0,
    ...overrides,
  };
}

describe("projectWorkerTruth", () => {
  it("reports a blocked modal rather than the working spinner drawn underneath it", () => {
    const truth = projectWorkerTruth(input({
      activity: "working",
      composer: { modalOpen: true, occupied: false },
    }));

    expect(truth).toMatchObject({ state: "blocked-modal", terminal: false, modalOpen: true });
  });

  it("keeps an unsent buffer visible when it is sitting behind a modal", () => {
    // This is the MIK-64 incident in one value: a permission prompt owns the screen and the whole
    // instruction is in the composer. An orchestrator that cannot see both cannot act on either.
    const truth = projectWorkerTruth(input({
      activity: "needs-input",
      composer: { modalOpen: true, occupied: true, evidence: "tab to queue message" },
    }));

    expect(truth.state).toBe("blocked-modal");
    expect(truth.composerOccupied).toBe(true);
    expect(truth.detail).toContain("unsent text");
  });

  it("distinguishes an unsent composer from a worker that is actually running", () => {
    expect(projectWorkerTruth(input({ composer: { modalOpen: false, occupied: true } })).state)
      .toBe("blocked-composer");
    expect(projectWorkerTruth(input({ activity: "working" })).state).toBe("working");
  });

  it("lets a provider-declared limit outrank the process outcome that followed it", () => {
    const truth = projectWorkerTruth(input({
      executionState: "failed",
      exitCode: 1,
      providerLimit: {
        kind: "session-limit",
        reason: "provider usage limit reached",
        detail: "Usage limit reached · resets 3:00pm",
      },
    }));

    expect(truth).toMatchObject({ state: "provider-limit", terminal: true });
    expect(truth.detail).toBe("provider usage limit reached");
  });

  it("separates a stop from a clean exit and a scout budget from a scout failure", () => {
    expect(projectWorkerTruth(input({ executionState: "exited", exitCode: 0 })).state).toBe("exited");
    expect(projectWorkerTruth(input({ executionState: "exited", exitCode: 0, stopRequested: true })).state)
      .toBe("stopped");
    expect(projectWorkerTruth(input({ scoutTerminalState: "budget_exhausted" })).state).toBe("stopped");
    expect(projectWorkerTruth(input({ scoutTerminalState: "failed" })).state).toBe("failed");
  });

  it("says how many counted turns had a provider transcript behind them", () => {
    const truth = projectWorkerTruth(input({ completedTurns: 3, canonicalTurns: 0 }));

    expect(truth).toMatchObject({ state: "idle", completedTurns: 3, canonicalTurns: 0 });
  });

  it("reports an idle worker still holding accepted instructions as such", () => {
    expect(projectWorkerTruth(input({ pendingInstructions: 2 })).detail)
      .toContain("2 instruction(s) accepted but not yet submitted");
  });

  it("agrees with its own terminal set", () => {
    for (const state of ["provider-limit", "errored", "stopped", "exited", "failed"] as const) {
      expect(isTerminalWorkerTruth(state)).toBe(true);
    }
    for (const state of ["starting", "working", "blocked-modal", "blocked-composer", "idle", "stalled"] as const) {
      expect(isTerminalWorkerTruth(state)).toBe(false);
    }
  });
});

describe("instruction lifecycle", () => {
  it("refuses to walk backwards from written bytes", () => {
    // Bytes at a terminal cannot be unwritten, so `rendered` never returns to `queued`. Holding the
    // write in the first place is the only protection, which is what `queued` is for.
    expect(instructionTransitionAllowed("rendered", "queued")).toBe(false);
    expect(advanceInstruction("rendered", "queued")).toBe("rendered");
    expect(advanceInstruction("rendered", "submitted")).toBe("submitted");
  });

  it("returns the current state for a duplicate observation instead of throwing", () => {
    // These transitions are driven by PTY frames, and the same frame can be observed twice.
    expect(advanceInstruction("completed", "submitted")).toBe("completed");
  });

  it("only counts provider consumption as having reached the provider", () => {
    expect(instructionReachedProvider("rendered")).toBe(false);
    expect(instructionReachedProvider("queued")).toBe(false);
    expect(instructionReachedProvider("submitted")).toBe(true);
    expect(instructionReachedProvider("completed")).toBe(true);
  });

  it("lets any pre-submission state end as undelivered", () => {
    for (const state of ["accepted", "queued", "rendered", "submitted", "acknowledged"] as const) {
      expect(advanceInstruction(state, "undelivered")).toBe("undelivered");
    }
  });
});
