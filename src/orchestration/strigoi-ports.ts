/** Shared resident contracts. Persistence and lifecycle ports are introduced with their consumers. */
export type {
  StrigoiDesired, StrigoiHold, StrigoiIdentity, StrigoiPacketRef, StrigoiPhase,
  StrigoiSelection, StrigoiSourceRef, StrigoiState, StrigoiTransition,
} from "../domain/strigoi.js";

import type { StrigoiState } from "../domain/strigoi.js";

export interface StrigoiRepository {
  read(): Promise<StrigoiState>;
  compareAndSwap(expectedRevision: number, mutationId: string, next: StrigoiState): Promise<StrigoiState>;
  retentionPins(): Promise<ReadonlySet<string>>;
}
