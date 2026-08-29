import type {
  CheckpointRequest,
  ControllerLiveness,
  MutationReceipt,
  OwnershipAuditRecord,
  OwnershipSubject,
  StoredWorkerEvent,
} from "./worker-coordination.js";
import type { WorkerHandoff } from "./worker-handoff.js";

/**
 * One atomic append. Every record a single coordination mutation produces travels together, so a
 * torn write cannot leave a subject without the audit that explains it.
 */
export interface CoordinationTransaction {
  subjects?: OwnershipSubject[];
  events?: StoredWorkerEvent[];
  checkpoints?: CheckpointRequest[];
  audits?: OwnershipAuditRecord[];
  liveness?: ControllerLiveness[];
  handoffs?: WorkerHandoff[];
  receipts?: MutationReceipt[];
}

/** Everything a replay of the coordination log reconstructs. */
export interface WorkerCoordinationState {
  subjects: OwnershipSubject[];
  events: StoredWorkerEvent[];
  checkpoints: CheckpointRequest[];
  audits: OwnershipAuditRecord[];
  liveness: ControllerLiveness[];
  handoffs: WorkerHandoff[];
  receipts: MutationReceipt[];
}
