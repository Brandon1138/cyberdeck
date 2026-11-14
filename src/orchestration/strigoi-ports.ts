/** Shared resident contracts. Persistence and lifecycle ports are introduced with their consumers. */
export type {
  StrigoiDesired, StrigoiHold, StrigoiIdentity, StrigoiPacketRef, StrigoiPhase,
  StrigoiSelection, StrigoiSourceRef, StrigoiState, StrigoiTransition,
} from "../domain/strigoi.js";

import type { InstructionAdmission, InstructionRecord } from "../domain/instruction.js";
import type { StrigoiIdentity, StrigoiState } from "../domain/strigoi.js";
import type { SessionRecord } from "../domain/session.js";

export interface StrigoiInspection {
  state: StrigoiState;
  runtime?: SessionRecord;
  ownership: "owned" | "unknown" | "none";
  readiness: "passive" | "held" | "unconfigured";
  adoption: "not-required" | "pending";
  usage: "unknown";
}

export interface StrigoiRepository {
  read(): Promise<StrigoiState>;
  compareAndSwap(expectedRevision: number, mutationId: string, next: StrigoiState): Promise<StrigoiState>;
  /** Confirm a visible mutation is durable before replay reports success. */
  confirmMutation(mutationId: string): Promise<void>;
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

/** Immutable copies and paged inventories; the implementation owns artifact integrity checks. */
export interface StrigoiPacketPort {
  verify(sources: import("../domain/strigoi.js").StrigoiSourceRef[]): Promise<void>;
  copy(ref: import("../domain/strigoi.js").StrigoiSourceRef, text: string, sessionIds: string[]): Promise<import("../domain/strigoi.js").StrigoiSourceRef[]>;
  write(identity: StrigoiIdentity, prose: string, sources: import("../domain/strigoi.js").StrigoiSourceRef[], at: string): Promise<import("../domain/strigoi.js").StrigoiPacketRef>;
  read(ref: import("../domain/strigoi.js").StrigoiPacketRef, cursor?: string): Promise<{
    packet: import("../domain/strigoi.js").StrigoiPacket; sources: import("../domain/strigoi.js").StrigoiSourceRef[]; nextCursor?: string;
  }>;
}
export interface StrigoiSourcePort {
  capture(state: StrigoiState): Promise<import("../domain/strigoi.js").StrigoiSourceRef[]>;
}
