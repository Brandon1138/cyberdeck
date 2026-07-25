import { describe, expect, it } from "vitest";
import {
  compactTerminalResult,
  latestAssistantParagraphPreview,
  providerTerminalActivity,
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

  it("uses the beginning of the latest assistant reply instead of its final paragraph", () => {
    const replay = [
      "› Summarize the result",
      "",
      "The reply begins here and should be previewed.",
      "",
      "The final result is ready.",
      "It is safe to resume later.",
      "",
      "Cogitated for 2m 14s",
      "Explain this codebase",
    ].join("\n");
    expect(latestAssistantParagraphPreview(replay)).toBe("The reply begins here and should be previewed.");
  });

  it("uses the latest reply when terminal replay contains multiple user turns", () => {
    const replay = [
      "› First request",
      "First reply.",
      "› Second request",
      "Second reply starts here.",
      "",
      "Second reply ending.",
    ].join("\n");
    expect(latestAssistantParagraphPreview(replay)).toBe("Second reply starts here.");
  });

  it("falls back to the latest substantive paragraph when a provider omits prompt markers", () => {
    const replay = [
      "Old terminal output.",
      "",
      "The only recoverable latest paragraph.",
      "",
      "Worked for 12s",
    ].join("\n");
    expect(latestAssistantParagraphPreview(replay)).toBe("The only recoverable latest paragraph.");
  });

  it("skips Codex startup tips and their wrapped landing-page URL", () => {
    const replay = [
      "Tip: Try the Desktop app. Run 'codex app' or visit",
      "https://chatgpt.com/codex?app-landing-page=true",
    ].join("\n");
    expect(latestAssistantParagraphPreview(replay)).toBe("No response yet");
  });

  it("skips decorated timing rules while keeping the beginning of the reply", () => {
    const replay = [
      "› Implement the Fleet fixes",
      "The Fleet fixes are implemented.",
      "",
      "Additional verification details.",
      "",
      "─ Worked for 12m 25s ────────────────────────────────────",
    ].join("\n");
    expect(latestAssistantParagraphPreview(replay)).toBe("The Fleet fixes are implemented.");
  });
});
