import type { ApprovalMode, ProviderId, ReasoningEffort } from "../domain/session.js";

export interface WorkerProviderCapability {
  provider: ProviderId;
  models: readonly string[];
  efforts: readonly ReasoningEffort[];
  /** Models that may launch with `fast: true`. Empty means the provider has no fast mode. */
  fastModels: readonly string[];
  approvalModes: readonly ApprovalMode[];
  modelIdRule: string;
  notes: readonly string[];
}

/**
 * The bounded catalog an autonomous orchestrator may use for interactive workers.
 *
 * Friendly product names belong in presentation. The launch boundary receives only the exact
 * provider-native identifier advertised here; it never translates a guessed alias or silently
 * substitutes another model. Direct human starts retain the lower-level opaque model-string
 * contract, so a newly released provider model can still be tested before this catalog is updated.
 */
export const WORKER_PROVIDER_CAPABILITIES: readonly WorkerProviderCapability[] = [
  {
    provider: "codex",
    models: ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"],
    efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    fastModels: ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"],
    approvalModes: ["prompt", "auto"],
    modelIdRule: "Use the complete gpt-5.6-* identifier; luna, terra, and sol are labels, not launch IDs.",
    notes: [
      "Omitting model uses the provider-native default.",
      "fast: true launches with service_tier=\"fast\" — lower latency, roughly double the ChatGPT rate-limit burn.",
    ],
  },
  {
    provider: "claude",
    models: ["haiku", "sonnet", "opus", "fable"],
    efforts: ["low", "medium", "high", "xhigh", "max"],
    fastModels: ["opus"],
    approvalModes: ["prompt", "auto"],
    modelIdRule: "haiku, sonnet, opus, and fable are provider-native Claude aliases.",
    notes: [
      "Fable requires the operator-controlled worker.start.fable grant for autonomous delegation.",
      "An explicit model is required.",
      "fast: true requires model opus and bills the operator's usage credits, not subscription limits.",
    ],
  },
  {
    provider: "cursor",
    models: [
      "composer-2.5",
      "gpt-5.6-luna-low",
      "gpt-5.6-luna-medium",
      "gpt-5.6-luna-high",
      "gpt-5.6-luna-xhigh",
      "gpt-5.6-terra-low",
      "gpt-5.6-terra-medium",
      "gpt-5.6-terra-high",
      "gpt-5.6-terra-xhigh",
      "gpt-5.6-sol-low",
      "gpt-5.6-sol-medium",
      "gpt-5.6-sol-high",
      "gpt-5.6-sol-xhigh",
      "claude-sonnet-5-low",
      "claude-sonnet-5-medium",
      "claude-sonnet-5-high",
      "claude-sonnet-5-xhigh",
      "claude-opus-5-low",
      "claude-opus-5-medium",
      "claude-opus-5-high",
      // Non-thinking Opus 5 has no xhigh slug, so the thinking variant is the deliberate xhigh rung.
      "claude-opus-5-thinking-xhigh",
      "claude-fable-5-low",
      "claude-fable-5-medium",
      "claude-fable-5-high",
      "kimi-k2.7-code",
      "kimi-k3-max",
      "glm-5.2-high",
      "cursor-grok-4.5-high",
    ],
    efforts: [],
    fastModels: [],
    approvalModes: ["prompt", "auto"],
    modelIdRule:
      "Use the exact Cursor model slug; effort is encoded in the slug suffix and Cursor exposes no separate effort flag or bracket override.",
    notes: [
      "Autonomous Cursor workers require the operator-controlled worker.start.cursor grant for delegation.",
      "A Cursor Fable slug additionally requires worker.start.fable; both grants must be present.",
      "Read-only workers run in plan mode with Cursor sandboxing enabled.",
      "Standard interactive auto mode is verified post-launch through Composer /run-everything.",
      "Scout profile uses operator-granted one-shot --print stream-json transport; no effort flag.",
    ],
  },
  {
    provider: "antigravity",
    models: ["gemini-3.6-flash-low", "gemini-3.6-flash-medium", "gemini-3.6-flash-high"],
    efforts: ["low", "medium", "high"],
    fastModels: [],
    approvalModes: ["prompt"],
    modelIdRule: "Use the exact effort-suffixed provider ID and pass the matching effort value.",
    notes: [
      "Cyberdeck trusts only the exact authorized worker cwd before launch.",
      "Workspace trust never enables dangerously-skip-permissions.",
    ],
  },
] as const;

export function workerProviderCapability(provider: string): WorkerProviderCapability | undefined {
  return WORKER_PROVIDER_CAPABILITIES.find((entry) => entry.provider === provider);
}

export type WorkerSelectionValidation =
  | { ok: true }
  | {
      ok: false;
      code:
        | "MODEL_ID_NOT_CANONICAL"
        | "MODEL_NOT_ADVERTISED"
        | "EFFORT_NOT_SUPPORTED"
        | "MODEL_EFFORT_MISMATCH"
        | "FAST_NOT_SUPPORTED"
        | "APPROVAL_MODE_NOT_SUPPORTED";
      message: string;
    };

export function validateWorkerSelection(input: {
  provider: ProviderId;
  model?: string;
  effort?: ReasoningEffort;
  fast?: boolean;
  approvalMode?: ApprovalMode;
}): WorkerSelectionValidation {
  const capability = workerProviderCapability(input.provider);
  if (capability === undefined) {
    return {
      ok: false,
      code: "MODEL_NOT_ADVERTISED",
      message: `Provider ${input.provider} has no advertised autonomous-worker capability`,
    };
  }

  if (input.provider === "codex" && input.model !== undefined) {
    const canonical = ({
      luna: "gpt-5.6-luna",
      terra: "gpt-5.6-terra",
      sol: "gpt-5.6-sol",
    } as const)[input.model as "luna" | "terra" | "sol"];
    if (canonical !== undefined) {
      return {
        ok: false,
        code: "MODEL_ID_NOT_CANONICAL",
        message: `Codex model label ${input.model} is not a launch ID; use ${canonical}`,
      };
    }
  }

  if (input.provider === "antigravity" && input.model === "gemini-3.6-flash") {
    return {
      ok: false,
      code: "MODEL_ID_NOT_CANONICAL",
      message: "Antigravity model gemini-3.6-flash is incomplete; use gemini-3.6-flash-low, gemini-3.6-flash-medium, or gemini-3.6-flash-high",
    };
  }

  if (input.model !== undefined && !capability.models.includes(input.model)) {
    return {
      ok: false,
      code: "MODEL_NOT_ADVERTISED",
      message: `${input.model} is not advertised for autonomous ${input.provider} workers; use one of: ${capability.models.join(", ")}`,
    };
  }

  if (input.effort !== undefined && !capability.efforts.includes(input.effort)) {
    const supported = capability.efforts.length === 0 ? "no separate effort values" : capability.efforts.join(", ");
    return {
      ok: false,
      code: "EFFORT_NOT_SUPPORTED",
      message: `${input.provider} does not support worker effort ${input.effort}; supported: ${supported}`,
    };
  }

  if (input.fast === true) {
    if (capability.fastModels.length === 0) {
      return {
        ok: false,
        code: "FAST_NOT_SUPPORTED",
        message: `${input.provider} has no fast mode for autonomous workers`,
      };
    }
    // Claude requires an explicit model elsewhere; Codex's omitted-model default is fast-capable.
    if (input.model !== undefined && !capability.fastModels.includes(input.model)) {
      return {
        ok: false,
        code: "FAST_NOT_SUPPORTED",
        message: `${input.provider} fast mode is not available on ${input.model}; supported: ${capability.fastModels.join(", ")}`,
      };
    }
  }

  if (input.approvalMode !== undefined && !capability.approvalModes.includes(input.approvalMode)) {
    return {
      ok: false,
      code: "APPROVAL_MODE_NOT_SUPPORTED",
      message: `${input.provider} does not support worker approval mode ${input.approvalMode}; supported: ${capability.approvalModes.join(", ")}`,
    };
  }

  if (
    input.provider === "antigravity"
    && input.model !== undefined
    && input.effort !== undefined
    && !input.model.endsWith(`-${input.effort}`)
  ) {
    return {
      ok: false,
      code: "MODEL_EFFORT_MISMATCH",
      message: `Antigravity model ${input.model} does not match effort ${input.effort}; use gemini-3.6-flash-${input.effort}`,
    };
  }

  return { ok: true };
}
