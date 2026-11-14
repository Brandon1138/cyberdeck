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
  readiness: "passive" | "held" | "unconfigured" | "ready";
  adoption: "not-required" | "pending" | "acknowledged";
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

/** Task 7/8 production seams. Neither participant may infer authority from packet prose. */
export interface StrigoiReconciliationParticipant {
  /** Restart-safe: reconcile durable receipts before effects; never reissue ambiguous execution.
   * Participants use shared admission before authority and recheck current desired/identity at
   * their own final effects. Suspension cannot cancel an already-issued external operation. */
  reconcile(identity: StrigoiIdentity, packet: import("../domain/strigoi.js").StrigoiPacketRef): Promise<import("../domain/strigoi.js").StrigoiHold[]>;
}

/** Durable instruction transport. An unknown/rendered attempt MUST only be observed, never retyped. */
export interface StrigoiSuccessionTurns {
  boundary(identity: StrigoiIdentity): Promise<"safe" | "busy" | "modal" | "unknown">;
  observe(id: string, identity: StrigoiIdentity): Promise<{
    outcome: "unknown" | "completed" | "terminated";
    checkpoint?: string;
    adoption?: import("../domain/strigoi.js").StrigoiAdoption;
    usage?: { inputTokens?: number; outputTokens?: number };
  }>;
  /** Persist logical instruction before rendering; final native submission MUST call admit. */
  submit(id: string, identity: StrigoiIdentity, kind: "checkpoint" | "adoption", packet: import("../domain/strigoi.js").StrigoiPacketRef | undefined,
    admit: import("./session/session-ports.js").LaunchAdmission): Promise<void>;
}
