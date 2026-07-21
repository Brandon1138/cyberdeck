import { describe, expect, it } from "vitest";
import { BudgetLedger } from "../../src/control-plane/budget-ledger.js";
import type { BudgetDeclaration } from "../../src/domain/budget.js";

const BASE = Date.parse("2026-07-21T00:00:00.000Z");

function ledgerAt(declaration: Partial<BudgetDeclaration>, clock: { ms: number }): BudgetLedger {
  return new BudgetLedger({
    declaration: { schemaVersion: 1, ...declaration },
    now: () => new Date(BASE + clock.ms).toISOString(),
  });
}

function ledger(declaration: Partial<BudgetDeclaration> = {}): BudgetLedger {
  return ledgerAt(declaration, { ms: 0 });
}

describe("budget ledger", () => {
  it("admits jobs until the declared job ceiling is reached", () => {
    const budgets = ledger({ maxJobs: 2 });
    expect(budgets.admit("root", "root")).toEqual({ ok: true });
    expect(budgets.admit("root", "child-1")).toEqual({ ok: true });
    expect(budgets.admit("root", "child-2")).toEqual({
      ok: false,
      code: "BUDGET_EXCEEDED",
      reason: "MAX_JOBS",
    });
  });

  it("counts each job exactly once no matter how often admission is retried", () => {
    const budgets = ledger({ maxJobs: 2 });
    budgets.admit("root", "root");
    budgets.admit("root", "root");
    budgets.admit("root", "root");
    expect(budgets.usage("root").jobsStarted).toBe(1);
    expect(budgets.admit("root", "second")).toEqual({ ok: true });
  });

  it("keeps sibling scopes independent", () => {
    const budgets = ledger({ maxJobs: 1 });
    expect(budgets.admit("scope-a", "a").ok).toBe(true);
    expect(budgets.admit("scope-b", "b").ok).toBe(true);
    expect(budgets.admit("scope-a", "a2").ok).toBe(false);
  });

  it("reconciles a delegated child's debits to its parent scope exactly once", () => {
    const budgets = ledger({});
    budgets.admit("root", "root");
    budgets.admit("root", "child");
    budgets.settle("root", "child", {
      usage: { schemaVersion: 1, totalTokens: 120 },
      artifactBytes: 64,
    });
    budgets.settle("root", "child", {
      usage: { schemaVersion: 1, totalTokens: 120 },
      artifactBytes: 64,
    });

    const usage = budgets.usage("root");
    expect(usage.jobsStarted).toBe(2);
    expect(usage.jobsSettled).toBe(1);
    expect(usage.totalTokens).toBe(120);
    expect(usage.artifactBytes).toBe(64);
  });

  it("sums reported input and output tokens when no total is given", () => {
    const budgets = ledger({});
    budgets.admit("root", "job");
    budgets.settle("root", "job", {
      usage: { schemaVersion: 1, inputTokens: 30, outputTokens: 12 },
    });
    expect(budgets.usage("root").totalTokens).toBe(42);
  });

  it("treats unreported usage as unknown, never as zero", () => {
    const budgets = ledger({});
    budgets.admit("root", "job");
    budgets.settle("root", "job", {});

    const usage = budgets.usage("root");
    expect(usage.totalTokens).toBeUndefined();
    expect(usage.jobsWithUnknownUsage).toBe(1);
  });

  it("fails closed when a declared token ceiling cannot be proven", () => {
    const budgets = ledger({ maxTotalTokens: 1_000 });
    budgets.admit("root", "job");
    budgets.settle("root", "job", {});

    expect(budgets.admit("root", "next")).toEqual({
      ok: false,
      code: "BUDGET_EXCEEDED",
      reason: "UNPROVABLE_TOKEN_USAGE",
    });
  });

  it("does not fail closed on unknown usage when no token ceiling was declared", () => {
    const budgets = ledger({ maxJobs: 5 });
    budgets.admit("root", "job");
    budgets.settle("root", "job", {});
    expect(budgets.admit("root", "next").ok).toBe(true);
  });

  it("refuses admission once reported tokens reach the declared ceiling", () => {
    const budgets = ledger({ maxTotalTokens: 100 });
    budgets.admit("root", "job");
    budgets.settle("root", "job", { usage: { schemaVersion: 1, totalTokens: 100 } });

    expect(budgets.admit("root", "next")).toEqual({
      ok: false,
      code: "BUDGET_EXCEEDED",
      reason: "MAX_TOTAL_TOKENS",
    });
  });

  it("refuses admission once persisted artifact bytes reach the declared ceiling", () => {
    const budgets = ledger({ maxArtifactBytes: 128 });
    budgets.admit("root", "job");
    budgets.settle("root", "job", { artifactBytes: 128 });

    expect(budgets.admit("root", "next")).toEqual({
      ok: false,
      code: "BUDGET_EXCEEDED",
      reason: "MAX_ARTIFACT_BYTES",
    });
  });

  it("refuses admission once the scope's elapsed wall clock is spent", () => {
    const clock = { ms: 0 };
    const budgets = ledgerAt({ maxWallClockMs: 5_000 }, clock);
    expect(budgets.admit("root", "first").ok).toBe(true);
    clock.ms = 4_999;
    expect(budgets.admit("root", "second").ok).toBe(true);
    clock.ms = 5_000;
    expect(budgets.admit("root", "third")).toEqual({
      ok: false,
      code: "BUDGET_EXCEEDED",
      reason: "MAX_WALL_CLOCK_MS",
    });
  });

  it("reports elapsed wall clock and exhaustion for control-plane queries", () => {
    const clock = { ms: 0 };
    const budgets = ledgerAt({ maxJobs: 1 }, clock);
    budgets.admit("root", "job");
    clock.ms = 2_500;

    const usage = budgets.usage("root");
    expect(usage.wallClockMs).toBe(2_500);
    expect(budgets.report().scopes).toEqual([
      expect.objectContaining({ scopeId: "root", exhausted: true, reason: "MAX_JOBS" }),
    ]);
  });

  it("reports an unstarted scope as unknown rather than fabricating usage", () => {
    const budgets = ledger({});
    const usage = budgets.usage("never-started");
    expect(usage.jobsStarted).toBe(0);
    expect(usage.totalTokens).toBeUndefined();
    expect(budgets.report().scopes).toEqual([]);
  });
});
