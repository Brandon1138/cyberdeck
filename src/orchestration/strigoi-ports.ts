/** Shared resident contracts. Persistence and lifecycle ports are introduced with their consumers. */
export type {
  StrigoiDesired, StrigoiHold, StrigoiIdentity, StrigoiPacketRef, StrigoiPhase,
  StrigoiSelection, StrigoiSourceRef, StrigoiState, StrigoiTransition,
} from "../domain/strigoi.js";

import type { InstructionAdmission, InstructionRecord } from "../domain/instruction.js";
import type { StrigoiIdentity, StrigoiState } from "../domain/strigoi.js";

export interface StrigoiRepository {
  read(): Promise<StrigoiState>;
  compareAndSwap(expectedRevision: number, mutationId: string, next: StrigoiState): Promise<StrigoiState>;
  retentionPins(): Promise<ReadonlySet<string>>;
}

/** Internal application boundary; never expose operation classification in RPC schemas. */
export interface StrigoiAdmissionPort {
  run<T>(actorSessionId: string, operation: "read" | "mutate" | "recovery", apply: () => Promise<T>): Promise<T>;
  freeze(identity: StrigoiIdentity): Promise<void>;
  /** Internal explicit abort/resume only, after durable state authorizes reopening. */
  reopen(identity: StrigoiIdentity): Promise<void>;
  instruction(record: InstructionRecord): InstructionAdmission;
}
