import { describe, expect, it } from "vitest";
import {
  BudgetDeclarationSchema,
  BudgetUsageSchema,
  ConcurrencyDeclarationSchema,
} from "../../src/domain/budget.js";

describe("concurrency and budget declarations", () => {
  it("declares optional concurrency limits per provider", () => {
    const decl = ConcurrencyDeclarationSchema.parse({
      maxConcurrentJobs: 4,
      maxConcurrentPerProvider: { codex: 2, claude: 1 },
    });
    expect(decl.maxConcurrentJobs).toBe(4);
    expect(decl.maxConcurrentPerProvider?.codex).toBe(2);
  });

  it("declares optional budget ceilings and rejects non-positive limits", () => {
    const decl = BudgetDeclarationSchema.parse({ maxJobs: 10, maxWallClockMs: 60_000 });
    expect(decl.maxWallClockMs).toBe(60_000);
    expect(() => BudgetDeclarationSchema.parse({ maxJobs: 0 })).toThrow();
  });

  it("records usage without prescribing scheduling", () => {
    const usage = BudgetUsageSchema.parse({
      jobsStarted: 3,
      jobsSettled: 1,
      wallClockMs: 1_200,
      updatedAt: "2026-07-21T00:00:00.000Z",
    });
    expect(usage.jobsStarted).toBe(3);
  });
});
