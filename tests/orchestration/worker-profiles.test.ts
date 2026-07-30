import { describe, expect, it } from "vitest";
import { scoutDispatchPrompt } from "../../src/orchestration/worker-profiles.js";

describe("Scout dispatch prompt", () => {
  it("prioritizes useful early finalization and omits deprecated token authority", () => {
    const prompt = scoutDispatchPrompt({
      objective: "Answer scoped question",
      scope: ["src/**"],
      questions: ["Where is policy enforced?"],
      stopCondition: "Return supported answer",
      budget: { maxWallClockMs: 60_000, maxTokens: 1 },
    });

    expect(prompt).toContain("Inspect highest-signal scoped symbols first.");
    expect(prompt).toContain("Use at most 70% of wall time for search");
    expect(prompt).toContain("when the budget permits, reserve at least 15 seconds for finalization");
    expect(prompt).toContain("BLOCKED and INCONCLUSIVE are valid outcomes");
    expect(prompt).toContain("Any later replacement must be complete and self-contained.");
    expect(prompt).toContain("At the margin, stop tools and emit the best supported valid card.");
    expect(prompt).toContain("Do not call createPlan");
    expect(prompt).toContain("normal assistant text response");
    expect(prompt).toContain("3,500 characters");
    expect(prompt).toContain("at most 8 evidence bullets");
    expect(prompt).not.toContain("token guard");
    expect(prompt).not.toContain("maxTokens");
  });
});
