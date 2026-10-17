import type { AttentionCoverage, OrchestratorAttention } from "../domain/orchestrator-attention.js";
import { attentionDigest, type AttentionSourceSnapshot } from "./orchestrator-attention-source.js";

export interface AttentionDecisionInput {
  record: OrchestratorAttention;
  sources: AttentionSourceSnapshot;
  now: string;
}
export interface AttentionDecision { outcome: "WAKE" | "DO_NOT_WAKE" | "FALLBACK_WAKE"; reason: string }

export function coverageContains(covered: AttentionCoverage, requested: AttentionCoverage, truth = true): boolean {
  return requested.every((point) => covered.some((seen) => seen.sessionId === point.sessionId
    && seen.eventOrdinal >= point.eventOrdinal && seen.completionTurn >= point.completionTurn
    && (!truth || seen.truthKey === point.truthKey)));
}

/** Consumption and deadline phase matter even when source heads have not changed. */
export function attentionInputId(record: OrchestratorAttention, now: string): string {
  return attentionDigest({ snapshotId: record.snapshotId, consumed: record.coverage.consumed,
    reviewDue: reviewDue(record, now) });
}

function reviewDue(record: OrchestratorAttention, now: string): boolean {
  return record.statement.reviewAt !== undefined && record.reviewNotifiedAt === undefined
    && Date.parse(now) >= Date.parse(record.statement.reviewAt);
}

/** This floor is broker policy; an injected decision fixture cannot suppress it. */
export function attentionLivenessFloor(input: AttentionDecisionInput): AttentionDecision | undefined {
  const { record, sources, now } = input;
  if (reviewDue(record, now)) return { outcome: "FALLBACK_WAKE", reason: "review-deadline" };
  if (coverageContains(record.coverage.consumed, record.coverage.captured)) return undefined;
  if (sources.gaps.length > 0) return { outcome: "FALLBACK_WAKE", reason: "source-or-supervision-gap" };
  if (sources.signals.some((signal) => signal.intervention)) return { outcome: "FALLBACK_WAKE", reason: "explicit-intervention" };
  if (sources.signals.some((signal) => signal.backlog)) return { outcome: "FALLBACK_WAKE", reason: "unresolved-backlog" };
  const stopped = sources.workers.every((worker) => worker.completion !== undefined
    || record.coverage.captured.some((point) => point.sessionId === worker.sessionId && point.completionTurn >= worker.completionTarget)
    || (worker.truth !== undefined && !["working", "starting", "stalled", "unknown"].includes(worker.truth.state)
      && !(worker.truth.state === "idle" && worker.truth.pendingInstructions > 0)));
  return stopped ? { outcome: "FALLBACK_WAKE", reason: "awaited-group-stopped" } : undefined;
}

/** Reference baseline: partial completion and recovering errors may wait for useful group progress. */
export function groupWaitDecision(input: AttentionDecisionInput): AttentionDecision {
  const floor = attentionLivenessFloor(input);
  if (floor !== undefined) return floor;
  if (!coverageContains(input.record.coverage.consumed, input.record.coverage.captured)
    && input.sources.signals.some((signal) => signal.blocked)) return { outcome: "WAKE", reason: "blocked-report" };
  return { outcome: "DO_NOT_WAKE", reason: "group-can-progress" };
}
