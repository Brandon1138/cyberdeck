import type { ProviderId, ReasoningEffort } from "../domain/session.js";

export interface WorkerProviderCapability {
  provider: ProviderId;
  models: readonly string[];
  efforts: readonly ReasoningEffort[];
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
    modelIdRule: "Use the complete gpt-5.6-* identifier; luna, terra, and sol are labels, not launch IDs.",
    notes: ["Omitting model uses the provider-native default."],
  },
  {
    provider: "claude",
    models: ["haiku", "sonnet", "opus", "fable"],
    efforts: ["low", "medium", "high", "xhigh", "max"],
    modelIdRule: "haiku, sonnet, opus, and fable are provider-native Claude aliases.",
    notes: [
      "Fable requires the operator-controlled worker.start.fable grant for autonomous delegation.",
      "An explicit model is required.",
    ],
  },
  {
    provider: "cursor",
    models: ["composer"],
    efforts: [],
    modelIdRule: "Use the provider-native model identifier; Composer exposes no separate effort flag.",
    notes: ["Read-only workers run in plan mode with Cursor sandboxing enabled."],
  },
  {
    provider: "antigravity",
    models: ["gemini-3.6-flash-low", "gemini-3.6-flash-medium", "gemini-3.6-flash-high"],
    efforts: ["low", "medium", "high"],
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
  | { ok: false; code: "MODEL_ID_NOT_CANONICAL" | "MODEL_NOT_ADVERTISED" | "EFFORT_NOT_SUPPORTED" | "MODEL_EFFORT_MISMATCH"; message: string };

export function validateWorkerSelection(input: {
  provider: ProviderId;
  model?: string;
  effort?: ReasoningEffort;
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
