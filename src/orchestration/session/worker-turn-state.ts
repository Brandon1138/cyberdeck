import type { InstructionLifecycleState, WorkerStallReason } from "../../domain/worker-truth.js";
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

/**
 * A frozen Cursor session never goes byte-quiet: the TUI keeps repainting its status line, so
 * {@link StallObservation}'s version check resets on every chunk and the idle stall clock never
 * runs. This observation ages on token *progress* instead — the counter must advance meaningfully
 * for the turn to count as live.
 */
export interface WorkingStallObservation {
  tokenCount: number;
  unchangedSinceMs: number;
}

export interface StallReading {
  stalledForSeconds: number;
  tokenCount: number;
  reason: WorkerStallReason;
}

export interface WorkerStatusReading {
  status: WorkerResultSnapshot["status"];
  stalled?: StallReading;
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

