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
}

/** Read-only Fleet projection. Lease tokens, hashes, and audit details stay broker-private. */
export function fleetWorkerCoordinationView(
  subjects: readonly OwnershipSubject[],
): FleetWorkerCoordinationView[] {
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
    }];
  });
}
