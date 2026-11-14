import type { StrigoiFleetView, StrigoiState } from "./strigoi.js";
export function strigoiFleetView(inspection: { state: StrigoiState; readiness: StrigoiFleetView["readiness"]; adoption: StrigoiFleetView["adoption"] }, sessionId: string): StrigoiFleetView | undefined {
  const s = inspection.state, canonical = s.activeBinding?.sessionId === sessionId;
  if (!canonical && !s.retainedSessionIds.includes(sessionId)) return undefined;
  const identity = [s.transition?.predecessor, s.transition?.successor, ...s.successionHistory?.flatMap(t => [t.predecessor, t.successor]) ?? []].find(i => i?.sessionId === sessionId);
  return { canonical, ...(canonical ? { incarnation: s.incarnation } : identity ? { incarnation: identity.incarnation } : {}),
    desired: s.desired, readiness: inspection.readiness, adoption: inspection.adoption,
    ...(s.hold ? { hold: s.hold } : {}), continuationHolds: s.continuationHolds ?? [] };
}
