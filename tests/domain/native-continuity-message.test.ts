import { expect, it } from "vitest";
import { parseNativeContinuityMessage } from "../../src/domain/native-continuity-message.js";
import { parseClaudeTranscriptLine, parseCodexRolloutLine } from "../../src/domain/conversation-preview.js";

it.each(["codex", "claude"])("preserves %s instruction envelopes and exact text independently of preview filtering", (provider) => {
  const text = "<user_instructions>Never publish.\n  Keep ș😀 exactly.</user_instructions>";
  const line = JSON.stringify(provider === "codex" ? { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } }
    : { type: "user", message: { role: "user", content: [{ type: "text", text }] } });
  expect((provider === "codex" ? parseCodexRolloutLine : parseClaudeTranscriptLine)(line)).toBeUndefined();
  expect(parseNativeContinuityMessage(provider, line)).toEqual({ role: "user", text });
});
it("preserves Codex developer instructions and user events while excluding tool/reasoning payloads", () => {
  const frame = (payload: unknown, type = "response_item") => JSON.stringify({ type, payload });
  expect(parseNativeContinuityMessage("codex", frame({ type: "message", role: "developer", content: [{ type: "input_text", text: "Keep scope" }] })))
    .toEqual({ role: "developer", text: "Keep scope" });
  expect(parseNativeContinuityMessage("codex", frame({ type: "user_message", message: "<environment_context>cwd</environment_context>" }, "event_msg"))?.text)
    .toBe("<environment_context>cwd</environment_context>");
  expect(parseNativeContinuityMessage("codex", frame({ type: "function_call_output", output: "not instructions" }))).toBeUndefined();
  expect(parseNativeContinuityMessage("claude", JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "private" }] } }))).toBeUndefined();
});
