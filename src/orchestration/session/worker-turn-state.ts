import type { InstructionLifecycleState } from "../../domain/worker-truth.js";
import type { WorkerResultSnapshot } from "./session-ports.js";
import type { WorkerTurnTranscript, WorkerTurnLedger, WorkerTurnTranscriptPort } from "./worker-turn-ports.js";

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
  /**
   * The head of the message as written, normalized the way the composer reading normalizes what
   * it sees. Submit verification presses Enter only for a composer whose content matches this;
   * an entry restored without one (older persisted records) is never pressed for.
   */
  messageHead?: string;
  /** The message's length, so a provider's `[Pasted Content N chars]` placeholder can stand for it. */
  messageLength?: number;
  /** The provider's bare submit keystroke; absent means a carriage return. */
  submitKey?: Buffer;
  /** How many times verification has pressed Enter for this entry. */
  submitPresses?: number;
}

export interface StallObservation {
  version: number;
  transcriptVersion?: string;
  tokenCount: number;
  unchangedSinceMs: number;
}

/** Transcript movement and terminal counters restart one shared inactivity clock. */
export class WorkerStallTracker {
  observation?: StallObservation;
  reset(): void { delete this.observation; }
  update(version: number, tokenCount: number | undefined, transcriptVersion: string | undefined, now: number): void {
    if (tokenCount === undefined) { this.reset(); return; }
    const previous = this.observation;
    if (previous === undefined || previous.version !== version || previous.tokenCount !== tokenCount
      || previous.transcriptVersion !== transcriptVersion) {
      this.observation = { version, tokenCount, unchangedSinceMs: now,
        ...(transcriptVersion === undefined ? {} : { transcriptVersion }) };
    }
  }
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

/** Bounded result receipts plus durable aggregate counts; restored once per engine. */
export class WorkerCompletionLedger {
  completedTurns = 0;
  canonicalTurns = 0;
  readonly completions = new Map<number, CompletionLedgerEntry>();
  private restored = false;

  record(ordinal: number, text: string, provenance: CompletionLedgerEntry["provenance"]): CompletionLedgerEntry {
    this.completedTurns = Math.max(this.completedTurns, ordinal);
    const existing = this.completions.get(ordinal);
    if (existing !== undefined) return existing;
    if (provenance === "provider-transcript") this.canonicalTurns += 1;
    const entry: CompletionLedgerEntry = { text, provenance, completedAt: new Date().toISOString(), deliveries: 0 };
    this.completions.set(ordinal, entry);
    while (this.completions.size > 64) this.completions.delete(Math.min(...this.completions.keys()));
    return entry;
  }

  needsRestore(provider: string, transcripts: WorkerTurnTranscriptPort | undefined): boolean {
    return !this.restored && provider === "claude" && transcripts?.readCompletionLedger !== undefined;
  }

  async restore(transcripts: WorkerTurnTranscriptPort, sessionId: string,
    current: () => boolean): Promise<WorkerTurnLedger | undefined> {
    const ledger = await transcripts.readCompletionLedger!(sessionId);
    if (!current()) return undefined;
    for (const turn of ledger.turns) {
      const ordinal = turn.data?.turnNumber;
      if (typeof ordinal === "number") this.record(ordinal, turn.text ?? "",
        turn.data?.transport === "provider-native" ? "provider-transcript" : "terminal-replay");
    }
    this.completedTurns = Math.max(this.completedTurns, ledger.completedTurns);
    this.canonicalTurns = Math.max(this.canonicalTurns, ledger.canonicalTurns);
    this.restored = true;
    return ledger;
  }
}

/** Native polling and terminal quiet-time reconciliation share the engine's generation fence. */
export class WorkerTurnReconciler {
  private quietTimer?: ReturnType<typeof setTimeout>;
  private pollTimer?: ReturnType<typeof setTimeout>;
  constructor(private readonly host: {
    interval: number;
    epoch(): number;
    canPoll(): boolean;
    canReconcile(): boolean;
    active(): boolean;
    reconcile(): Promise<void>;
  }) {}

  armQuiet(): void {
    if (!this.host.canReconcile()) return;
    if (this.quietTimer !== undefined) clearTimeout(this.quietTimer);
    const epoch = this.host.epoch();
    this.quietTimer = setTimeout(() => {
      delete this.quietTimer;
      if (this.host.epoch() === epoch) void this.host.reconcile().catch(() => undefined);
    }, this.host.interval);
    this.quietTimer.unref?.();
  }

  armPoll(): void {
    if (!this.host.canPoll() || this.pollTimer !== undefined) return;
    const epoch = this.host.epoch();
    this.pollTimer = setTimeout(() => {
      delete this.pollTimer;
      void this.host.reconcile().catch(() => undefined).finally(() => {
        if (this.host.epoch() === epoch && this.host.active()) this.armPoll();
      });
    }, this.host.interval);
    this.pollTimer.unref?.();
  }

  release(): void {
    if (this.quietTimer !== undefined) clearTimeout(this.quietTimer);
    if (this.pollTimer !== undefined) clearTimeout(this.pollTimer);
    delete this.quietTimer;
    delete this.pollTimer;
  }
}

