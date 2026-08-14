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

  it("reports a clear composer for an idle screen", () => {
    expect(terminalComposerState("claude", `${CLEAR}All checks passed.\n`)).toEqual({
      modalOpen: false,
      occupied: false,
    });
  });
});
