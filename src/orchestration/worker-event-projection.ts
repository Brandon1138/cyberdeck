import type { StoredWorkerEvent } from "../domain/worker-coordination.js";

const SUMMARY_CHARS = 320;
const RECOMMENDATION_CHARS = 240;
const FIELD_CHARS = 160;
const MAX_FACTS = 8;
const MAX_LIST_FIELDS = 3;

/** Material state and deltas only. Transcript-shaped output is never produced by this projection. */
export function compactEvent(event: StoredWorkerEvent): Record<string, unknown> {
  const facts = event.structuredFacts === undefined
    ? undefined
    : Object.fromEntries(
      Object.entries(event.structuredFacts)
        .slice(0, MAX_FACTS)
        .map(([key, value]) => [key, typeof value === "string" ? truncate(value, FIELD_CHARS) : value]),
    );
  return {
    ordinal: event.ordinal,
    eventId: event.eventId,
    workerId: event.workerId,
    ...(event.waveId === undefined ? {} : { waveId: event.waveId }),
    kind: event.kind,
    severity: event.severity,
    interventionRequired: event.interventionRequired,
    continuation: event.continuation,
    state: event.state,
    summary: truncate(event.summary, SUMMARY_CHARS),
    ...(facts === undefined || Object.keys(facts).length === 0 ? {} : { facts }),
    ...(event.changedAssumptions.length === 0
      ? {}
      : { changedAssumptions: event.changedAssumptions.slice(0, MAX_LIST_FIELDS).map((entry) => truncate(entry, FIELD_CHARS)) }),
    ...(event.evidenceRefs.length === 0
      ? {}
      : { evidenceRefs: event.evidenceRefs.slice(0, MAX_LIST_FIELDS).map((entry) => truncate(entry, FIELD_CHARS)) }),
    ...(event.recommendedAction === undefined
      ? {}
      : { recommendedAction: truncate(event.recommendedAction, RECOMMENDATION_CHARS) }),
    ...(event.checkpointCorrelationId === undefined
      ? {}
      : { checkpointCorrelationId: event.checkpointCorrelationId }),
    at: event.timestamp,
  };
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
