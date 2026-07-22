import type { ProviderId, ReasoningEffort } from "../domain/session.js";

export interface OrchestratorCatalogEntry {
  provider: ProviderId;
  label: string;
  models: readonly string[];
  efforts: readonly (ReasoningEffort | "native-default")[];
}

/** Stable explicit choices for the picker, never automatic routing or fallback. */
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
];
