import type {
  CoordinationTransaction,
  WorkerCoordinationState,
} from "../domain/worker-coordination-state.js";

/**
 * The durable log as coordination uses it: one atomic append, one full replay, and nothing else.
 *
 * Narrow on purpose. Every mutation this service makes is committed through {@link append} as a
 * single transaction, so a port that offered a second way to write would be a second way to tear
 * one.
 */
export interface WorkerCoordinationRepository {
  append(transaction: CoordinationTransaction): Promise<void>;
  load(): Promise<WorkerCoordinationState>;
}
