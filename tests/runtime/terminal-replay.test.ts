import { describe, expect, it } from "vitest";
import {
  compactTerminalResult,
  latestAssistantParagraphPreview,
  providerTerminalActivity,
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
    )).toBe("blocked");
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

  it("uses the first line of the final substantive paragraph instead of timing chrome", () => {
    const replay = [
      "Earlier paragraph.",
      "",
      "The final result is ready.",
      "It is safe to resume later.",
      "",
      "Cogitated for 2m 14s",
      "Explain this codebase",
    ].join("\n");
    expect(latestAssistantParagraphPreview(replay)).toBe("The final result is ready.");
  });
});
