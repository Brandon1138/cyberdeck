import type { SessionRecord } from "./session.js";
import type { LeaseState } from "./worker-coordination.js";

export interface FleetWorkerCoordinationView {
  sessionId: string;
  subjectId: string;
  origin: {
    creatorControllerId: string;
    creatorSessionId?: string;
    taskId: string;
    waveId?: string;
    threadId: string;
    createdAt: string;
  };
  currentController?: {
    controllerId: string;
    familyId: string;
    scope: string;
  };
  leaseHealth: LeaseState;
  orphaned: boolean;
  adoptable: boolean;
}

/**
 * The durable controller family each bound orchestrator session speaks for.
 *
 * This is the other half of a worker's `currentController`: Fleet joins the two to say which
 * row on the roster owns which worker row. Sessions are named rather than bindings because a
 * rebound scope moves the identity onto the new session, and a session only appears while it is
 * the one its family's binding points at.
 */
export interface FleetOrchestratorOwnershipView {
  sessionId: string;
  controllerId: string;
}


/** Display data only. Full launch details remain available through session.get. */
export interface FleetProjectionSnapshot {
  threads: Array<{ record: SessionRecord; coordination?: FleetWorkerCoordinationView; controllerId?: string }>;
  projects?: readonly string[];
}
export type FleetProjectionReply =
  | { kind: "full"; version: string; snapshot: FleetProjectionSnapshot }
  | { kind: "delta"; version: string; baseVersion: string; upsert: FleetProjectionSnapshot["threads"]; remove: string[]; order?: string[]; projects?: readonly string[] }
  | { kind: "unchanged"; version: string };
