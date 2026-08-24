import { describe, expect, it } from "vitest";
import { parseCodexBudgetTelemetryLine } from "../../src/runtime/provider-budget-telemetry.js";

describe("Codex provider budget telemetry", () => {
  const line = JSON.stringify({
    type: "event_msg",
    timestamp: "2026-08-24T12:00:00.000Z",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: { input_tokens: 24_118, output_tokens: 903 },
      },
      rate_limits: {
        primary: { used_percent: 32, window_minutes: 300 },
        secondary: { used_percent: 17, window_minutes: 10_080 },
      },
    },
  });

  it("selects weekly provider remaining usage and cumulative tokens", () => {
    expect(parseCodexBudgetTelemetryLine(line, "weekly")).toEqual({
      totalTokens: 25_021,
      tokenObservedAt: "2026-08-24T12:00:00.000Z",
      providerUsage: {
        window: "weekly",
        usedPercent: 17,
        remainingPercent: 83,
        observedAt: "2026-08-24T12:00:00.000Z",
      },
    });
  });

  it("selects session window independently", () => {
    expect(parseCodexBudgetTelemetryLine(line, "session")?.providerUsage).toMatchObject({
      window: "session",
      usedPercent: 32,
      remainingPercent: 68,
    });
  });

  it("leaves malformed or unrelated frames unknown", () => {
    expect(parseCodexBudgetTelemetryLine("not-json", "weekly")).toBeUndefined();
    expect(parseCodexBudgetTelemetryLine(JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }), "weekly"))
      .toBeUndefined();
  });
});
