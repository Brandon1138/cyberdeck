import {
  OrchestratorAttentionControlPlane, type OrchestratorAttentionOptions,
} from "../orchestration/orchestrator-attention-control.js";
import { OrchestratorAttentionStore } from "./orchestrator-attention-store.js";

/** Infrastructure wiring stays at the same boundary as the existing coordination runtime. */
export async function createOrchestratorAttention(
  stateDirectory: string, options: Omit<OrchestratorAttentionOptions, "store">,
): Promise<OrchestratorAttentionControlPlane> {
  const store = new OrchestratorAttentionStore(stateDirectory);
  await store.list(); // Refuse corrupt committed state before serving a control-plane request.
  return new OrchestratorAttentionControlPlane({ ...options, store });
}
