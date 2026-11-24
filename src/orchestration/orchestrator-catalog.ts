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

/**
 * Codex and Cursor models come from discovery. Claude stays on its stored aliases.
 *
 * A live Cursor listing replaces the four stored slugs and keeps `native-default` as the only
 * effort: Cursor encodes effort in the slug, and copying a per-model effort range would offer a
 * flag the adapter refuses. A Cursor entry that is not a provider query keeps those four slugs
 * and carries the reason. It does not adopt the worker snapshot's longer model list. An omitted
 * Cursor entry leaves the stored slugs alone, with no failure banner, because nobody was asked.
 */
export function orchestratorCatalog(
  capabilities: readonly ResolvedWorkerCapability[] = [],
): readonly OrchestratorCatalogEntry[] {
  const codex = capabilities.find((entry) => entry.provider === "codex");
  const cursor = capabilities.find((entry) => entry.provider === "cursor");
  return ORCHESTRATOR_CATALOG.map((entry) => {
    if (entry.provider === "codex") {
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
    }
    if (entry.provider !== "cursor" || cursor === undefined) return entry;
    if (cursor.source !== "provider-query") {
      return { ...entry, fallbackReason: cursor.fallbackReason ?? "Cursor model discovery is unavailable" };
    }
    return {
      ...entry,
      models: cursor.models,
      modelLabels: cursor.modelLabels ?? {},
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
