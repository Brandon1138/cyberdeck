import { describe, expect, it } from "vitest";
import { providerTerminalActivity } from "../../src/domain/terminal-replay.js";
import { frameComposerState, frameInputReady } from "../../src/runtime/composer-state.js";
import { projectWorkerTruth } from "../../src/domain/worker-truth.js";
import { threadStatus } from "../../src/client/fleet/transport.js";
import type { SessionRecord } from "../../src/domain/session.js";

describe("operator activity contract", () => {
  it.each(["high", "xhigh", "max", "ultra"])("recognizes an idle %s footer and keeps a draft out of human attention", (effort) => {
    for (const draft of [false, true]) {
      const frame = `› ${draft ? "[Image #1] We" : "Ask Codex to do anything"}\n\nGPT-6.1-Sol ${effort} · ~ · ⚠ 2 warnings · f2 to view`;
      const activity = providerTerminalActivity("codex", frame);
      expect(activity).toBe("awaiting-input");
      const composer = { ...frameComposerState("codex", frame, { modalOpen: false }), inputReady: frameInputReady("codex", frame) };
      expect(composer.inputReady).toBe(!draft);
      const truth = projectWorkerTruth({ executionState: "active", exitCode: null, activity, composer,
        completedTurns: 1, canonicalTurns: 1, pendingInstructions: 0 });
      expect(threadStatus({ record: {} as SessionRecord, workerTruth: truth })).toBe("Idle");
      expect(truth.composerOccupied).toBe(draft);
    }
  });
  it("reserves Needs you for a blocking provider request", () => {
    const truth = projectWorkerTruth({ executionState: "active", exitCode: null, activity: "working",
      composer: { occupied: true, modalOpen: true }, completedTurns: 0, canonicalTurns: 0, pendingInstructions: 0 });
    expect(threadStatus({ record: {} as SessionRecord, workerTruth: truth })).toBe("Needs you");
  });
  it("shows unavailable observation explicitly", () => {
    const truth = projectWorkerTruth({ executionState: "active", exitCode: null, activity: "unknown",
      composer: { occupied: false, modalOpen: false }, completedTurns: 2, canonicalTurns: 2, pendingInstructions: 0 });
    expect(threadStatus({ record: {} as SessionRecord, workerTruth: truth })).toBe("Unavailable");
    expect(truth.taskOutcome).toBe("unknown");
  });
});
