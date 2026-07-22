import { describe, expect, it } from "vitest";
import {
  WORKER_PROVIDER_CAPABILITIES,
  validateWorkerSelection,
} from "../../src/orchestration/worker-capabilities.js";

describe("worker provider capabilities", () => {
  it("exposes exact provider-native IDs and provider-specific effort ranges", () => {
    expect(WORKER_PROVIDER_CAPABILITIES).toEqual([
      expect.objectContaining({
        provider: "codex",
        models: ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"],
        efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      }),
      expect.objectContaining({ provider: "claude", models: ["haiku", "sonnet", "opus", "fable"] }),
      expect.objectContaining({ provider: "cursor", models: ["composer"], efforts: [] }),
      expect.objectContaining({
        provider: "antigravity",
        models: ["gemini-3.6-flash-low", "gemini-3.6-flash-medium", "gemini-3.6-flash-high"],
        efforts: ["low", "medium", "high"],
      }),
    ]);
  });

  it("rejects shorthand rather than translating it at launch", () => {
    expect(validateWorkerSelection({ provider: "codex", model: "luna", effort: "low" }))
      .toEqual(expect.objectContaining({
        ok: false,
        code: "MODEL_ID_NOT_CANONICAL",
        message: expect.stringContaining("gpt-5.6-luna"),
      }));
  });

  it("accepts native Claude aliases and exact Codex IDs", () => {
    expect(validateWorkerSelection({ provider: "claude", model: "haiku", effort: "low" }))
      .toEqual({ ok: true });
    expect(validateWorkerSelection({ provider: "codex", model: "gpt-5.6-sol", effort: "ultra" }))
      .toEqual({ ok: true });
    expect(validateWorkerSelection({ provider: "claude", model: "fable", effort: "high" }))
      .toEqual({ ok: true });
  });

  it("requires Antigravity's installed effort-suffixed ID to match effort", () => {
    expect(validateWorkerSelection({ provider: "antigravity", model: "gemini-3.6-flash", effort: "low" }))
      .toEqual(expect.objectContaining({ ok: false, code: "MODEL_ID_NOT_CANONICAL" }));
    expect(validateWorkerSelection({
      provider: "antigravity",
      model: "gemini-3.6-flash-high",
      effort: "low",
    })).toEqual(expect.objectContaining({ ok: false, code: "MODEL_EFFORT_MISMATCH" }));
    expect(validateWorkerSelection({
      provider: "antigravity",
      model: "gemini-3.6-flash-low",
      effort: "low",
    })).toEqual({ ok: true });
  });
});
