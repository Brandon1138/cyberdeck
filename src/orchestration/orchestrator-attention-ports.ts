import type { OrchestratorAttention } from "../domain/orchestrator-attention.js";

export interface AttentionStorePort {
  get(controllerId: string): Promise<OrchestratorAttention | undefined>;
  list(): Promise<OrchestratorAttention[]>;
  /** Optimistic preparation may repeat; effects belong in admitCommit after the disk CAS.
   * Commits serialize under binding authority; undefined leaves the existing file intact. */
  update(controllerId: string, change: (current: OrchestratorAttention | undefined) =>
    Promise<OrchestratorAttention | undefined>, admitCommit?: (commit: () => Promise<void>) => Promise<void>): Promise<OrchestratorAttention | undefined>;
}
