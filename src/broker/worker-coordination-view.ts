import { custodyColor, type CustodyColor, type CustodyColorTable } from "../domain/custody-color.js";
import { orchestratorControllerId, type OrchestratorBinding } from "../domain/orchestrator.js";
import { TERMINAL_WORKER_LIFECYCLES, type LeaseState, type OwnershipSubject } from "../domain/worker-coordination.js";

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
  /** Which orchestrator this worker belongs to, in hue. Absent means the natural, uncolored row. */
  custodyColor?: CustodyColor;
}

/** Which slot each bound orchestrator's own row wears. Peers hold no controller identity, so none. */
export interface FleetOrchestratorCustodyColorView {
  sessionId: string;
  slot: number;
}

export interface FleetWorkerCoordinationViewOptions {
  custodyColors?: CustodyColorTable;
  now?: string;
}

/** Read-only Fleet projection. Lease tokens, hashes, and audit details stay broker-private. */
export function fleetWorkerCoordinationView(
  subjects: readonly OwnershipSubject[],
  options: FleetWorkerCoordinationViewOptions = {},
): FleetWorkerCoordinationView[] {
  const custodyColors = options.custodyColors ?? [];
  const now = options.now ?? new Date().toISOString();
  return subjects.flatMap((subject): FleetWorkerCoordinationView[] => {
    const sessionId = subject.resources.sessionId;
    if (subject.subjectKind !== "worker" || sessionId === undefined) return [];
    const controller = (
      subject.lease.state === "active"
      || subject.lease.state === "contested"
    )
      ? subject.lease.controller
      : undefined;
    const adoptable = (
      subject.lease.state === "orphaned"
      || subject.lease.state === "expired"
    ) && !TERMINAL_WORKER_LIFECYCLES.has(subject.lifecycle);
    const color = custodyColor(subject, custodyColors, now);
    return [{
      sessionId,
      subjectId: subject.subjectId,
      origin: {
        creatorControllerId: subject.origin.creatorControllerId,
        ...(subject.origin.creatorSessionId === undefined
          ? {}
          : { creatorSessionId: subject.origin.creatorSessionId }),
        taskId: subject.origin.taskId,
        ...(subject.origin.waveId === undefined ? {} : { waveId: subject.origin.waveId }),
        threadId: subject.origin.threadId,
        createdAt: subject.origin.createdAt,
      },
      ...(controller === undefined
        ? {}
        : {
          currentController: {
            controllerId: controller.controllerId,
            familyId: controller.familyId,
            scope: `${controller.scope.kind}:${controller.scope.scopeId}`,
          },
        }),
      leaseHealth: subject.lease.state,
      orphaned: subject.lease.state === "orphaned",
      adoptable,
      ...(color === undefined ? {} : { custodyColor: color }),
    }];
  });
}

/**
 * The orchestrator side of the same projection. Slots are held by durable controller families,
 * and a session only appears here while it is the session its family's binding points at, so a
 * rebound scope moves the hue with the binding instead of leaving it on a dead row.
 */
export function fleetOrchestratorCustodyColors(
  bindings: readonly OrchestratorBinding[],
  custodyColors: CustodyColorTable,
): FleetOrchestratorCustodyColorView[] {
  return bindings.flatMap((binding): FleetOrchestratorCustodyColorView[] => {
    const assignment = custodyColors.find((entry) =>
      entry.controllerId === orchestratorControllerId(binding.key));
    return assignment === undefined
      ? []
      : [{ sessionId: binding.sessionId, slot: assignment.slot }];
  });
}
