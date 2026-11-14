import type { ControllerIdentity, OwnershipMutationResult } from "../domain/worker-coordination.js";

export interface AdoptBatchInput {
  mutationId: string;
  actor: ControllerIdentity;
  newController: ControllerIdentity;
  members: ReadonlyArray<{
    subjectId: string;
    mode: "acquire" | "adopt";
    expectedLease?: { controllerId: string; version: number };
  }>;
  reason: string;
  /** Internal recovery keeps new tokens exclusively in live broker custody. */
  credentialDelivery?: "ephemeral";
}

export interface AdoptBatchResult extends OwnershipMutationResult {
  committed: boolean;
}

/** Existing adoption transaction, with an explicitly tokenless durable replay for recovery. */
export function adoptionReceipt(result: AdoptBatchResult, delivery?: "ephemeral"): AdoptBatchResult {
  return delivery === "ephemeral" ? { ...result,
    outcomes: result.outcomes.map(({ leaseToken: _token, ...outcome }) => outcome) } : result;
}
