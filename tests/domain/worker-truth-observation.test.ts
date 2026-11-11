import { expect, it } from "vitest";
import { WorkerTruthObservation } from "../../src/domain/worker-truth-observation.js";
import { projectWorkerTruth } from "../../src/domain/worker-truth.js";
function truth(activity: "unknown" | "awaiting-input") { return projectWorkerTruth({ activity, executionState: "active", exitCode: null,
  composer: { occupied: false, modalOpen: false }, completedTurns: 1, canonicalTurns: 1, pendingInstructions: 0 }); }
it("does not expire quiet idle and names the last confirmed state on real observation loss", () => {
  const observation = new WorkerTruthObservation();
  expect(observation.observe(truth("awaiting-input"), 1, 1000).state).toBe("idle");
  expect(observation.observe(truth("awaiting-input"), 1, 1_000_000).state).toBe("idle");
  const lost = observation.observe(truth("unknown"), 1, 2_000_000);
  expect(lost.state).toBe("unknown"); expect(lost.lastConfirmed).toEqual({ state: "idle", at: new Date(1_000_000).toISOString() });
  expect(observation.observe(truth("unknown"), 2, 2_000_001).lastConfirmed).toBeUndefined();
});
