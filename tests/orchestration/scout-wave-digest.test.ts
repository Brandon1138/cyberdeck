import { describe, expect, it } from "vitest";
import { renderScoutDecisionCard, type ScoutDecisionCard } from "../../src/domain/scout-output.js";
import { projectScoutWave } from "../../src/orchestration/scout-wave-digest.js";
import type { WorkerResultSnapshot } from "../../src/broker/session-registry.js";

const FIRST = "11111111-1111-4111-8111-111111111111";
const SECOND = "22222222-2222-4222-8222-222222222222";
const THIRD = "33333333-3333-4333-8333-333333333333";

function card(
  verdict: ScoutDecisionCard["verdict"],
  finding: string,
): ScoutDecisionCard {
  return {
    question: "Does the trust gate explain launch failure?",
    verdict,
    basis: "direct-source",
    finding,
    evidence: ["src/providers/cursor/commands.ts:buildCursorScoutCommand"],
    coverage: "Inspected Cursor launch construction.",
  };
}

function result(sessionId: string, value: ScoutDecisionCard): WorkerResultSnapshot {
  return {
    sessionId,
    provider: "cursor",
    model: "composer",
    profile: "scout",
    status: "completed",
    completedTurns: 1,
    text: renderScoutDecisionCard(value),
  };
}

describe("Scout wave digest", () => {
  it("promotes contradictions and novel findings while returning drill-down handles", () => {
    const projection = projectScoutWave([
      {
        sessionId: FIRST,
        hypothesisId: "trust-gate",
        result: result(FIRST, card("SUPPORTED", "Fresh state blocks without trust.")),
      },
      {
        sessionId: SECOND,
        hypothesisId: "trust-gate",
        result: result(SECOND, card("REFUTED", "The failure occurs after trust is accepted.")),
      },
      {
        sessionId: THIRD,
        hypothesisId: "transport",
        result: result(THIRD, card("NEW_FINDING", "PTY completion scraping is the unstable seam.")),
      },
    ]);

    expect(projection?.digest).toMatchObject({
      scoutCount: 3,
      hypothesisCount: 2,
      contradictionCount: 1,
      surpriseCount: 1,
      handles: expect.arrayContaining([
        expect.objectContaining({
          sessionId: FIRST,
          card: `scout://${FIRST}/card`,
          evidence: `scout://${FIRST}/evidence`,
          trace: `scout://${FIRST}/trace`,
        }),
      ]),
    });
    expect(projection?.digest.text).toContain("CONFLICT");
    expect(projection?.digest.text).toContain("PTY completion scraping");
    expect(projection?.results[0]!.text).toBe(
      "SUPPORTED · direct-source · Fresh state blocks without trust.",
    );
    expect(projection?.results[0]!.text).not.toContain("EVIDENCE");
  });
});
