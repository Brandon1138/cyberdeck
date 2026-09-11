import type { InstructionLifecycleState } from "../../domain/worker-truth.js";
import type { WorkerResultSnapshot } from "./session-ports.js";
import type { WorkerTurnTranscript } from "./worker-turn-ports.js";

export interface CompletionLedgerEntry {
  text: string;
  completedAt: string;
  deliveries: number;
  provenance: "provider-transcript" | "terminal-replay";
}

export interface RenderedInstruction {
  instructionId: string;
  expectedTurn: number;
  renderedAt: string;
  state: InstructionLifecycleState;
}

export interface StallObservation {
  version: number;
  tokenCount: number;
  unchangedSinceMs: number;
}

export interface WorkerStatusReading {
  status: WorkerResultSnapshot["status"];
  stalled?: { stalledForSeconds: number; tokenCount: number };
}

export interface TurnCaptureClaim {
  kind: "screen" | "reconcile";
  epoch: number;
  revision: number;
  activityRevision: number;
  completionTarget: number;
  bankedThrough?: number;
  settlement: Promise<void>;
  settle(): void;
}

export interface BankedTurnReceipt {
  bankedThrough: number;
  latest: string;
  provenance: CompletionLedgerEntry["provenance"];
}

export interface PendingTurnCommit {
  reservationThrough: number;
  settlement: Promise<void>;
  poisoned: boolean;
}

export interface ScreenCompletionEvidence {
  replay: string;
  text: string;
  activityRevision: number;
}

export type TurnCommitOutcome =
  | {
      status: "committed";
      turns: WorkerTurnTranscript[];
      banked?: BankedTurnReceipt;
    }
  | { status: "failed" };

