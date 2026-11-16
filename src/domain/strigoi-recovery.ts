import type { StrigoiState } from "./strigoi.js";

/** Only accounts created with the checkpoint-and-delta contract may summarize a base. */
export function recoveryCheckpoint(state: StrigoiState, mutationId?: string) {
  const receipts = state.continuityReceipts ?? [];
  const receipt = mutationId === undefined ? receipts.findLast(r => r.adoption?.recovery?.version === 1)
    : receipts.find(r => r.mutationId === mutationId && r.adoption?.recovery?.version === 1);
  if (mutationId !== undefined && !receipt) throw new Error("STRIGOI_UNKNOWN_RECOVERY_BASE");
  const handled = new Set<string>(), seen = new Set<string>();
  let current = receipt;
  while (current) {
    if (seen.has(current.mutationId)) throw new Error("STRIGOI_UNKNOWN_RECOVERY_BASE");
    seen.add(current.mutationId);
    current.adoption!.handledSourceIds.forEach(id => handled.add(id));
    const base = current.adoption!.recovery!.baseMutationId;
    const index = receipts.indexOf(current);
    current = base === undefined ? undefined : receipts.slice(0, index).find(r => r.mutationId === base && r.adoption?.recovery?.version === 1);
    if (base !== undefined && !current) throw new Error("STRIGOI_UNKNOWN_RECOVERY_BASE");
  }
  return { receipt, handled };
}
