import { describe, expect, it } from "vitest";
import { detectSessionFatalError } from "../../src/runtime/session-liveness.js";

describe("detectSessionFatalError", () => {
  it("reports the API 4xx that killed three worker sessions while their processes kept running", () => {
    const replay = [
      "> continue the task",
      "",
      "API Error: 400 {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"tool not found\"}}",
      "",
    ].join("\n");

    expect(detectSessionFatalError(replay)).toMatchObject({
      reason: "provider API rejected the request",
    });
  });

  it("survives terminal control sequences around the error text", () => {
    const replay = "[2J[1;1H[31mAPI Error: 401 authentication_error[0m\n";
    expect(detectSessionFatalError(replay)?.reason).toBe("provider authentication failed");
  });

  it("bounds the reported detail to a single trimmed line", () => {
    const replay = `API Error: 400 ${"x".repeat(900)}\nnext line\n`;
    const detail = detectSessionFatalError(replay)?.detail ?? "";
    expect(detail.length).toBeLessThanOrEqual(240);
    expect(detail).not.toContain("\n");
    expect(detail.endsWith("...")).toBe(true);
  });

  it("does not call a retrying provider dead", () => {
    expect(detectSessionFatalError("API Error: 429 rate limited · Retrying in 8s\n")).toBeUndefined();
    expect(detectSessionFatalError("API Error: 400 bad request\nattempt 2 of 5\n")).toBeUndefined();
  });

  it("leaves transient server and connection faults to the provider's own retry loop", () => {
    expect(detectSessionFatalError("API Error: 503 upstream unavailable\n")).toBeUndefined();
    expect(detectSessionFatalError("API Error (Connection error)\n")).toBeUndefined();
  });

  it("ignores ordinary output, including an agent talking about a 400", () => {
    expect(detectSessionFatalError("Fixed the handler so it no longer returns HTTP 400.\n")).toBeUndefined();
    expect(detectSessionFatalError("esc to interrupt · 42% context left\n")).toBeUndefined();
  });

  it("only reads the tail, so an old fault the session recovered from is not fatal now", () => {
    const replay = `API Error: 400 stale failure\n${"healthy output\n".repeat(600)}`;
    expect(detectSessionFatalError(replay)).toBeUndefined();
  });
});
