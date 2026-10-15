import type { OrchestratorAttention } from "../domain/orchestrator-attention.js";

export interface AttentionStorePort {
  get(controllerId: string): Promise<OrchestratorAttention | undefined>;
  list(): Promise<OrchestratorAttention[]>;
  /** Serialized per controller; undefined leaves the existing file intact. */
  update(controllerId: string, change: (current: OrchestratorAttention | undefined) =>
    Promise<OrchestratorAttention | undefined>): Promise<OrchestratorAttention | undefined>;
}
