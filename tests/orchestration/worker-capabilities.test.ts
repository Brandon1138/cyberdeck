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
        approvalModes: ["prompt", "auto"],
      }),
      expect.objectContaining({
        provider: "claude",
        models: ["haiku", "sonnet", "opus", "fable"],
        approvalModes: ["prompt", "auto"],
      }),
      expect.objectContaining({
        provider: "cursor",
        // Effort is part of the slug, so the model list is the effort list; `efforts` stays empty and
        // an explicit effort is refused rather than folded into the slug.
        models: expect.arrayContaining([
          "composer-2.5",
          "gpt-5.6-sol-high",
          "claude-fable-5-high",
          "claude-opus-5-thinking-xhigh",
          "kimi-k3-max",
          "glm-5.2-high",
          "cursor-grok-4.5-high",
        ]),
        efforts: [],
        approvalModes: ["prompt", "auto"],
      }),
      expect.objectContaining({
        provider: "antigravity",
        models: ["gemini-3.6-flash-low", "gemini-3.6-flash-medium", "gemini-3.6-flash-high"],
        efforts: ["low", "medium", "high"],
        approvalModes: ["prompt"],
      }),
    ]);
  });

  it("accepts auto only for providers with a native mapped mode", () => {
    expect(validateWorkerSelection({
      provider: "claude",
      model: "opus",
      approvalMode: "auto",
    })).toEqual({ ok: true });
    expect(validateWorkerSelection({
      provider: "codex",
      model: "gpt-5.6-sol",
      approvalMode: "auto",
    })).toEqual({ ok: true });
    expect(validateWorkerSelection({
      provider: "cursor",
      model: "composer-2.5",
      approvalMode: "auto",
    })).toEqual({ ok: true });
  });

  it("refuses a Cursor effort value and the retired bare composer slug", () => {
    expect(validateWorkerSelection({
      provider: "cursor",
      model: "claude-fable-5-high",
      effort: "high",
    })).toEqual(expect.objectContaining({
      ok: false,
      code: "EFFORT_NOT_SUPPORTED",
      message: expect.stringContaining("no separate effort values"),
    }));
    expect(validateWorkerSelection({ provider: "cursor", model: "composer" }))
      .toEqual(expect.objectContaining({
        ok: false,
        code: "MODEL_NOT_ADVERTISED",
        message: expect.stringContaining("composer-2.5"),
      }));
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
