import { describe, expect, it } from "vitest";
import {
  observedModelParser,
  parseClaudeModelLine,
  parseCodexModelLine,
} from "../../src/runtime/observed-model.js";

describe("observed model", () => {
  it("reads the model and effort a Claude assistant frame ran with", () => {
    const line = JSON.stringify({
      type: "assistant",
      isSidechain: false,
      timestamp: "2026-08-16T09:00:00.000Z",
      effort: "high",
      message: { role: "assistant", model: "claude-opus-5", content: [{ type: "text", text: "hi" }] },
    });
    expect(parseClaudeModelLine(line)).toEqual({
      model: "claude-opus-5",
      effort: "high",
      observedAt: "2026-08-16T09:00:00.000Z",
    });
  });

  it("ignores frames that cannot speak for the session's own model", () => {
    // A subagent runs whatever it was dispatched with; a user frame names nothing; a Claude
    // version that records no effort still yields the model rather than nothing at all.
    const sidechain = JSON.stringify({
      type: "assistant",
      isSidechain: true,
      message: { role: "assistant", model: "claude-haiku-5" },
    });
    expect(parseClaudeModelLine(sidechain)).toBeUndefined();
    expect(parseClaudeModelLine(JSON.stringify({ type: "user", message: { role: "user" } }))).toBeUndefined();
    expect(parseClaudeModelLine("not json")).toBeUndefined();
    expect(parseClaudeModelLine(JSON.stringify({
      type: "assistant",
      message: { role: "assistant", model: "claude-sonnet-5" },
    }))).toEqual({ model: "claude-sonnet-5" });
  });

  it("reads the model and effort a Codex turn_context declares", () => {
    const line = JSON.stringify({
      type: "turn_context",
      timestamp: "2026-08-16T09:05:00.000Z",
      payload: { turn_id: "t1", model: "gpt-5.6-sol", effort: "xhigh", summary: "none" },
    });
    expect(parseCodexModelLine(line)).toEqual({
      model: "gpt-5.6-sol",
      effort: "xhigh",
      observedAt: "2026-08-16T09:05:00.000Z",
    });
    // An effort Cyberdeck has no value for is dropped rather than invented into the record.
    expect(parseCodexModelLine(JSON.stringify({
      type: "turn_context",
      payload: { model: "gpt-5.6-luna", effort: "colossal" },
    }))).toEqual({ model: "gpt-5.6-luna" });
    expect(parseCodexModelLine(JSON.stringify({ type: "event_msg", payload: { model: "x" } }))).toBeUndefined();
  });

  it("offers no parser for a provider that keeps no transcript to observe", () => {
    expect(observedModelParser("claude")).toBe(parseClaudeModelLine);
    expect(observedModelParser("codex")).toBe(parseCodexModelLine);
    expect(observedModelParser("cursor")).toBeUndefined();
    expect(observedModelParser("antigravity")).toBeUndefined();
  });
});
