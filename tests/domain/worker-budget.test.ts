import { describe, expect, it } from "vitest";
import {
  WorkerBudgetDeclarationSchema,
  WorkerBudgetRecordSchema,
  createWorkerBudgetRecord,
  workerBudgetEnforcementTransitionAllowed,
  workerBudgetReading,
  workerBudgetThresholdEnforcement,
} from "../../src/domain/worker-budget.js";

const NOW = "2026-08-24T10:00:00.000Z";

function declaration(
  unit: "percent" | "tokens" | "wall-clock-ms" = "percent",
  amount = 20,
) {
  return WorkerBudgetDeclarationSchema.parse({
    resource: unit === "percent" ? "weekly" : "session",
    allocation: { unit, amount },
  });
}

describe("worker budget domain", () => {
  it("applies explicit soft and hard policy defaults", () => {
    expect(declaration()).toMatchObject({
      schemaVersion: 1,
      policy: {
        softLimitRatio: 0.8,
        hardLimitRatio: 1,
        softAction: "wrap-up",
        hardAction: "stop",
      },
    });
  });

  it("rejects percent allocations above provider total", () => {
    expect(() => declaration("percent", 101)).toThrow(
      "percent budget allocation cannot exceed 100",
    );
  });

  it("preserves unknown consumption instead of inventing zero", () => {
    const budget = createWorkerBudgetRecord(declaration(), NOW);
    expect(workerBudgetReading(budget)).toEqual({
      status: "unknown",
      allocatedAmount: 20,
      unit: "percent",
      reason: "No compatible broker measurement has been observed",
    });
  });

  it("computes remaining allocation only for matching units", () => {
    const budget = WorkerBudgetRecordSchema.parse({
      ...createWorkerBudgetRecord(declaration("tokens", 1_000), NOW),
      measurement: {
        status: "known",
        unit: "tokens",
        amount: 810,
        source: "terminal-token-counter",
        quality: "approximate",
        observedAt: NOW,
        staleAfterMs: 60_000,
      },
    });
    expect(workerBudgetReading(budget)).toEqual({
      status: "known",
      allocatedAmount: 1_000,
      consumedAmount: 810,
      remainingAmount: 190,
      unit: "tokens",
      ratio: 0.81,
      softLimitReached: true,
      hardLimitReached: false,
    });
    expect(workerBudgetThresholdEnforcement(budget, NOW)).toEqual({
      state: "soft-pending",
      revision: 1,
      reachedAt: NOW,
    });
  });

  it("never converts wall clock into tokens", () => {
    const budget = WorkerBudgetRecordSchema.parse({
      ...createWorkerBudgetRecord(declaration("tokens", 1_000), NOW),
      measurement: {
        status: "known",
        unit: "wall-clock-ms",
        amount: 500,
        source: "wall-clock",
        quality: "exact",
        observedAt: NOW,
        staleAfterMs: 60_000,
      },
    });
    expect(workerBudgetReading(budget)).toEqual({
      status: "unknown",
      allocatedAmount: 1_000,
      unit: "tokens",
      reason: "Measurement unit wall-clock-ms does not match allocation unit tokens",
    });
  });

  it("allows only forward enforcement transitions", () => {
    expect(workerBudgetEnforcementTransitionAllowed("active", "soft-pending")).toBe(true);
    expect(workerBudgetEnforcementTransitionAllowed("soft-pending", "soft-notified")).toBe(true);
    expect(workerBudgetEnforcementTransitionAllowed("soft-notified", "hard-reached")).toBe(true);
    expect(workerBudgetEnforcementTransitionAllowed("hard-reached", "hard-stop-requested"))
      .toBe(true);
    expect(workerBudgetEnforcementTransitionAllowed("soft-notified", "active")).toBe(false);
    expect(workerBudgetEnforcementTransitionAllowed("hard-stop-requested", "hard-reached"))
      .toBe(false);
  });
});
