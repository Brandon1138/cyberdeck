import { describe, expect, it } from "vitest";
import {
  detectProviderLimitTermination,
  detectSessionFatalError,
} from "../../src/runtime/session-liveness.js";

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

  it("does not poison a resumed conversation that discusses provider error signatures", () => {
    const replay = [
      "The detector now requires structurally framed error signals so prompts, pasted logs,",
      "and responses containing strings such as `API Error: 400` or `invalid_request_error`",
      "cannot mark a healthy resumed conversation as dead.",
      "› Tell the model what to do differently",
    ].join("\n");

    expect(detectSessionFatalError(replay)).toBeUndefined();
  });

  it("only reads the tail, so an old fault the session recovered from is not fatal now", () => {
    const replay = `API Error: 400 stale failure\n${"healthy output\n".repeat(600)}`;
    expect(detectSessionFatalError(replay)).toBeUndefined();
  });

  it("leaves a composer holding the error text alone, box-framed or not", () => {
    const boxed = [
      "╭──────────────────────────────────────────────╮",
      "│ > why did API Error: 400 invalid_request_error │",
      "│   show up in yesterday's log?                  │",
      "╰──────────────────────────────────────────────╯",
    ].join("\n");
    expect(detectSessionFatalError(boxed)).toBeUndefined();

    const plainPrompt = "> paste this and explain:\n> API Error: 400 invalid_request_error\n";
    expect(detectSessionFatalError(plainPrompt)).toBeUndefined();
  });

  it("leaves a pasted log alone even where it renders flush against a tool result", () => {
    const replay = [
      "⏺ Read(worker.log)",
      "  ⎿  Read 3 lines",
      "     API Error: 401 authentication_error",
      "     API Error: 403 permission_error",
      "⏺ The log shows the worker died on an expired key; rotating it fixes the run.",
      "  API Error: 400 invalid_request_error was the very first symptom.",
    ].join("\n");

    expect(detectSessionFatalError(replay)).toBeUndefined();
  });

  it("still names the provider's own notice when it sits under that same conversation", () => {
    const replay = [
      "⏺ The log shows the worker died on an expired key.",
      "  API Error: 400 invalid_request_error was the very first symptom.",
      "",
      "API Error: 401 {\"type\":\"error\",\"error\":{\"type\":\"authentication_error\"}}",
      "",
    ].join("\n");

    expect(detectSessionFatalError(replay)).toMatchObject({
      reason: "provider authentication failed",
    });
  });

  it("does not read a severed line as one that began at the left margin", () => {
    // The 4 KiB tail is cut by bytes, so it can land mid-line. Line this replay up so the cut falls
    // exactly where an assistant paragraph happens to say `API Error`, which is not a fault at all.
    const notice = "API Error: 400 invalid_request_error\n";
    const tail = `${notice}${"x".repeat(4_000 - notice.length)}`;
    const replay = `⏺ the run failed earlier today with ${tail}`;

    expect(detectSessionFatalError(replay)).toBeUndefined();
  });
});

describe("detectProviderLimitTermination", () => {
  it("names a session cap the operator can wait out rather than a generic rejection", () => {
    expect(detectProviderLimitTermination("Usage limit reached · resets 3:00pm\n")).toMatchObject({
      kind: "session-limit",
      reason: "provider usage limit reached",
    });
    expect(detectProviderLimitTermination("5-hour limit reached\n")?.kind).toBe("session-limit");
    expect(detectProviderLimitTermination("You've reached your weekly limit\n")?.kind).toBe("session-limit");
  });

  it("names a prompt the provider refused for length", () => {
    expect(detectProviderLimitTermination("Prompt is too long\n")).toMatchObject({
      kind: "prompt-too-long",
      reason: "provider refused the prompt as too long for its context window",
    });
    expect(detectProviderLimitTermination("input length and `max_tokens` exceed context limit\n")?.kind)
      .toBe("prompt-too-long");
  });

  it("ignores a worker talking about limits instead of hitting one", () => {
    // Both lines carry a conversation marker in the first column, so neither is the provider's own
    // notice. Reading them would kill a healthy session for describing the failure it just fixed.
    expect(detectProviderLimitTermination("⏺ The earlier run died because the prompt is too long.\n"))
      .toBeUndefined();
    expect(detectProviderLimitTermination("> what happens when usage limit reached?\n")).toBeUndefined();
  });

  it("does not call a retrying provider limited", () => {
    expect(detectProviderLimitTermination("Usage limit reached\nRetrying in 30s\n")).toBeUndefined();
  });

  it("bounds the detail the same way a fault does", () => {
    const detail = detectProviderLimitTermination(`Prompt is too long ${"y".repeat(900)}\n`)?.detail ?? "";
    expect(detail.length).toBeLessThanOrEqual(240);
    expect(detail).not.toContain("\n");
  });
});
