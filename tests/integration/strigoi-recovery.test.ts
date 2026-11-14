import { expect, it } from "vitest";
import { faultPoints, runStrigoiFaultCase } from "../fixtures/strigoi/harness.js";

it.each(faultPoints)("production fault matrix: %s", async point => {
  const result = await runStrigoiFaultCase(point);
  expect(result.activeCount).toBeLessThanOrEqual(1);
  expect(result.samples.length).toBeGreaterThan(1);
  expect(result.residentLaunches).toBeLessThanOrEqual(result.incarnation);
  expect(result.lostInputs).toEqual([]);
  expect(result.duplicateEffects).toEqual([]);
  expect(result.diskEqual).toBe(true);
  if (/^(append|fsync|effect|intent):/.test(point)) expect(result.injected).toBe(true);
  if (result.expectedHold) expect(result.holds).toEqual([expect.objectContaining(result.expectedHold)]);
  else {
    expect(result.holds).toEqual([]);
    if (point !== "suspend") expect(result.phase).toBe(point === "abort" ? "aborted" : "complete");
  }
  if (!result.expectedHold && !["abort", "suspend"].includes(point)) {
    expect(result.oldEvidenceRetained).toBe(true);
    expect(result.workerDelivered).toBe(1);
  }
  if (point === "concurrent") { expect(result.waitStatus).toBe("cancelled"); expect(result.revokedCapabilityRestored).toBe(false); }
  if (point === "no-checkpoint") expect(result.checkpointTurns).toBe(0);
  if (point === "three-renewals") expect(result.incarnation).toBe(4);
}, 60000);
