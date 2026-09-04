import type { ProviderId, ReasoningEffort } from "../domain/session.js";
import { capabilityModelEfforts, type ResolvedWorkerCapability } from "./worker-capabilities.js";

export interface OrchestratorCatalogEntry {
  provider: ProviderId;
  label: string;
  models: readonly string[];
  efforts: readonly (ReasoningEffort | "native-default")[];
  modelLabels?: Readonly<Record<string, string>>;
  modelEfforts?: Readonly<Record<string, readonly ReasoningEffort[]>>;
  fallbackReason?: string;
}

/** Provider launch contracts and stored choices when discovery is unavailable. */
export const ORCHESTRATOR_CATALOG: readonly OrchestratorCatalogEntry[] = [
  {
    provider: "codex",
    label: "Codex",
    models: ["gpt-5.6-sol", "gpt-5.6-terra"],
    efforts: ["native-default", "low", "medium", "high", "xhigh", "max", "ultra"],
  },
  {
    provider: "claude",
    label: "Claude",
    models: ["sonnet", "opus", "fable"],
    efforts: ["native-default", "low", "medium", "high", "xhigh", "max"],
  },
  {
    // Cursor encodes effort in the model slug, so `native-default` is the only effort it can offer;
    // an explicit effort is refused by the adapter rather than silently ignored.
    provider: "cursor",
    label: "Cursor",
    models: [
      "claude-fable-5-thinking-high",
      "gpt-5.6-sol-high",
      "claude-opus-5-thinking-high",
      "kimi-k3-max",
    ],
    efforts: ["native-default"],
  },
];

/** Codex models come from the same discovery answer used by worker launches. */
export function orchestratorCatalog(
  capabilities: readonly ResolvedWorkerCapability[] = [],
): readonly OrchestratorCatalogEntry[] {
  const codex = capabilities.find((entry) => entry.provider === "codex");
  return ORCHESTRATOR_CATALOG.map((entry) => {
    if (entry.provider !== "codex") return entry;
    if (codex?.source !== "provider-query") {
      return { ...entry, fallbackReason: codex?.fallbackReason ?? "Codex model discovery is unavailable" };
    }
    return {
      ...entry,
      models: codex.models,
      modelLabels: codex.modelLabels ?? {},
      modelEfforts: Object.fromEntries(codex.models.map((model) =>
        [model, capabilityModelEfforts(codex, model)])),
    };
  });
}

export function orchestratorModelEfforts(
  entry: OrchestratorCatalogEntry,
  model: string,
): readonly (ReasoningEffort | "native-default")[] {
  const supported = entry.modelEfforts?.[model];
  return supported === undefined ? entry.efforts : entry.efforts.filter((effort) =>
    effort === "native-default" || supported.includes(effort));
}
