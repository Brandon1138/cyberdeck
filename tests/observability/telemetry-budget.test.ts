import { expect, it } from "vitest";
import { TelemetryBudget } from "../../src/observability/telemetry-budget.js";
it("enforces explicit caps and consistent run sampling without an invented free-tier allowance", () => {
  let now = 0; const budget = new TelemetryBudget(2, 1, () => now);
  expect([budget.admit("run"), budget.admit("run"), budget.admit("run")]).toEqual([true, true, false]);
  now = 86400000; expect(budget.admit("run")).toBe(true);
  expect(new TelemetryBudget(0, 1).admit("run")).toBe(false);
  const sampled = new TelemetryBudget(100, 0.1);
  expect(sampled.admit("same")).toBe(sampled.admit("same"));
});
