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

/**
 * The orchestrator side of the same projection: which session speaks for which durable controller
 * family. Nothing is allocated or stored — the identity is derived from the binding key, so it is
 * the same answer before and after a broker restart, and there is no ledger to reconcile when a
 * binding dies without releasing anything.
 */
export function fleetOrchestratorOwnership(
  bindings: readonly OrchestratorBinding[],
): FleetOrchestratorOwnershipView[] {
  return bindings.map((binding) => ({
    sessionId: binding.sessionId,
    controllerId: orchestratorControllerId(binding.key),
  }));
}
