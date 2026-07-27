import type { WorkerCoordinationService } from "../broker/worker-coordination.js";
import type { StoredWorkerEvent } from "../domain/worker-coordination.js";

export const MAX_WAIT_INTERVENTION_EVENTS = 16;

export interface WaitInterventionEventSummary {
  eventId: string;
  workerId: string;
  taskId: string;
  waveId?: string;
  sequence: number;
  kind: "EXCEPTION" | "DECISION_REQUEST";
  severity: StoredWorkerEvent["severity"];
  summary: string;
  continuation: StoredWorkerEvent["continuation"];
  recommendedAction?: string;
  timestamp: string;
}

export interface WaitInterventionSummary {
  events: WaitInterventionEventSummary[];
  truncated: boolean;
}

export interface WorkerInterventionProjection {
  listSubjects(): ReturnType<WorkerCoordinationService["listSubjects"]>;
  projectEvents: WorkerCoordinationService["projectEvents"];
}

/**
 * Projects only unresolved, bounded intervention summaries for named worker sessions.
 * Transcript bytes and internal persistence metadata never enter this result.
 */
export function projectWaitInterventions(
  coordination: WorkerInterventionProjection,
  sessionIds: readonly string[],
): WaitInterventionSummary | undefined {
  const targetIds = new Set(sessionIds);
  const subjectBySession = new Map(coordination.listSubjects()
    .filter((subject) =>
      subject.subjectKind === "worker"
      && subject.resources.sessionId !== undefined
      && targetIds.has(subject.resources.sessionId))
    .map((subject) => [subject.resources.sessionId!, subject.subjectId] as const));
  const workerIds = [...targetIds].map((sessionId) => subjectBySession.get(sessionId) ?? sessionId);
  const projection = coordination.projectEvents({
    limit: MAX_WAIT_INTERVENTION_EVENTS,
    filter: {
      workerIds,
      kinds: ["EXCEPTION", "DECISION_REQUEST"],
      intervention: "unresolved",
    },
  });
  if (projection.events.length === 0) return undefined;
  return {
    events: projection.events
      .slice(0, MAX_WAIT_INTERVENTION_EVENTS)
      .map(summarizeIntervention),
    truncated: projection.hasMore
      || projection.events.length > MAX_WAIT_INTERVENTION_EVENTS,
  };
}

function summarizeIntervention(event: StoredWorkerEvent): WaitInterventionEventSummary {
  if (event.kind !== "EXCEPTION" && event.kind !== "DECISION_REQUEST") {
    throw new Error(`Cannot summarize non-intervention event ${event.kind}`);
  }
  return {
    eventId: event.eventId,
    workerId: event.workerId,
    taskId: event.taskId,
    ...(event.waveId === undefined ? {} : { waveId: event.waveId }),
    sequence: event.sequence,
    kind: event.kind,
    severity: event.severity,
    summary: event.summary,
    continuation: event.continuation,
    ...(event.recommendedAction === undefined
      ? {}
      : { recommendedAction: event.recommendedAction }),
    timestamp: event.timestamp,
  };
}
