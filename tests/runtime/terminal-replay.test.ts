import { describe, expect, it } from "vitest";
import {
  compactTerminalResult,
  providerTerminalActivity,
  terminalTokenCount,
  truncateResult,
} from "../../src/runtime/terminal-replay.js";

describe("terminal replay semantics", () => {
  it("uses the latest provider title rather than stale spinner frames", () => {
    const replay = "\u001b]0;⠹ worker\u0007working\u001b]0;worker\u0007done";
    expect(providerTerminalActivity("codex", replay)).toBe("awaiting-input");
  });

  it("recognizes Cursor completion after composing without relying on its static title", () => {
    const working = "\u001b]0;Cursor Agent\u0007 Composing ctrl+c to stop";
    const complete = `${working}\n101 → 1101\n\u001b]777;notify;Cursor;Cursor is waiting for you\u0007`;
    expect(providerTerminalActivity("cursor", working)).toBe("working");
    expect(providerTerminalActivity("cursor", complete)).toBe("awaiting-input");
  });

  it("treats a Cursor slash-command overlay as idle after work instead of stranding completion", () => {
    const replay = [
      "Composing 5.53k tokens",
      "ctrl+c to stop",
      "Opened pull request #4",
      "→ /",
      "No matches",
      "/model [filter] Select model (Tab to edit)",
      "/run-everything Toggle Run Everything (currently enabled)",
    ].join("\n");
    expect(providerTerminalActivity("cursor", replay)).toBe("awaiting-input");
    expect(terminalTokenCount(replay)).toBe(5_530);
  });

  it("surfaces trust gates as blocked rather than completed", () => {
    expect(providerTerminalActivity(
      "antigravity",
      "Do you trust the contents of this project? > Yes, I trust this folder",
    )).toBe("needs-input");
  });

  it("recognizes current Codex and Claude provider approval surfaces", () => {
    const codex = [
      "Would you like to run the following command?",
      "$ pnpm test",
      "› 1. Yes, proceed (y)",
      "  2. Yes, and don't ask again for commands that start with `pnpm test` (p)",
      "  3. No, and tell Codex what to do differently (esc)",
    ].join("\n");
    const claude = [
      "Claude needs your permission to use Bash",
      "  pnpm test",
      "Do you want to proceed?",
      "❯ 1. Yes",
      "  2. Yes, and don't ask again for pnpm test commands",
      "  3. No",
      "Esc to cancel · Tab to amend",
    ].join("\n");
    expect(providerTerminalActivity("codex", codex)).toBe("needs-input");
    expect(providerTerminalActivity("claude", claude)).toBe("needs-input");
  });

  it("recognizes a dialog by the keypress it asks for, not by what it says", () => {
    // MIK-88. The onboarding wizard and the session-limit notice share no wording with each other or
    // with a permission prompt, so a detector built out of their prose saw neither: `modalOpen`
    // stayed false, the worker read `stalled`, and an instruction was written into a surface that
    // was never going to submit it. The footer is what every dialog has in common.
    const onboarding = [
      "Claude Code can scan this repository for you",
      "❯ 1. Yes",
      "  2. Not now",
      "  3. Don't show again",
      "Enter to confirm",
    ].join("\n");
    const usage = [
      "Also scan your other repos [ ]",
      "  Continue",
      "←/→ to change · Enter to confirm",
    ].join("\n");
    expect(providerTerminalActivity("claude", onboarding)).toBe("needs-input");
    expect(providerTerminalActivity("claude", usage)).toBe("needs-input");
  });

  it("reads a boxed session limit as an answerable dialog rather than a silent stall", () => {
    // The limit notice is drawn inside a border, which is exactly why the terminal `provider-limit`
    // reading never saw it: that scan only reads lines a provider prints flush left. Boxed and
    // answerable is a modal; flush left and final is a termination. This is the boxed one.
    const replay = [
      "╭──────────────────────────────────────────────╮",
      "│ You've hit your session limit · resets 10:10pm │",
      "│                                              │",
      "│ ❯ Upgrade your plan                          │",
      "│                                              │",
      "│ Enter to confirm · Esc to cancel             │",
      "╰──────────────────────────────────────────────╯",
    ].join("\n");
    expect(providerTerminalActivity("claude", replay)).toBe("needs-input");
  });

  it("does not read a working footer or an assistant sentence as a dialog", () => {
    // `esc to interrupt` and `ctrl+c to stop` are printed by a provider that would keep working if
    // nobody touched the keyboard. Only an affordance that stops the session until a key is pressed
    // is a blocked prompt, and a line has to be nothing but affordances to be read as a footer.
    expect(providerTerminalActivity("claude", "Working\nesc to interrupt")).toBe("working");
    expect(providerTerminalActivity("cursor", "Composing 12 tokens\nctrl+c to stop")).toBe("working");
    expect(providerTerminalActivity(
      "claude",
      "\u001b]0;worker\u0007I added a prompt where you press Enter to confirm the deletion.",
    )).toBe("awaiting-input");
  });

  it("clears a stale dialog when the provider resumes work behind it", () => {
    const dialog = ["Also scan your other repos [ ]", "←/→ to change · Enter to confirm"].join("\n");
    expect(providerTerminalActivity("claude", `${dialog}\nWorking\nesc to interrupt`)).toBe("working");
  });

  it("clears a stale approval surface when later provider output resumes work", () => {
    const approval = [
      "Would you like to run the following command?",
      "$ pnpm test",
      "› 1. Yes, proceed (y)",
    ].join("\n");
    expect(providerTerminalActivity("codex", `${approval}\nWorking\nesc to interrupt`)).toBe("working");
  });

  it("recognizes Antigravity's prompt footer after its spinner stops", () => {
    const working = "⣷ Thinking about the request";
    const complete = `${working}\n1127\n> Plan mode: research & plan only\n? for shortcuts plan · Gemini 3.6 Flash · low`;
    expect(providerTerminalActivity("antigravity", working)).toBe("working");
    expect(providerTerminalActivity("antigravity", complete)).toBe("awaiting-input");
  });

  it("returns a bounded useful tail instead of terminal chrome and full replay", () => {
    const replay = `${"old diagnostic line\n".repeat(500)}\u001b[2J42 + 1000 = 1042\nplan mode on`;
    const result = compactTerminalResult(replay, 240);
    expect(result).toContain("1042");
    expect(result).not.toContain("plan mode on");
    expect(result.length).toBeLessThanOrEqual(240);
  });

  it("truncates deterministically from the head with an original-length marker", () => {
    const result = truncateResult(`DECISIVE-BEGINNING-${"x".repeat(500)}-DISTINCTIVE-END`, 240);
    expect(result).toMatch(/^DECISIVE-BEGINNING-/u);
    expect(result).toContain("[elided; original length: 535 characters]");
    expect(result).not.toContain("DISTINCTIVE-END");
    expect(result).toHaveLength(240);
  });
});
