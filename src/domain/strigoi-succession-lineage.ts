import type { StrigoiIdentity, StrigoiState, StrigoiTransition } from "./strigoi.js";

const sameIdentity = (a: StrigoiIdentity | undefined, b: StrigoiIdentity | undefined) =>
  a !== undefined && b !== undefined && a.sessionId === b.sessionId
  && a.incarnation === b.incarnation && a.generation === b.generation;

/** Only interrupted, explicitly superseded links carry unreconciled obligations forward.
 * Retention, packet contents and unrelated completed renewals do not establish lineage. */
export function strigoiSuccessionLineage(state: StrigoiState): StrigoiTransition[] {
  if (!state.transition) return [];
  const lineage = [state.transition], visited = new Set([state.transition.id]);
  let current = state.transition;
  for (;;) {
    const parents = (state.successionHistory ?? []).filter(prior => prior.supersededBy === current.id);
    if (!parents.length) return lineage;
    const prior = parents[0]!;
    if (parents.length !== 1 || visited.has(prior.id) || !prior.predecessor
      || !sameIdentity(prior.successor, current.predecessor)
      || !["committed", "adopting", "reconciling"].includes(prior.phase)
      || current.reason !== "runtime-recovery" || current.recovery !== true) {
      throw new Error("STRIGOI_INVALID_SUCCESSION_LINEAGE");
    }
    visited.add(prior.id); lineage.push(prior); current = prior;
  }
}
