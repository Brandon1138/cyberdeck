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

  it("declares an optional per-repository concurrency limit", () => {
    const decl = ConcurrencyDeclarationSchema.parse({ maxConcurrentPerRepository: 1 });
    expect(decl.maxConcurrentPerRepository).toBe(1);
    expect(() => ConcurrencyDeclarationSchema.parse({ maxConcurrentPerRepository: 0 })).toThrow();
  });

  it("declares only measurable ceilings", () => {
    const decl = BudgetDeclarationSchema.parse({
      maxJobs: 10,
      maxWallClockMs: 60_000,
      maxTotalTokens: 100_000,
      maxArtifactBytes: 1_024,
    });
    expect(decl.maxTotalTokens).toBe(100_000);
    expect(decl.maxArtifactBytes).toBe(1_024);
    expect(() => BudgetDeclarationSchema.parse({ maxTotalTokens: -1 })).toThrow();
  });

  it("keeps unreported token usage unknown rather than zero", () => {
    const usage = BudgetUsageSchema.parse({
      jobsStarted: 1,
      jobsSettled: 1,
      wallClockMs: 10,
      artifactBytes: 0,
      jobsWithUnknownUsage: 1,
      updatedAt: "2026-07-21T00:00:00.000Z",
    });
    expect(usage.totalTokens).toBeUndefined();
    expect(usage.jobsWithUnknownUsage).toBe(1);
    expect(usage.artifactBytes).toBe(0);
  });
});
