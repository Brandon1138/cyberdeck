import { describe, expect, it } from "vitest";
import {
  compactTerminalResult,
  providerTerminalActivity,
  terminalTokenCount,
  truncateResult,
} from "../../src/runtime/terminal-replay.js";
import { WorkerTurnObservationAdapter } from "../../src/runtime/worker-turn-observation-adapter.js";
import {
  CODEX_DIRECTORY_TRUST,
  CODEX_FOLDER_ACCESS,
  CODEX_FOLDER_ACCESS_EXISTING_TASK,
  CODEX_FOLDER_ACCESS_RESTRICTED,
  CODEX_FOLDER_ACCESS_SUBDIRECTORY,
  CODEX_HOOK_REVIEW,
  CODEX_HOOK_REVIEW_0_153,
  codexRendered,
} from "../fixtures/provider-startup-dialogs.js";
import { PROVIDER_SCREENS, redraw } from "./provider-screen-fixtures.js";

describe("terminal replay semantics", () => {
  it.each(["codex", "claude"] as const)("recognizes %s busy controls after ED2 preserves a nonzero row and column", (provider) => {
    const replay = "\u001b[8;11Hprevious screen\u001b]0;⠹ busy\u0007\u001b[2JWorking\r\n   esc to interrupt";
    expect(providerTerminalActivity(provider, replay)).toBe("working");
  });

  it.each(PROVIDER_SCREENS)("recognizes indented $provider permission controls after a clear without home", ({ provider, modal }) => {
    const replay = "\u001b[8;11Hprevious screen\u001b[2J" + modal.map((row) => `   ${row}`).join("\r\n");
    expect(providerTerminalActivity(provider, replay)).toBe("needs-input");
  });

  it("recognizes a partial Claude trust gate below blank rows left by ED2", () => {
    const replay = "\u001b[8;11Hprevious screen\u001b[2JQuick safety check: Is this a project you created or one you trust?\r\n❯ ";
    expect(providerTerminalActivity("claude", replay)).toBe("needs-input");
  });

  it("recognizes Antigravity's current composing spinner and indented stop controls", () => {
    const replay = "\u001b[8;11Hprevious screen\u001b]0;⠹ Working\u0007\u001b[2J   ⠹ Composing\r\n   esc to interrupt";
    expect(providerTerminalActivity("antigravity", replay)).toBe("working");
  });

  it("keeps an empty composer and shortcut footer out of terminal result text", () => {
    for (const composer of ["│ > │", "› ", "❯ "]) {
      const replay = `\u001b[2J\u001b[Hactual provider answer\r\n${composer}\r\n? for shortcuts  100% context left\r\n`;
      expect(compactTerminalResult(replay)).toBe("actual provider answer");
    }
  });

  it.each(PROVIDER_SCREENS)("uses only the currently rendered $provider UI across modal, work and idle clears", ({ provider, modal, working, idle }) => {
    const blocked = redraw(modal);
    const resumed = blocked + redraw(working);
    const ready = resumed + redraw(idle);
    expect(providerTerminalActivity(provider, blocked)).toBe("needs-input");
    expect(providerTerminalActivity(provider, resumed)).toBe("working");
    expect(providerTerminalActivity(provider, ready)).toBe("awaiting-input");
  });

  it.each(["claude", "codex"] as const)("orders %s titles against current working and cleared idle UI", (provider) => {
    const staticTitle = "\u001b]0;workspace\u0007";
    const spinnerTitle = "\u001b]0;⠋ Working\u0007";
    const currentWork = staticTitle + redraw(["Working…", "esc to interrupt"]);
    expect(providerTerminalActivity(provider, currentWork)).toBe("working");
    const idle = PROVIDER_SCREENS.find((fixture) => fixture.provider === provider)!.idle;
    expect(providerTerminalActivity(provider, currentWork + spinnerTitle + redraw(idle))).toBe("awaiting-input");
    expect(providerTerminalActivity(provider, staticTitle)).toBe("unknown");
  });

  it.each(PROVIDER_SCREENS)("does not infer $provider modals or activity from assistant prose", ({ provider }) => {
    for (const prose of [
      "I fixed the permission prompt parsing.",
      "The workspace-trust option needs authentication in the docs.",
      "Working on the permission prompt parsing was useful.",
      "• I fixed the esc to interrupt footer parsing.",
      "Enter to confirm",
      "The text says: Would you like to run the following command? Yes, proceed.",
    ]) {
      expect(providerTerminalActivity(provider, redraw([prose]))).toBe("unknown");
    }
  });

  it.each(["codex", "claude"] as const)("does not borrow Cursor's idle wording for %s", (provider) => {
    expect(providerTerminalActivity(provider, redraw(["Add a follow-up"]))).toBe("unknown");
  });

  it.each(PROVIDER_SCREENS)("keeps unsupported $provider screen edits unknown until a full clear", ({ provider, idle, working }) => {
    const unsupported = redraw(idle) + "\u001b[1P";
    expect(providerTerminalActivity(provider, unsupported)).toBe("unknown");
    expect(providerTerminalActivity(provider, unsupported + redraw(working))).toBe("working");
  });

  it("does not infer readiness from a static title and assistant text", () => {
    const replay = "\u001b]0;⠹ worker\u0007working\u001b]0;worker\u0007done";
    expect(providerTerminalActivity("codex", replay)).toBe("unknown");
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

  it("surfaces Codex's startup dialogs as blocked however ratatui placed their words", () => {
    // Their footers ("enter continue · esc quit", "enter confirm · esc skip") give the affordance
    // grammar no "to" to key on, and the restricted variants must block too: nothing answers them.
    // Codex 0.120 through 0.153 asks in a paragraph that says "Working", and a folder path can too:
    // both are working markers drawn inside the dialog, not the provider working.
    const adapter = new WorkerTurnObservationAdapter();
    for (const frame of [
      CODEX_FOLDER_ACCESS,
      CODEX_FOLDER_ACCESS.replace("/workspace/project", "/Users/op/Working/project"),
      CODEX_FOLDER_ACCESS_SUBDIRECTORY,
      CODEX_FOLDER_ACCESS_RESTRICTED,
      CODEX_FOLDER_ACCESS_EXISTING_TASK,
      CODEX_HOOK_REVIEW,
      CODEX_HOOK_REVIEW_0_153,
      CODEX_DIRECTORY_TRUST,
    ]) {
      for (const rendered of [codexRendered(frame), codexRendered(frame, "rows")]) {
        expect(providerTerminalActivity("codex", rendered)).toBe("needs-input");
        const replay = adapter.createReplay(128 * 1024);
        replay.appendBytes(Buffer.from(rendered));
        expect(adapter.activity("codex", replay)).toBe("needs-input");
      }
    }
  });

  it("lets Codex's working status after a startup dialog read as working", () => {
    for (const frame of [CODEX_FOLDER_ACCESS, CODEX_DIRECTORY_TRUST]) {
      const answered = `${codexRendered(frame)}\u001b[2J\u001b[1;1H• Working (2s • esc to interrupt)`;
      expect(providerTerminalActivity("codex", answered)).toBe("working");
    }
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
    )).toBe("unknown");
  });

  it("does not read flush-left prose that opens with an affordance as a dialog", () => {
    // Both footer patterns used to anchor only at the start, so a completed response whose last line
    // opened with a keypress and continued as a sentence read as a footer. That is not hypothetical:
    // it projected `needs-input` on a worker that was actively writing files, and every
    // `workers_wait` on it settled instantly and uselessly. A segment has to validate whole.
    for (const prose of [
      "Press Enter to continue installing dependencies, then rerun tests.",
      "Esc to cancel is also available.",
      "Enter to confirm the deletion once you have reviewed the plan above.",
      "Press Enter to select the branch you want, then push it when the build is green.",
      "←/→ to change the sort order is documented in the README.",
    ]) {
      expect(providerTerminalActivity("claude", `\u001b]0;worker\u0007Done.\n${prose}`))
        .toBe("unknown");
    }
  });

  it("still reads a footer whose action carries a qualifier or a full stop", () => {
    // The prose bound is three words and no sentence punctuation, not "one bare verb" — narrowing it
    // past what real footers print would trade the false positive above for the incident it replaces.
    for (const footer of [
      "Press Enter to continue.",
      "Enter to confirm (default)",
      "Enter to select · Esc to go back",
      "Enter to confirm │ Esc to cancel",
    ]) {
      expect(providerTerminalActivity("claude", `Also scan your other repos [ ]\n${footer}`))
        .toBe("needs-input");
    }
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
