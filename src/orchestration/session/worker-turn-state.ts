import type { InstructionLifecycleState } from "../../domain/worker-truth.js";
import type { WorkerTruth } from "../../domain/worker-truth.js";
import type { WorkerResultSnapshot } from "./session-ports.js";
import type { WorkerTurnTranscript, WorkerTurnLedger, WorkerTurnTranscriptPort } from "./worker-turn-ports.js";

export interface CompletionLedgerEntry {
  outcome?: "cancelled";
  text: string;
  completedAt: string;
  deliveries: number;
  provenance: "provider-transcript" | "terminal-replay" | "broker-lifecycle";
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
  tokenCount?: number;
  unchangedSinceMs: number;
}

/** Transcript movement and terminal counters restart one shared inactivity clock. */
export class WorkerStallTracker {
  observation?: StallObservation;
  reset(): void { delete this.observation; }
  update(version: number, tokenCount: number | undefined, transcriptVersion: string | undefined, now: number): void {
    const previous = this.observation;
    if (previous === undefined || previous.version !== version || previous.tokenCount !== tokenCount
      || previous.transcriptVersion !== transcriptVersion) {
      this.observation = { version, ...(tokenCount === undefined ? {} : { tokenCount }), unchangedSinceMs: now,
        ...(transcriptVersion === undefined ? {} : { transcriptVersion }) };
    }
  }
}

export interface WorkerStatusReading {
  status: WorkerResultSnapshot["status"];
  stalled?: { stalledForSeconds: number; tokenCount?: number };
}

export function targetWaitReading(input: {
  truth: WorkerTruth; target: number; delivered: boolean; turnsBeforeLatestInstruction: number;
  cancelled: boolean; retained: boolean;
  scoutBudgetExhausting: boolean; scoutTerminal?: string; exitCode: number | null; tokenCount?: number;
}): WorkerStatusReading {
  if (input.scoutBudgetExhausting || (input.scoutTerminal === "budget_exhausted" && input.exitCode === null)) {
    return { status: "waiting" };
  }
  if (input.scoutTerminal === "budget_exhausted") return { status: "budget_exhausted" };
  if (input.cancelled) return { status: "stopped" };
  if (input.retained && input.truth.completedTurns >= input.target && (input.delivered || input.target > input.turnsBeforeLatestInstruction)) {
    return { status: "completed" };
  }
  return waitReading(input.truth, input.tokenCount);
}

/** A target receipt and current agent activity answer different questions. */
export function waitReading(truth: WorkerTruth, tokenCount?: number): WorkerStatusReading {
  switch (truth.state) {
    case "provider-limit": return { status: "provider-limit" };
    case "errored":
    case "failed": return { status: "failed" };
    case "stopped": return { status: "stopped" };
    case "interrupted": return { status: "interrupted" };
    case "exited": return { status: "exited" };
    case "blocked-modal":
    case "blocked-composer": return { status: "needs-input" };
    case "stalled": return { status: "stalled", stalled: {
      stalledForSeconds: truth.stalledForSeconds!, ...(tokenCount === undefined ? {} : { tokenCount }),
    } };
    case "working": return { status: "working" };
    default: return { status: "waiting" };
  }
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
  outcomes: Array<{ turn: number; state: "completed" | "cancelled" }>;
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

/** Capture ownership reserves an ordinal until its durable settlement has drained. */
export function completionReservationFloor(completed: number, barrier: number, deferred: number | undefined,
  pending: number | undefined, owner: TurnCaptureClaim | undefined, current: boolean): number {
  return Math.max(completed, barrier, deferred ?? 0, pending ?? 0, current ? owner?.completionTarget ?? 0 : 0);
}

/** Bounded result receipts plus durable aggregate counts; restored once per engine. */
export class WorkerCompletionLedger {
  completedTurns = 0;
  canonicalTurns = 0;
  readonly completions = new Map<number, CompletionLedgerEntry>();
  private restored = false;
  private readonly protectedTargets = new Set<number>();
  private readonly protectedOutcomes = new Map<number, "completed" | "cancelled">();

  record(ordinal: number, text: string, provenance: CompletionLedgerEntry["provenance"], outcome?: "cancelled"): CompletionLedgerEntry {
    this.completedTurns = Math.max(this.completedTurns, ordinal);
    const existing = this.completions.get(ordinal);
    if (existing !== undefined) return existing;
    if (provenance === "provider-transcript") this.canonicalTurns += 1;
    const entry: CompletionLedgerEntry = { text, provenance, completedAt: new Date().toISOString(), deliveries: 0,
      ...(outcome === undefined ? {} : { outcome }) };
    this.completions.set(ordinal, entry);
    if (this.protectedTargets.has(ordinal)) this.protectedOutcomes.set(ordinal, outcome ?? "completed");
    while (this.completions.size > 64) this.completions.delete(Math.min(...this.completions.keys()));
    return entry;
  }

  protect(target: number): void {
    this.protectedTargets.add(target);
    const entry = this.completions.get(target);
    if (entry !== undefined) this.protectedOutcomes.set(target, entry.outcome ?? "completed");
  }
  outcome(target: number): "completed" | "cancelled" | undefined { return this.protectedOutcomes.get(target) ?? (this.completions.has(target) ? this.completions.get(target)!.outcome ?? "completed" : undefined); }
  releaseOutcomes(targets: readonly number[]): void {
    for (const target of targets) { this.protectedTargets.delete(target); this.protectedOutcomes.delete(target); }
  }
  outcomesSince(ordinal: number): BankedTurnReceipt["outcomes"] {
    const outcomes = new Map([...this.completions.entries()].map(([turn, entry]) => [turn, entry.outcome ?? "completed"] as const));
    for (const [turn, state] of this.protectedOutcomes) outcomes.set(turn, state);
    return [...outcomes.entries()].filter(([turn]) => turn > ordinal).map(([turn, state]) => ({ turn, state }));
  }

  wait(input: Omit<Parameters<typeof targetWaitReading>[0], "cancelled" | "retained" | "delivered">): WorkerStatusReading {
    const entry = this.completions.get(input.target);
    return targetWaitReading({ ...input, cancelled: entry?.outcome === "cancelled", retained: entry !== undefined, delivered: (entry?.deliveries ?? 0) > 0 });
  }

  needsRestore(provider: string, transcripts: WorkerTurnTranscriptPort | undefined): boolean {
    return !this.restored && transcripts?.readCompletionLedger !== undefined;
  }

  async restore(transcripts: WorkerTurnTranscriptPort, sessionId: string,
    current: () => boolean): Promise<WorkerTurnLedger | undefined> {
    const ledger = await transcripts.readCompletionLedger!(sessionId);
    if (!current()) return undefined;
    for (const turn of ledger.turns) {
      const ordinal = turn.data?.turnNumber;
      if (typeof ordinal === "number") this.record(ordinal, turn.text ?? "",
        turn.data?.transport === "provider-native" ? "provider-transcript" : turn.data?.transport === "broker-lifecycle" ? "broker-lifecycle" : "terminal-replay",
        turn.data?.outcome === "cancelled" ? "cancelled" : undefined);
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

