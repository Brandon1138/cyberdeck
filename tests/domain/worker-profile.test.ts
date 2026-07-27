import { describe, expect, it } from "vitest";
import {
  MAX_SCOUT_REPORT_BYTES,
  ScoutBriefSchema,
  ScoutReportSchema,
  resolveScoutEffectiveState,
} from "../../src/domain/worker-profile.js";

const brief = {
  objective: "Locate session launch policy",
  scope: ["src/broker/**", "src/providers/cursor/**"],
  questions: ["Where is read-only mode selected?"],
  stopCondition: "Answer question with source evidence",
  budget: { maxWallClockMs: 60_000, maxTokens: 8_000 },
};

describe("Scout worker profile contracts", () => {
  it("resolves fixed Tier 1 Composer state and defaults lease policy", () => {
    expect(resolveScoutEffectiveState()).toEqual({
      lifecycle: "worker",
      profile: "scout",
      tier: 1,
      provider: "cursor",
      model: "composer",
      permissions: "read-only",
      approvalMode: "auto",
      leasePolicy: "expire-and-discard",
    });
    expect(resolveScoutEffectiveState("orphan-for-adoption").leasePolicy)
      .toBe("orphan-for-adoption");
  });

  it("requires narrow objective, scope, questions, stop condition, and both budgets", () => {
    expect(ScoutBriefSchema.parse(brief)).toEqual(brief);
    expect(() => ScoutBriefSchema.parse({ ...brief, scope: [] })).toThrow();
    expect(() => ScoutBriefSchema.parse({
      ...brief,
      budget: { maxWallClockMs: 60_000 },
    })).toThrow();
  });

  it("rejects unreferenced findings and accepts path plus symbol or line-range evidence", () => {
    expect(() => ScoutReportSchema.parse({
      findings: [{ finding: "Policy lives in adapter", evidence: [] }],
      coverage: { searched: ["src/providers"], methods: ["rg"] },
      uncertainties: [],
      suggestedFollowUpProbes: [],
    })).toThrow();

    expect(ScoutReportSchema.parse({
      findings: [{
        finding: "Plan mode enforces inspection-only execution",
        evidence: [{
          path: "src/providers/cursor/commands.ts",
          symbol: "cursorSafetyArgs",
          lineRange: { start: 57, end: 67 },
        }],
      }],
      coverage: {
        searched: ["src/providers/cursor/**"],
        methods: ["rg read-only; inspected command builder"],
      },
      uncertainties: ["Live provider behavior not probed"],
      suggestedFollowUpProbes: ["Run denied-write canary"],
    }).findings).toHaveLength(1);
  });

  it("rejects reports too large for canonical replay capture", () => {
    const oversized = {
      findings: [{
        finding: "Oversized evidence set",
        evidence: Array.from({ length: 16 }, (_, index) => ({
          path: `${index}-${"x".repeat(4_000)}`,
          symbol: "y".repeat(4_000),
        })),
      }],
      coverage: { searched: ["src/**"], methods: ["read"] },
      uncertainties: [],
      suggestedFollowUpProbes: [],
    };
    expect(Buffer.byteLength(JSON.stringify(oversized, null, 2))).toBeGreaterThan(
      MAX_SCOUT_REPORT_BYTES,
    );
    expect(() => ScoutReportSchema.parse(oversized)).toThrow("must not exceed");
  });
});
