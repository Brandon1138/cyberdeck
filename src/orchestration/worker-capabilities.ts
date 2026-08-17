import type { ApprovalMode, ProviderId, ReasoningEffort } from "../domain/session.js";

export interface WorkerProviderCapability {
  provider: ProviderId;
  models: readonly string[];
  efforts: readonly ReasoningEffort[];
  approvalModes: readonly ApprovalMode[];
  modelIdRule: string;
  notes: readonly string[];
  /** The provider's own display name per model id, when its listing printed one. */
  modelLabels?: Readonly<Record<string, string>>;
}

/**
 * Where a served capability's model list came from.
 *
 * - `provider-query` — the provider's own CLI printed this list, on `observedAt`.
 * - `fallback-catalog` — the provider could not be asked, so the list below stood in. It is a
 *   record of what was true when it was written, never a claim about what the provider offers now,
 *   and every surface that renders it has to say so.
 */
export type WorkerCapabilitySource = "provider-query" | "fallback-catalog";

export interface ResolvedWorkerCapability extends WorkerProviderCapability {
  source: WorkerCapabilitySource;
  /** When the provider's listing was read. Present exactly when `source` is `provider-query`. */
  observedAt?: string;
  /** Why the provider could not be asked. Present exactly when `source` is `fallback-catalog`. */
  fallbackReason?: string;
}

/**
 * The bounded catalog an autonomous orchestrator may use for interactive workers.
 *
 * This is the **fallback**, not the authority. `WorkerCapabilityCatalog` asks each provider CLI
 * what it currently offers and serves that; these entries stand in only for a provider that cannot
 * be asked, and are served carrying `source: "fallback-catalog"` and the reason so no reader
 * mistakes a snapshot for the present tense.
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
    approvalModes: ["prompt", "auto"],
    modelIdRule: "Use the complete gpt-5.6-* identifier; luna, terra, and sol are labels, not launch IDs.",
    notes: ["Omitting model uses the provider-native default."],
  },
  {
    provider: "claude",
    models: ["haiku", "sonnet", "opus", "fable"],
    efforts: ["low", "medium", "high", "xhigh", "max"],
    approvalModes: ["prompt", "auto"],
    modelIdRule: "haiku, sonnet, opus, and fable are provider-native Claude aliases.",
    notes: [
      "Fable requires the operator-controlled worker.start.fable grant for autonomous delegation.",
      "An explicit model is required.",
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
    approvalModes: ["prompt", "auto"],
    modelIdRule:
      "Use the exact Cursor model slug; effort is encoded in the slug suffix and Cursor exposes no separate effort flag or bracket override.",
    notes: [
      "A Cursor Fable slug requires the operator-controlled worker.start.fable grant; every other slug here needs no grant beyond worker.start.",
      "Read-only workers run in plan mode with Cursor sandboxing enabled.",
      "Standard interactive auto mode is verified post-launch through Composer /run-everything.",
      "Scout profile uses operator-granted one-shot --print stream-json transport; no effort flag.",
    ],
  },
  {
    provider: "antigravity",
    models: ["gemini-3.6-flash-low", "gemini-3.6-flash-medium", "gemini-3.6-flash-high"],
    efforts: ["low", "medium", "high"],
    approvalModes: ["prompt"],
    modelIdRule: "Use the exact effort-suffixed provider ID and pass the matching effort value.",
    notes: [
      "Cyberdeck trusts only the exact authorized worker cwd before launch.",
      "Workspace trust never enables dangerously-skip-permissions.",
    ],
  },
] as const;

export function workerProviderCapability<T extends WorkerProviderCapability>(
  provider: string,
  capabilities: readonly T[],
): T | undefined;
export function workerProviderCapability(provider: string): WorkerProviderCapability | undefined;
export function workerProviderCapability(
  provider: string,
  capabilities: readonly WorkerProviderCapability[] = WORKER_PROVIDER_CAPABILITIES,
): WorkerProviderCapability | undefined {
  return capabilities.find((entry) => entry.provider === provider);
}

/**
 * The static catalog, served as what it is: a stand-in for providers that could not be asked.
 *
 * `reason` is quoted verbatim to every reader, so it has to say why the query did not happen —
 * "the broker is unreachable", "this CLI advertises no listing command" — rather than merely that
 * something failed.
 */
export function fallbackWorkerCapabilities(
  reason: string,
  provider?: string,
): ResolvedWorkerCapability[] {
  return WORKER_PROVIDER_CAPABILITIES
    .filter((entry) => provider === undefined || entry.provider === provider)
    .map((entry) => ({ ...entry, source: "fallback-catalog", fallbackReason: reason }));
}

/**
 * The efforts a specific model may be launched with.
 *
 * A provider that encodes effort in the slug has already answered the question: `agy models` prints
 * `gemini-3.6-flash-high`, and pairing that id with `low` is a launch nobody asked for. So a slug
 * ending in one of the provider's own effort words offers that effort and no other, and a provider
 * with no separate effort flag offers none at all. Everything else keeps the provider's full list.
 */
export function capabilityModelEfforts(
  capability: WorkerProviderCapability,
  model: string,
): readonly ReasoningEffort[] {
  const suffix = capability.efforts.find((effort) => model.endsWith(`-${effort}`));
  return suffix === undefined ? capability.efforts : [suffix];
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
        | "APPROVAL_MODE_NOT_SUPPORTED";
      message: string;
    };

/**
 * Whether a selection may be launched, judged against the capabilities actually being advertised.
 *
 * `capabilities` defaults to the static catalog so a caller with nothing to resolve against keeps
 * working, but the broker passes the resolved set: a Fleet composer offering a model the provider
 * just added must not be refused here for not appearing in a list written months ago.
 */
export function validateWorkerSelection(input: {
  provider: ProviderId;
  model?: string;
  effort?: ReasoningEffort;
  approvalMode?: ApprovalMode;
}, capabilities: readonly WorkerProviderCapability[] = WORKER_PROVIDER_CAPABILITIES): WorkerSelectionValidation {
  const capability = workerProviderCapability(input.provider, capabilities);
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
      message: `${input.model} is not advertised for autonomous ${input.provider} workers; use one of: ${advertisedModels(capability)}`,
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

  if (input.approvalMode !== undefined && !capability.approvalModes.includes(input.approvalMode)) {
    return {
      ok: false,
      code: "APPROVAL_MODE_NOT_SUPPORTED",
      message: `${input.provider} does not support worker approval mode ${input.approvalMode}; supported: ${capability.approvalModes.join(", ")}`,
    };
  }

  // A slug that names its own effort has already chosen one, so a second, different effort is a
  // contradiction rather than a refinement. Slugs that name none are unconstrained here.
  if (input.model !== undefined && input.effort !== undefined) {
    const slugEffort = capability.efforts.find((effort) => input.model!.endsWith(`-${effort}`));
    if (slugEffort !== undefined && slugEffort !== input.effort) {
      return {
        ok: false,
        code: "MODEL_EFFORT_MISMATCH",
        message: `${input.provider} model ${input.model} names effort ${slugEffort}, not ${input.effort}; pass the matching effort or a slug for ${input.effort}`,
      };
    }
  }

  return { ok: true };
}

/**
 * The advertised set, bounded. A provider listing runs to a couple of hundred slugs, and a refusal
 * that pastes all of them is a refusal nobody reads to the end of.
 */
const ADVERTISED_MODELS_IN_MESSAGE = 12;

function advertisedModels(capability: WorkerProviderCapability): string {
  const shown = capability.models.slice(0, ADVERTISED_MODELS_IN_MESSAGE).join(", ");
  const remaining = capability.models.length - ADVERTISED_MODELS_IN_MESSAGE;
  return remaining > 0
    ? `${shown} (and ${remaining} more; call cyberdeck_provider_capabilities for the full list)`
    : shown;
}
