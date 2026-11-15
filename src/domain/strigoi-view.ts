import type { StrigoiFleetView, StrigoiState } from "./strigoi.js";
export function strigoiFleetView(inspection: { state: StrigoiState; readiness: StrigoiFleetView["readiness"]; adoption: StrigoiFleetView["adoption"]; ownership?: "owned" | "unknown" | "none" }, sessionId: string): StrigoiFleetView | undefined {
  const s = inspection.state, canonical = s.activeBinding?.sessionId === sessionId;
  if (!canonical && !s.retainedSessionIds.includes(sessionId)) return undefined;
  const identity = [s.transition?.predecessor, s.transition?.successor, ...s.successionHistory?.flatMap(t => [t.predecessor, t.successor]) ?? []].find(i => i?.sessionId === sessionId);
  return { canonical, ...(canonical ? { incarnation: s.incarnation } : identity ? { incarnation: identity.incarnation } : {}),
    ...(canonical && s.transition ? { recovery: { phase: s.transition.phase, ownership: inspection.ownership ?? "unknown",
      lastAttemptAt: s.transition.adoptionTurn?.startedAt ?? s.transition.launchStartedAt,
      nextAction: s.hold ? s.hold.detail : s.transition.nextAttemptAt ? `Retry after ${s.transition.nextAttemptAt}`
        : s.transition.adoptionDeferred ? "Waiting for meaningful input; packet adoption remains pending" : `Reconcile ${s.transition.phase}` } } : {}),
    desired: s.desired, readiness: inspection.readiness, adoption: inspection.adoption,
    ...(s.hold ? { hold: s.hold } : {}), continuationHolds: s.continuationHolds ?? [] };
}
