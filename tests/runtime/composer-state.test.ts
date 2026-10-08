import { describe, expect, it } from "vitest";
import { terminalComposerState } from "../../src/runtime/composer-state.js";

const CLEAR = "\u001b[2J";

describe("terminalComposerState", () => {
  it("reads the hint Claude prints under a composer holding unsent text", () => {
    // The exact screen from the MIK-64 report: the instruction was written at the PTY while a
    // permission modal was up, and this line is what the operator saw underneath it.
    const replay = [
      `${CLEAR}Claude needs your permission to use Bash`,
      "│ > Run the integration suite and report back │",
      "tab to queue message",
    ].join("\n");

    expect(terminalComposerState("claude", replay, { modalOpen: true })).toMatchObject({
      modalOpen: true,
      occupied: true,
      evidence: "tab to queue message",
    });
  });

  it("reads text drawn inside the composer box for a provider with no hint of its own", () => {
    const replay = `${CLEAR}some earlier output\n│ › resume the migration │\n`;

    expect(terminalComposerState("codex", replay)).toMatchObject({
      occupied: true,
      evidence: "resume the migration",
    });
  });

  it("does not read an empty composer's placeholder as unsent text", () => {
    // A false positive here holds every instruction the broker is asked to deliver, so the
    // placeholder list is load-bearing rather than cosmetic.
    for (const placeholder of [
      "Try \"fix the failing test\"",
      "Ask Codex to do something",
      "Describe a task for a new session",
      "/help for commands",
    ]) {
      expect(terminalComposerState("codex", `${CLEAR}output\n│ › ${placeholder} │\n`).occupied)
        .toBe(false);
    }
  });

  it("ignores the hint when it appears in an older frame", () => {
    // Only the last cleared screen is current state; everything before it is scrollback.
    const replay = [
      `${CLEAR}tab to queue message`,
      `${CLEAR}the follow-up ran and finished`,
    ].join("\n");

    expect(terminalComposerState("claude", replay).occupied).toBe(false);
  });

  it("does not treat an assistant paragraph quoting the hint as evidence about the UI", () => {
    const replay = `${CLEAR}⏺ Claude shows "tab to queue message" when the composer has text.\n`;

    expect(terminalComposerState("claude", replay).occupied).toBe(false);
  });

  it("reads Codex's bare composer line and hands back what it holds", () => {
    // The screen from MIK-260: Codex 0.161 draws no box, and the submitted history prompt above
    // uses the very same glyph. Position decides — the composer is the line above the footer.
    const replay = [
      `${CLEAR}› earlier prompt that was submitted`,
      "• Done. Nothing else to do.",
      "",
      "› Standby.",
      "  tab to queue message                               100% context left",
    ].join("\n");

    expect(terminalComposerState("codex", replay)).toMatchObject({
      occupied: true,
      evidence: "Standby.",
      content: "Standby.",
    });
  });

  it("reads a wrapped Codex draft through its indented continuation lines", () => {
    const replay = [
      `${CLEAR}• Earlier answer.`,
      "› Re-run the failing suite and report which",
      "  assertions changed since the last green run.",
      "  ? for shortcuts                                    97% context left",
    ].join("\n");

    expect(terminalComposerState("codex", replay)).toMatchObject({
      occupied: true,
      content: "Re-run the failing suite and report which",
    });
  });

  it("reads a Codex draft that happens to mention footer words", () => {
    // The prompt glyph wins over any footer token on the same line; otherwise a draft like this
    // would be skipped as chrome, read as occupied only by hint, and never re-submitted.
    const replay = [
      `${CLEAR}• Earlier answer.`,
      "› Switch to Plan mode · then report every ⚠ warning",
      "  tab to queue message                               99% context left",
    ].join("\n");

    expect(terminalComposerState("codex", replay)).toMatchObject({
      occupied: true,
      content: "Switch to Plan mode · then report every ⚠ warning",
    });
  });

  it("does not read Codex's empty bare composer or its placeholder as unsent text", () => {
    const replay = [
      `${CLEAR}› earlier prompt that was submitted`,
      "• Done.",
      "› Ask Codex to do anything",
      "  ? for shortcuts                                   100% context left",
    ].join("\n");

    expect(terminalComposerState("codex", replay).occupied).toBe(false);
  });

  it("does not read a submitted Codex prompt as the composer when something else is at the bottom", () => {
    // A picker or dialog replaces the composer; the last `›` line is then history, not a draft.
    const replay = [
      `${CLEAR}› earlier prompt that was submitted`,
      "• Working on it.",
      "Select a model",
      "  1. gpt-6.1-sol",
    ].join("\n");

    expect(terminalComposerState("codex", replay).occupied).toBe(false);
  });

  it("reads Codex's own queue hint when the composer line itself is not readable", () => {
    const replay = `${CLEAR}output\n│ typing… │\ntab to queue message        100% context left\n`;

    expect(terminalComposerState("codex", replay)).toMatchObject({
      occupied: true,
      evidence: "tab to queue message        100% context left",
    });
  });

  it("reports a clear composer for an idle screen", () => {
    expect(terminalComposerState("claude", `${CLEAR}All checks passed.\n`)).toEqual({
      modalOpen: false,
      occupied: false,
    });
  });
});
