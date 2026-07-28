import { describe, expect, it } from "vitest";
import {
  SCOUT_CARD_BEGIN,
  SCOUT_CARD_END,
  parseScoutDecisionCard,
  scoutFramedTextFromCursorStream,
  scoutTokenCountFromCursorStream,
} from "../../src/domain/scout-output.js";

const body = [
  "QUESTION",
  "Does the transport avoid PTY interaction?",
  "VERDICT",
  "SUPPORTED",
  "BASIS",
  "direct-source",
  "FINDING",
  "The Scout command uses Cursor print mode and stream-json.",
  "EVIDENCE",
  "- src/providers/cursor/commands.ts:buildCursorScoutCommand",
  "COVERAGE",
  "Inspected command construction and session adapter routing.",
  "CAVEAT",
  "No live provider call.",
  "NEXT PROBE",
  "Run one operator-granted canary.",
].join("\n");

describe("Scout decision-card output", () => {
  it("parses compact natural-language cards without model-authored JSON", () => {
    expect(parseScoutDecisionCard([
      SCOUT_CARD_BEGIN,
      body,
      SCOUT_CARD_END,
    ].join("\n"))).toMatchObject({
      state: "complete",
      card: {
        verdict: "SUPPORTED",
        basis: "direct-source",
        evidence: ["src/providers/cursor/commands.ts:buildCursorScoutCommand"],
      },
    });
  });

  it("reassembles framed text split across stream-json events while dropping telemetry labels", () => {
    const replay = [
      JSON.stringify({ type: "assistant", delta: { text: SCOUT_CARD_BEGIN } }),
      JSON.stringify({ type: "assistant", delta: { text: body } }),
      JSON.stringify({ type: "assistant", delta: { text: SCOUT_CARD_END } }),
    ].join("\n");
    const framed = scoutFramedTextFromCursorStream(replay);

    expect(framed).not.toContain("assistant");
    expect(parseScoutDecisionCard(framed)).toMatchObject({
      state: "complete",
      card: { verdict: "SUPPORTED" },
    });
  });

  it("derives the largest cumulative token observation from provider usage fields", () => {
    const replay = [
      JSON.stringify({ usage: { input_tokens: 400, output_tokens: 100 } }),
      JSON.stringify({ result: { usage: { totalTokens: 875 } } }),
    ].join("\n");
    expect(scoutTokenCountFromCursorStream(replay)).toBe(875);
  });
});
