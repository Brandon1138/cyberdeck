import type { SessionRecord } from "../../domain/session.js";
import {
  advanceInstruction,
  DELIVERY_HOLD_DETAIL,
  projectWorkerTruth,
  providerLimitFromTermination,
  type ComposerObservation,
  type DeliveryHoldReason,
  type InstructionLifecycleState,
  type ProviderLimitTermination,
  type SessionTermination,
  type WorkerTruth,
} from "../../domain/worker-truth.js";
import type {
  InstructionDelivery,
  InstructionStateUpdate,
  WorkerResultSnapshot,
} from "./session-ports.js";
import type {
  RenderedWorkerInstruction,
  ReplayObservation,
  SubmitWorkerInstruction,
  WorkerTurnEngineEffects,
  WorkerTurnObservation,
  WorkerTurnObservationPort,
  WorkerTurnPreviewPort,
  WorkerTurnTranscript,
  WorkerTurnTranscriptMessage,
  WorkerTurnTranscriptPort,
} from "./worker-turn-ports.js";

interface CompletionLedgerEntry {
  text: string;
  completedAt: string;
  deliveries: number;
  provenance: "provider-transcript" | "terminal-replay";
}

interface RenderedInstruction {
  instructionId: string;
  expectedTurn: number;
  renderedAt: string;
  state: InstructionLifecycleState;
}

interface StallObservation {
  version: number;
  tokenCount: number;
  unchangedSinceMs: number;
}

interface WorkerStatusReading {
  status: WorkerResultSnapshot["status"];
  stalled?: { stalledForSeconds: number; tokenCount: number };
}

interface TurnCaptureClaim {
  kind: "screen" | "reconcile";
  epoch: number;
  revision: number;
  activityRevision: number;
  completionTarget: number;
  bankedThrough?: number;
  settlement: Promise<void>;
  settle(): void;
}

interface BankedTurnReceipt {
  bankedThrough: number;
  latest: string;
  provenance: CompletionLedgerEntry["provenance"];
}

interface PendingTurnCommit {
  reservationThrough: number;
  settlement: Promise<void>;
  poisoned: boolean;
}

interface ScreenCompletionEvidence {
  replay: string;
  text: string;
  activityRevision: number;
}

type TurnCommitOutcome =
  | {
      status: "committed";
      turns: WorkerTurnTranscript[];
      banked?: BankedTurnReceipt;
    }
  | { status: "failed" };

export interface WorkerTurnAppendResult {
  fatal: boolean;
  termination?: SessionTermination;
}

export interface WorkerTurnEngineFactoryOptions {
  observations: WorkerTurnObservationPort;
  preview?: WorkerTurnPreviewPort;
  transcripts?: WorkerTurnTranscriptPort;
  effects: WorkerTurnEngineEffects;
  workerStallSeconds: number;
  now?: () => number;
}

const MAX_COMPLETION_LEDGER_ENTRIES = 64;
const TRANSCRIPT_RETRY_BASE_MS = 50;
const CANONICAL_RECONCILE_QUIET_MS = 1_500;
const SCREEN_TURN_BANK_MS = 200;
const PREVIEW_STORAGE_LIMIT = 600;
const TAIL_BYTES = 4_000;

/** Creates one isolated application truth component for each durable session record. */
export class WorkerTurnEngineFactory {
  constructor(private readonly options: WorkerTurnEngineFactoryOptions) {}

  create(record: SessionRecord, replayChars: number): WorkerTurnEngine {
    return new WorkerTurnEngine(record, replayChars, this.options);
  }
}

/**
 * Owns the turn, instruction, completion, and projection truth for one worker session.
 *
 * Process handles, attachment clients, provider launch descriptions, and Scout persistence stay at
 * the registry boundary. Everything learned from terminal or transcript observations is folded here.
 */
export class WorkerTurnEngine {
  private readonly replay: ReplayObservation;
  private activity: ReturnType<WorkerTurnObservationPort["activity"]> = "unknown";
  private observedWorking = false;
  private completedTurnCount = 0;
  private canonicalTurnCount = 0;
  private turnsBeforeLatestInstruction = 0;
  private composer: ComposerObservation = { modalOpen: false, occupied: false };
  private rendered: RenderedInstruction[] = [];
  private deliveryHeld = false;
  private currentProviderLimit: ProviderLimitTermination | undefined;
  private currentLatestResult: string | undefined;
  private fatalReported = false;
  private readonly completions = new Map<number, CompletionLedgerEntry>();
  private idleTimer?: ReturnType<typeof setTimeout>;
  private canonicalReconcileTimer?: ReturnType<typeof setTimeout>;
  /** Fences every asynchronous observation against terminal release and process replacement. */
  private observationEpoch = 0;
  /** Changes on every capture acquisition/release so an owner-free async read cannot ABA. */
  private observationRevision = 0;
  /** Changes whenever newer terminal or instruction activity can make completion UI effects stale. */
  private activityRevision = 0;
  /** The one capture allowed to commit the next completion ordinal in this epoch. */
  private turnCaptureOwner?: TurnCaptureClaim;
  /** Every observation/commit pipeline that began before the current lifecycle fence. */
  private readonly pendingTurnCaptures = new Set<Promise<void>>();
  /** The visible completion ordinal observed while another capture still owned the ledger. */
  private deferredScreenCompletionTarget?: number;
  /** Durable ordinals synchronously reserved when a provider-turn commit is enqueued. */
  private pendingTurnCommit?: PendingTurnCommit;
  /** Monotonic ordinal high-water frozen at every process-generation fence. */
  private completionBarrierFloor = 0;
  /** Exact terminal fallback evidence, retained by the semantic ordinal whose screen proved it. */
  private readonly screenCompletionEvidence = new Map<number, ScreenCompletionEvidence>();
  /** Lazy raw replay reader for the currently armed 200 ms screen bank. */
  private armedScreenReplay?: () => string;
  /** Activity revision whose completed screen armed the current bank. */
  private armedScreenActivityRevision?: number;
  /** The process exited, but its last exact semantic receipt has not finished settling yet. */
  private terminalFinalizing = false;
  private suppressSemanticTurns?: boolean;
  private stallObservation?: StallObservation;

  constructor(
    private readonly record: SessionRecord,
    replayChars: number,
    private readonly options: WorkerTurnEngineFactoryOptions,
  ) {
    this.replay = options.observations.createReplay(replayChars);
    this.currentProviderLimit = providerLimitFromTermination(record.termination);
  }

  get completedTurns(): number {
    return this.completedTurnCount;
  }

  get canonicalTurns(): number {
    return this.canonicalTurnCount;
  }

  get latestResult(): string | undefined {
    return this.currentLatestResult;
  }

  get providerLimit(): ProviderLimitTermination | undefined {
    return this.currentProviderLimit;
  }

  /** The initialization transcript is provider setup, never the worker's first semantic turn. */
  suppressTurns(): void {
    this.suppressSemanticTurns = true;
  }

  /** Start interpreting provider output after initialization without carrying setup activity over. */
  finishInitialization(): void {
    this.activity = "unknown";
    this.observedWorking = false;
    delete this.stallObservation;
    delete this.suppressSemanticTurns;
  }

  /** Reset only the replay observation when a new process generation is adopted. */
  resetReplay(replay: string): void {
    this.replay.reset(replay);
  }

  /** Reset generation-local truth while preserving the durable completion ledger. */
  resetForResume(): void {
    this.terminalFinalizing = false;
    this.activity = "unknown";
    this.observedWorking = false;
    this.fatalReported = false;
    this.currentProviderLimit = undefined;
    delete this.stallObservation;
    this.releaseTimers();
  }

  setLatestResult(result: string | undefined): void {
    this.currentLatestResult = result;
  }

  setLatestResultIfAbsent(result: string): void {
    this.currentLatestResult ??= result;
  }

  resetStallObservation(): void {
    delete this.stallObservation;
  }

  appendOutput(
    chunk: Buffer,
    rawReplay: () => string = () => this.options.effects.snapshot() ?? "",
    interpret = true,
  ): WorkerTurnAppendResult {
    this.replay.appendBytes(chunk);
    if (!interpret) return { fatal: false };
    if (this.record.executionState === "errored") {
      return {
        fatal: true,
        ...(this.record.termination === undefined ? {} : { termination: this.record.termination }),
      };
    }
    this.activityRevision += 1;
    const termination = this.observeFatalTermination(rawReplay);
    if (termination !== undefined) return { fatal: true, termination };

    const activity = this.options.observations.activity(this.record.provider, this.replay);
    if (activity === "working") {
      this.observedWorking = true;
      if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
      delete this.idleTimer;
      delete this.armedScreenReplay;
      delete this.armedScreenActivityRevision;
      if (this.record.attentionState !== "working") {
        void this.options.effects.setAttention("working", false);
      }
    }
    this.activity = activity;
    this.observeComposer();
    if (activity === "working" && !this.composer.occupied) {
      this.advanceRenderedInstructions("submitted");
      this.advanceRenderedInstructions("acknowledged");
    }
    this.notifyDeliveryBoundary();
    if (this.suppressSemanticTurns === true) {
      this.options.effects.scheduleSessionUpdate?.();
      return { fatal: false };
    }

    this.updateStallObservation();
    if (activity === "awaiting-input" && this.observedWorking) {
      this.armScreenTurnBank(rawReplay);
    } else if (activity === "needs-input") {
      this.currentLatestResult = this.options.observations.compactFrame(this.replay.frameText());
      if (this.record.attentionState !== "needs-input") {
        const epoch = this.observationEpoch;
        const revision = this.observationRevision;
        const activityRevision = this.activityRevision;
        const owner = this.turnCaptureOwner;
        void this.options.effects.setAttention("needs-input", true);
        void this.refreshPreview(
          rawReplay(),
          [],
          epoch,
          revision,
          owner,
          activityRevision,
        ).catch(() => undefined);
        void this.refreshObservedModel(
          epoch,
          revision,
          owner,
          activityRevision,
        ).catch(() => undefined);
      }
    }
    this.armCanonicalReconcile();
    this.options.effects.scheduleSessionUpdate?.();
    return { fatal: false };
  }

  async submitInstruction(input: SubmitWorkerInstruction): Promise<InstructionDelivery> {
    if (this.record.executionState !== "active" || this.terminalFinalizing) {
      return this.terminalDelivery(input.source, input.instructionId);
    }
    const hold = this.deliveryHold();
    if (hold !== undefined) return this.holdInstruction(hold, input.source, input.instructionId);
    // Accepted input is newer than every completion-side preview/model/attention effect currently
    // awaiting I/O. It must synchronously fence those effects before this method performs any await.
    this.activityRevision += 1;
    const encoded = typeof input.encoded === "function" ? input.encoded() : input.encoded;
    delete this.stallObservation;
    const at = new Date().toISOString();
    const completionFloor = this.completionReservationFloor();
    const expectedTurn = completionFloor + 1;
    this.turnsBeforeLatestInstruction = completionFloor;
    if (input.instructionId !== undefined) {
      this.rendered.push({
        instructionId: input.instructionId,
        expectedTurn,
        renderedAt: at,
        state: "rendered",
      });
    }
    this.options.effects.write(encoded);
    await this.appendTranscript("instruction", input.source, input.message, {
      ...(input.metadata ?? {}),
      instructionState: "rendered" satisfies InstructionLifecycleState,
      expectedTurn,
      ...(input.instructionId === undefined ? {} : { instructionId: input.instructionId }),
    });
    await this.options.effects.setAttention("working", true);
    await this.options.effects.appendEvent("session.input", {
      bytes: encoded.length,
      source: input.source,
    });
    return { state: "rendered", expectedTurn, at };
  }

  noteRenderedInstruction(input: RenderedWorkerInstruction): void {
    this.activityRevision += 1;
    this.turnsBeforeLatestInstruction = this.completionReservationFloor();
    this.rendered.push({
      ...input,
      state: input.state ?? "rendered",
    });
  }

  projectTruth(): WorkerTruth {
    if (this.terminalFinalizing) {
      return projectWorkerTruth({
        executionState: "active",
        exitCode: null,
        activity: "working",
        composer: { modalOpen: false, occupied: false },
        completedTurns: this.completedTurnCount,
        canonicalTurns: this.canonicalTurnCount,
        pendingInstructions: this.rendered.length,
      });
    }
    this.observeComposer();
    const stalled = this.stalledWorker();
    return projectWorkerTruth({
      executionState: this.record.executionState,
      exitCode: this.record.exitCode,
      activity: this.activity,
      composer: this.composer,
      completedTurns: this.completedTurnCount,
      canonicalTurns: this.canonicalTurnCount,
      pendingInstructions: this.rendered.length,
      providerLimit: this.currentProviderLimit,
      stalledForSeconds: stalled?.stalledForSeconds,
      scoutTerminalState: this.record.scout?.terminalState,
      stopRequested: this.options.effects.stopRequested?.(),
    });
  }

  waitResult(completionTarget: number, maxResultChars = 1_200): WorkerResultSnapshot {
    const recorded = this.completions.get(completionTarget);
    const scoutTerminal = this.record.scout?.terminalState;
    const result = recorded?.text
      ?? (this.record.profile === "scout"
        ? scoutTerminal === "failed" || scoutTerminal === "budget_exhausted"
          ? this.currentLatestResult
            ?? this.record.latestPreview
            ?? `Scout ${scoutTerminal}`
          : this.record.executionState === "active" || this.record.executionState === "starting"
            ? `Scout running · result ${this.record.scout?.reportState ?? "missing"} · raw provider stream retained in trace artifact`
            : `Scout ${this.record.executionState} without a verified decision card`
        : this.currentLatestResult === undefined
          ? this.fallbackResult(maxResultChars)
          : this.currentLatestResult);
    const text = this.options.observations.truncateResult(result, maxResultChars);
    const base = {
      sessionId: this.record.id,
      ...(this.record.name === undefined ? {} : { name: this.record.name }),
      provider: this.record.provider,
      ...(this.record.model === undefined ? {} : { model: this.record.model }),
      ...(this.record.effort === undefined ? {} : { effort: this.record.effort }),
      ...(this.record.profile === undefined ? {} : { profile: this.record.profile }),
      ...(this.record.effectiveState === undefined
        ? {}
        : { effectiveState: { ...this.record.effectiveState } }),
      ...(this.record.scout === undefined
        ? {}
        : {
            reportPath: this.record.scout.reportPath,
            reportState: this.record.scout.reportState,
            ...(this.record.scout.terminalState === undefined
              ? {}
              : { terminalState: this.record.scout.terminalState }),
          }),
      completedTurns: this.completedTurnCount,
      text,
      truth: this.projectTruth(),
      ...(recorded === undefined ? {} : { provenance: recorded.provenance }),
      ...(this.currentProviderLimit === undefined
        ? {}
        : { providerLimit: this.currentProviderLimit }),
    };
    const reading = this.workerResultStatus(completionTarget);
    if (reading.status === "completed") {
      return {
        ...base,
        status: "completed",
        ...(recorded === undefined ? {} : { completedAt: recorded.completedAt }),
      };
    }
    if (reading.stalled !== undefined) {
      return {
        ...base,
        status: "stalled",
        stalledForSeconds: reading.stalled.stalledForSeconds,
        stallReason: "transcript-and-token-count-unchanged-while-idle",
        tokenCount: reading.stalled.tokenCount,
      };
    }
    return { ...base, status: reading.status };
  }

  waitStatus(completionTarget: number): WorkerResultSnapshot["status"] {
    return this.workerResultStatus(completionTarget).status;
  }

  deliverResult(completionTarget: number, result: WorkerResultSnapshot): WorkerResultSnapshot {
    if (result.status !== "completed") return result;
    const entry = this.completions.get(completionTarget)
      ?? this.recordCompletion(completionTarget, result.text);
    entry.deliveries += 1;
    return {
      ...result,
      retrieval: entry.deliveries === 1 ? "fresh" : "replay",
      completedAt: entry.completedAt,
    };
  }

  recordCompletion(
    completionTarget: number,
    text: string,
    provenance: CompletionLedgerEntry["provenance"] = "terminal-replay",
  ): CompletionLedgerEntry {
    this.completedTurnCount = Math.max(this.completedTurnCount, completionTarget);
    const existing = this.completions.get(completionTarget);
    if (existing !== undefined) return existing;
    if (provenance === "provider-transcript") this.canonicalTurnCount += 1;
    const entry: CompletionLedgerEntry = {
      text,
      completedAt: new Date().toISOString(),
      deliveries: 0,
      provenance,
    };
    this.completions.set(completionTarget, entry);
    while (this.completions.size > MAX_COMPLETION_LEDGER_ENTRIES) {
      const oldest = Math.min(...this.completions.keys());
      this.completions.delete(oldest);
    }
    return entry;
  }

  stopPendingInstructions(): void {
    this.advanceRenderedInstructions("undelivered");
    this.releaseDeliveryHolds();
  }

  /** Wait until an already-enqueued provider-turn commit is durably accounted for. */
  settlePendingTurnCommit(): Promise<void> {
    return this.pendingTurnCommit?.settlement ?? Promise.resolve();
  }

  /**
   * Fence a dead process while preserving the exact final turn it may already have completed.
   *
   * The registry keeps the durable record unpublished until this settles. Generation-local UI
   * effects are invalidated immediately, while durable observations/commits and exact screen
   * evidence drain through the same ordinal barrier used by resume. Newly banked truth is then
   * applied to instruction/latest-result state before the registry retires anything still pending.
   */
  startTerminalFinalization(rawReplay: () => string): Promise<void> | undefined {
    const completedBeforeExit = this.completedTurnCount;
    this.terminalFinalizing = true;
    const frozenArmedReplay = this.idleTimer === undefined ? undefined : rawReplay();
    this.releaseTimers(frozenArmedReplay);
    const captures = [...this.pendingTurnCaptures];
    const requiresSettlement = captures.length > 0
      || this.pendingTurnCommit !== undefined
      || this.completedTurnCount < this.completionBarrierFloor;
    if (!requiresSettlement) return undefined;

    return (async () => {
      await Promise.all(captures);
      await this.settlePendingTurnCommit();
      await this.drainCompletionBarrier();
      if (this.completedTurnCount < this.completionBarrierFloor) {
        throw new Error("Terminal completion barrier did not account for every reserved ordinal");
      }
      if (this.completedTurnCount > completedBeforeExit) {
        const latest = this.completions.get(this.completedTurnCount);
        if (latest === undefined) {
          throw new Error("Terminal completion barrier lost its latest durable receipt");
        }
        this.applyCurrentTurnReceipt({
          bankedThrough: this.completedTurnCount,
          latest: latest.text,
          provenance: latest.provenance,
        });
      }
      this.forgetScreenCompletionsThrough(this.completedTurnCount);
    })();
  }

  /** Clear the input/wait fence only after the registry has published a terminal record. */
  finishTerminalFinalization(): void {
    this.terminalFinalizing = false;
  }

  /**
   * Fence the outgoing process generation and account every ordinal it could already own.
   *
   * The synchronous `releaseTimers()` call happens before this method's first await. Resume may not
   * expose a replacement process or accept its input until all pre-fence observations are terminal,
   * every enqueued commit has settled, and a fence-owned fresh observation has filled any remaining
   * high-water gap with an exact durable receipt.
   */
  async settleForResume(frozenOutgoingReplay?: string): Promise<void> {
    this.releaseTimers(frozenOutgoingReplay);
    const captures = [...this.pendingTurnCaptures];
    await Promise.all(captures);
    await this.settlePendingTurnCommit();
    await this.drainCompletionBarrier();
    if (this.completedTurnCount < this.completionBarrierFloor) {
      throw new Error("Resume completion barrier did not account for every reserved ordinal");
    }
    this.forgetScreenCompletionsThrough(this.completedTurnCount);
  }

  releaseTimers(frozenOutgoingReplay?: string): void {
    const claim = this.turnCaptureOwner;
    const screenTurnsAreSemantic = this.screenTurnsAreSemantic();
    const armedScreenTarget = screenTurnsAreSemantic
      ? this.armedScreenReservationTarget(claim)
      : 0;
    const screenClaimTarget = screenTurnsAreSemantic && claim?.kind === "screen"
      ? claim.completionTarget
      : 0;
    const deferredScreenTarget = screenTurnsAreSemantic
      ? this.deferredScreenCompletionTarget ?? 0
      : 0;
    if (armedScreenTarget > 0) {
      const replay = frozenOutgoingReplay ?? this.armedScreenReplay?.();
      if (replay !== undefined) {
        this.rememberScreenCompletion(
          armedScreenTarget,
          replay,
          this.armedScreenActivityRevision ?? this.activityRevision,
        );
      }
    }
    this.completionBarrierFloor = Math.max(
      this.completionBarrierFloor,
      this.completedTurnCount,
      screenClaimTarget,
      claim?.bankedThrough ?? 0,
      deferredScreenTarget,
      this.pendingTurnCommit?.reservationThrough ?? 0,
      armedScreenTarget,
    );
    this.observationEpoch += 1;
    this.observationRevision += 1;
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    delete this.idleTimer;
    delete this.armedScreenReplay;
    delete this.armedScreenActivityRevision;
    if (this.canonicalReconcileTimer !== undefined) clearTimeout(this.canonicalReconcileTimer);
    delete this.canonicalReconcileTimer;
    delete this.turnCaptureOwner;
    delete this.deferredScreenCompletionTarget;
  }

  private armedScreenReservationTarget(claim: TurnCaptureClaim | undefined): number {
    if (
      this.idleTimer === undefined
      || this.activity !== "awaiting-input"
      || !this.observedWorking
    ) return 0;
    // This is exactly the target bankScreenObservedTurn would choose if its timer fired now. The
    // first visible prompt behind an unbanked speculative reconcile corroborates that same target;
    // later prompts behind real ownership advance beyond the current reservation floor.
    if (
      claim?.kind === "reconcile"
      && claim.bankedThrough === undefined
      && this.deferredScreenCompletionTarget === undefined
    ) return claim.completionTarget;
    if (
      claim !== undefined
      || this.pendingTurnCommit !== undefined
      || this.deferredScreenCompletionTarget !== undefined
    ) return this.completionReservationFloor() + 1;
    return this.completedTurnCount + 1;
  }

  private screenTurnsAreSemantic(): boolean {
    return this.record.profile !== "scout" || this.record.scout?.terminalState === "complete";
  }

  private rememberScreenCompletion(
    completionTarget: number,
    replay: string,
    activityRevision: number,
  ): void {
    if (!this.screenTurnsAreSemantic() || completionTarget <= this.completedTurnCount) return;
    // The first completed screen assigns this ordinal. Later screens may belong to newer deferred
    // work, so resampling or overwriting would silently attach their text to the older target.
    if (this.screenCompletionEvidence.has(completionTarget)) return;
    this.screenCompletionEvidence.set(completionTarget, {
      replay,
      text: this.options.observations.fallbackTerminal(replay),
      activityRevision,
    });
  }

  private forgetScreenCompletionsThrough(completionTarget: number): void {
    for (const target of this.screenCompletionEvidence.keys()) {
      if (target <= completionTarget) this.screenCompletionEvidence.delete(target);
    }
  }

  private observeFatalTermination(rawReplay: () => string): SessionTermination | undefined {
    if (this.fatalReported || this.record.executionState !== "active") return undefined;
    const at = new Date().toISOString();
    const termination = this.options.observations.fatalTermination(
      this.replay.strippedTail(TAIL_BYTES),
      at,
    );
    if (termination === undefined) return undefined;
    this.currentProviderLimit = providerLimitFromTermination(termination);
    this.stopPendingInstructions();
    this.fatalReported = true;
    this.releaseTimers(rawReplay());
    this.activity = "unknown";
    this.observedWorking = false;
    this.currentLatestResult = termination.detail;
    return termination;
  }

  private deliveryHold(): DeliveryHoldReason | undefined {
    if (this.record.executionState !== "active") return "worker-terminal";
    this.observeComposer();
    if (this.composer.modalOpen || this.activity === "needs-input") return "provider-modal";
    if (this.composer.occupied) return "composer-occupied";
    // An indeterminate or incomplete durable receipt has no automatic recovery path. Accepting
    // another instruction would write work whose completion can never be captured while the poisoned
    // reservation remains, so fail closed at the existing provider-busy delivery boundary.
    if (this.pendingTurnCommit?.poisoned === true) return "provider-busy";
    const captureFloor = Math.max(
      this.completedTurnCount,
      this.turnCaptureOwner?.bankedThrough ?? this.turnCaptureOwner?.completionTarget ?? 0,
    );
    // A screen completion beyond the current capture is already old work, but no durable receipt
    // owns it yet. More input would create another turn behind an ordinal backlog the engine has not
    // drained, so keep it queued until the exact per-target evidence is accounted for.
    if ((this.deferredScreenCompletionTarget ?? 0) > captureFloor) return "provider-busy";
    if (this.activity === "working" || this.observedWorking) return "provider-busy";
    return undefined;
  }

  private async terminalDelivery(
    source: "orchestrator" | "worker",
    instructionId: string | undefined,
  ): Promise<InstructionDelivery> {
    const at = new Date().toISOString();
    await this.appendTranscript("lifecycle", "broker", "instruction undelivered", {
      instructionState: "undelivered" satisfies InstructionLifecycleState,
      holdReason: "worker-terminal" satisfies DeliveryHoldReason,
      executionState: this.record.executionState,
      source,
      ...(instructionId === undefined ? {} : { instructionId }),
    });
    return {
      state: "undelivered",
      hold: "worker-terminal",
      detail: DELIVERY_HOLD_DETAIL["worker-terminal"],
      at,
    };
  }

  private async holdInstruction(
    hold: DeliveryHoldReason,
    source: "orchestrator" | "worker",
    instructionId: string | undefined,
  ): Promise<InstructionDelivery> {
    this.deliveryHeld = true;
    const at = new Date().toISOString();
    await this.appendTranscript("lifecycle", "broker", "instruction held", {
      instructionState: "queued" satisfies InstructionLifecycleState,
      holdReason: hold,
      source,
      ...(instructionId === undefined ? {} : { instructionId }),
    });
    await this.options.effects.appendEvent("session.input", { bytes: 0, source, held: hold });
    return { state: "queued", hold, detail: DELIVERY_HOLD_DETAIL[hold], at };
  }

  private workerResultStatus(completionTarget: number): WorkerStatusReading {
    const recorded = this.completions.get(completionTarget);
    if (this.options.effects.scoutBudgetExhausting?.() === true) return { status: "working" };
    if (this.record.scout?.terminalState === "budget_exhausted" && this.record.exitCode === null) {
      return { status: "working" };
    }
    if (this.record.scout?.terminalState === "budget_exhausted") {
      return { status: "budget_exhausted" };
    }
    const alreadyDelivered = (recorded?.deliveries ?? 0) > 0;
    if (
      this.completedTurnCount >= completionTarget
      && (alreadyDelivered || completionTarget > this.turnsBeforeLatestInstruction)
    ) {
      return { status: "completed" };
    }
    if (this.terminalFinalizing) return { status: "working" };
    if (this.currentProviderLimit !== undefined) return { status: "provider-limit" };
    if (this.activity === "needs-input") return { status: "needs-input" };
    if (this.record.executionState === "failed") return { status: "failed" };
    if (this.record.executionState === "cancelled") return { status: "stopped" };
    if (this.record.executionState === "exited") return { status: "exited" };
    if (this.activity === "working") return { status: "working" };
    const stalled = this.stalledWorker();
    if (stalled !== undefined) return { status: "stalled", stalled };
    return { status: "waiting" };
  }

  private fallbackResult(maxResultChars: number): string {
    return this.options.effects.hasRuntime?.() === false
      ? this.options.observations.compactTerminal(this.record.latestPreview ?? "", maxResultChars)
      : this.options.observations.compactFrame(this.replay.frameText(), maxResultChars);
  }

  private updateStallObservation(): void {
    const tokenCount = this.replay.tokenCount();
    if (tokenCount === undefined) {
      delete this.stallObservation;
      return;
    }
    const previous = this.stallObservation;
    const version = this.replay.version;
    if (
      previous === undefined
      || previous.version !== version
      || previous.tokenCount !== tokenCount
    ) {
      this.stallObservation = { version, tokenCount, unchangedSinceMs: this.now() };
    }
  }

  private stalledWorker(): { stalledForSeconds: number; tokenCount: number } | undefined {
    this.updateStallObservation();
    const observation = this.stallObservation;
    if (
      observation === undefined
      || this.record.executionState !== "active"
      || this.activity === "working"
      || this.activity === "needs-input"
    ) {
      return undefined;
    }
    const stalledForSeconds = Math.floor((this.now() - observation.unchangedSinceMs) / 1_000);
    if (stalledForSeconds < this.options.workerStallSeconds) return undefined;
    return { stalledForSeconds, tokenCount: observation.tokenCount };
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private observeComposer(): ComposerObservation {
    if (this.options.effects.hasRuntime?.() === false) return this.composer;
    this.composer = this.options.observations.composer(this.record.provider, this.replay);
    return this.composer;
  }

  private notifyDeliveryBoundary(): void {
    if (!this.deliveryHeld || this.deliveryHold() !== undefined) return;
    this.deliveryHeld = false;
    this.options.effects.notifyDeliveryBoundary();
  }

  private releaseDeliveryHolds(): void {
    if (!this.deliveryHeld) return;
    this.deliveryHeld = false;
    this.options.effects.notifyDeliveryBoundary();
  }

  private advanceRenderedInstructions(state: InstructionLifecycleState, turn?: number): void {
    if (this.rendered.length === 0) return;
    const at = new Date().toISOString();
    const remaining: RenderedInstruction[] = [];
    for (const entry of this.rendered) {
      const applies = state !== "completed" || turn === undefined || entry.expectedTurn <= turn;
      const path = state === "completed"
        ? (["submitted", "acknowledged", "completed"] as const)
        : ([state] as const);
      let next = entry.state;
      if (applies) for (const step of path) next = advanceInstruction(next, step);
      if (next !== entry.state) {
        entry.state = next;
        const update: InstructionStateUpdate = {
          sessionId: this.record.id,
          instructionId: entry.instructionId,
          state: next,
          at,
          ...(turn === undefined ? {} : { turn }),
        };
        this.options.effects.notifyInstructionState(update);
      }
      if (next !== "completed" && next !== "undelivered" && next !== "cancelled") {
        remaining.push(entry);
      }
    }
    this.rendered = remaining;
  }

  private async completeSemanticTurn(replay: string, claim: TurnCaptureClaim): Promise<void> {
    if (!this.isCurrentCapture(claim)) return;
    if (this.record.profile === "scout" && this.record.scout?.terminalState !== "complete") {
      this.currentLatestResult = this.options.observations.fallbackTerminal(replay);
      const effectActivityRevision = this.activityRevision;
      await this.refreshPreview(
        replay,
        [],
        claim.epoch,
        claim.revision,
        claim,
        effectActivityRevision,
      );
      if (!this.isCurrentCapture(claim)
        || this.activityRevision !== effectActivityRevision) return;
      await this.options.effects.setAttention("done", true);
      if (!this.isCurrentCapture(claim)
        || this.activityRevision !== effectActivityRevision) return;
      this.options.effects.notifySessionUpdate();
      return;
    }
    const fallback = this.options.observations.fallbackTerminal(replay);
    const transcriptAttempts = this.record.provider === "claude" || this.record.provider === "codex"
      ? 4
      : 1;
    const transcripts = this.options.transcripts;
    const observe = transcripts?.observeProviderTurns;
    const commit = transcripts?.commitProviderTurns;
    let observation: WorkerTurnObservation | undefined;
    try {
      for (
        let attempt = 0;
        observe !== undefined && commit !== undefined && attempt < transcriptAttempts;
        attempt += 1
      ) {
        observation = await observe.call(transcripts, {
          sessionId: this.record.id,
          provider: this.record.provider,
          cwd: this.record.cwd,
          createdAt: this.record.createdAt,
          turnNumber: claim.completionTarget,
          fallbackText: fallback,
          allowFallback: attempt + 1 === transcriptAttempts,
        });
        if (!this.isCurrentCapture(claim)) {
          this.reserveFencedObservation(claim, observation);
          return;
        }
        if (observation.turns.length > 0) break;
        if (attempt + 1 < transcriptAttempts) {
          await new Promise((resolve) =>
            setTimeout(resolve, TRANSCRIPT_RETRY_BASE_MS * 2 ** attempt));
          if (!this.isCurrentCapture(claim)) return;
        }
      }
    } catch {
      // Native transcript can lag its TUI frame. Completion remains usable from the replay.
    }
    if (!this.isCurrentCapture(claim)) return;

    let committedTurns: WorkerTurnTranscript[] = [];
    let banked: BankedTurnReceipt | undefined;
    if (observation !== undefined && observation.turns.length > 0 && commit !== undefined) {
      let outcome: TurnCommitOutcome;
      try {
        outcome = await this.commitObservedProviderTurns(
          observation,
          claim,
        );
      } catch {
        // An asynchronous rejection may follow a partially durable multi-turn prefix. The pending
        // reservation remains poisoned and no terminal fallback may reuse those ordinals.
        return;
      }
      if (outcome.status === "committed") {
        committedTurns = outcome.turns;
        banked = outcome.banked;
      } else if (this.isCurrentCapture(claim)) {
        // A synchronous throw means no commit promise was registered and therefore no durable write
        // started. The current screen claim may retain the legacy in-memory terminal fallback.
        banked = this.bankTurnReceipt([{
          text: fallback,
          data: { transport: "terminal-replay-fallback" },
        }], claim);
      }
    } else {
      banked = this.bankTurnReceipt([{
        text: fallback,
        data: { transport: "terminal-replay-fallback" },
      }], claim);
    }
    if (banked === undefined || !this.isCurrentCapture(claim)) return;

    this.applyCurrentTurnReceipt(banked, transcriptAttempts);
    if (!this.isCurrentCompletionHead(claim, banked)) return;
    const effectActivityRevision = this.activityRevision;
    await this.refreshPreview(
      replay,
      committedTurns.map((turn) => ({ role: "assistant", text: turn.text ?? "" })),
      claim.epoch,
      claim.revision,
      claim,
      effectActivityRevision,
    );
    if (!this.isCurrentCompletionEffect(claim, banked, effectActivityRevision)) return;
    await this.refreshObservedModel(
      claim.epoch,
      claim.revision,
      claim,
      effectActivityRevision,
    );
    if (!this.isCurrentCompletionEffect(claim, banked, effectActivityRevision)) return;
    await this.options.effects.setAttention("done", true);
    if (!this.isCurrentCompletionEffect(claim, banked, effectActivityRevision)) return;
    this.options.effects.notifySessionUpdate();
    // Delivery is the final old-turn effect. A synchronous queue listener may render new input and
    // set attention back to working; no completion-side await or state write is allowed after this.
    this.notifyDeliveryBoundary();
  }

  /**
   * Install the durable ordinal reservation before synchronously enqueuing the transcript commit.
   * The settlement includes exact receipt banking, so a resume awaiting it cannot race ledger truth.
   */
  private commitObservedProviderTurns(
    observation: WorkerTurnObservation,
    claim: TurnCaptureClaim,
  ): Promise<TurnCommitOutcome> {
    const transcripts = this.options.transcripts;
    const commit = transcripts?.commitProviderTurns;
    if (transcripts === undefined || commit === undefined || observation.turns.length === 0) {
      return Promise.resolve({ status: "failed" });
    }

    let resolveSettlement!: () => void;
    let rejectSettlement!: (error: unknown) => void;
    const settlement = new Promise<void>((resolve, reject) => {
      resolveSettlement = resolve;
      rejectSettlement = reject;
    });
    // The rejection remains observable to resume, but attaching a handler here prevents a current
    // generation with no resume waiter from producing an unhandled-rejection process failure.
    void settlement.catch(() => undefined);
    const pending: PendingTurnCommit = {
      reservationThrough: claim.completionTarget + observation.turns.length - 1,
      settlement,
      poisoned: false,
    };
    this.pendingTurnCommit = pending;

    let receipt: Promise<WorkerTurnTranscript[]>;
    try {
      // ThreadTranscriptStore enqueues serialized dedupe/persistence inside this synchronous call.
      receipt = commit.call(transcripts, observation);
    } catch {
      if (this.pendingTurnCommit === pending) delete this.pendingTurnCommit;
      resolveSettlement();
      return Promise.resolve({ status: "failed" });
    }

    return receipt.then((turns): TurnCommitOutcome => {
      try {
        const banked = this.bankTurnReceipt(turns, claim);
        if (turns.length !== observation.turns.length || banked === undefined) {
          throw new Error(
            "Provider turn commit receipt did not account for every reserved ordinal",
          );
        }
        if (this.pendingTurnCommit === pending) delete this.pendingTurnCommit;
        resolveSettlement();
        return {
          status: "committed",
          turns,
          ...(banked === undefined ? {} : { banked }),
        };
      } catch (error) {
        // The commit receipt was successful but local accounting failed. Durable ordinal ownership
        // is therefore still uncertain and must remain reserved until an operator-level recovery.
        pending.poisoned = true;
        rejectSettlement(error);
        throw error;
      }
    }, (error: unknown) => {
      // A rejected asynchronous write can have persisted a multi-turn prefix. Keep the reservation
      // and make resume fail closed rather than assigning those possibly durable ordinals again.
      pending.poisoned = true;
      rejectSettlement(error);
      throw error;
    });
  }

  /** Fill the frozen process-generation high-water without reviving stale capture ownership. */
  private async drainCompletionBarrier(): Promise<void> {
    while (this.completedTurnCount < this.completionBarrierFloor) {
      const transcripts = this.options.transcripts;
      const observe = transcripts?.observeProviderTurns;
      const commit = transcripts?.commitProviderTurns;
      if (transcripts === undefined || observe === undefined || commit === undefined) {
        throw new Error("Resume completion barrier requires provider observation and commit ports");
      }

      const completionTarget = this.completedTurnCount + 1;
      const nativeCapable = this.record.provider === "claude" || this.record.provider === "codex";
      const fallbackEvidence = this.screenCompletionEvidence.get(completionTarget);
      const attempts = nativeCapable ? 4 : 1;
      let observation: WorkerTurnObservation | undefined;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const allowFallback = fallbackEvidence !== undefined
          && (!nativeCapable || attempt + 1 === attempts);
        const candidate = await observe.call(transcripts, {
          sessionId: this.record.id,
          provider: this.record.provider,
          cwd: this.record.cwd,
          createdAt: this.record.createdAt,
          turnNumber: completionTarget,
          ...(fallbackEvidence === undefined ? {} : { fallbackText: fallbackEvidence.text }),
          allowFallback,
        });
        const turns = !allowFallback
          ? candidate.turns.filter((turn) => turn.transport === "provider-native")
          : candidate.turns;
        if (turns.length > 0) {
          observation = { ...candidate, turnNumber: completionTarget, turns };
          break;
        }
        if (attempt + 1 < attempts) {
          await new Promise((resolve) =>
            setTimeout(resolve, TRANSCRIPT_RETRY_BASE_MS * 2 ** attempt));
        }
      }
      if (observation === undefined || observation.turns.length === 0) {
        throw new Error(
          `Resume completion barrier could not account for ordinal ${completionTarget}`,
        );
      }

      const claim = this.acquireTurnCapture("reconcile", completionTarget);
      try {
        const outcome = await this.commitObservedProviderTurns(observation, claim);
        if (outcome.status !== "committed" || outcome.banked === undefined) {
          throw new Error("Resume completion barrier could not start its durable commit");
        }
        this.forgetScreenCompletionsThrough(outcome.banked.bankedThrough);
      } finally {
        this.finishTurnCapture(claim);
      }
    }
  }

  /** Bank only the exact turns acknowledged by the durable commit receipt. */
  private bankTurnReceipt(
    turns: readonly WorkerTurnTranscript[],
    claim: TurnCaptureClaim,
  ): BankedTurnReceipt | undefined {
    if (turns.length === 0 || this.completedTurnCount !== claim.completionTarget - 1) return undefined;
    const provenance = turns.some((turn) => turn.data?.transport === "provider-native")
      ? "provider-transcript" as const
      : "terminal-replay" as const;
    turns.forEach((turn, index) =>
      this.recordCompletion(claim.completionTarget + index, turn.text ?? "", provenance));
    claim.bankedThrough = this.completedTurnCount;
    const latest = turns.at(-1)?.text ?? "";
    return {
      bankedThrough: this.completedTurnCount,
      latest,
      provenance,
    };
  }

  /** Apply generation-local effects only while the capture still owns this lifecycle epoch. */
  private applyCurrentTurnReceipt(
    receipt: BankedTurnReceipt,
    scrapeAttempts = 1,
  ): void {
    this.advanceRenderedInstructions("completed", receipt.bankedThrough);
    this.currentLatestResult = receipt.latest;
    if (receipt.provenance === "terminal-replay") {
      void this.options.effects.appendEvent("session.turn_scraped", {
        provider: this.record.provider,
        completionTarget: receipt.bankedThrough,
        attempts: scrapeAttempts,
      }).catch(() => undefined);
      void this.appendTranscript(
        "lifecycle",
        "broker",
        "turn recorded from a terminal scrape; the provider transcript did not land in time",
        { provider: this.record.provider, completionTarget: receipt.bankedThrough },
      ).catch(() => undefined);
    }
  }

  private armScreenTurnBank(rawReplay: () => string): void {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    const epoch = this.observationEpoch;
    const evidenceActivityRevision = this.activityRevision;
    this.armedScreenReplay = rawReplay;
    this.armedScreenActivityRevision = evidenceActivityRevision;
    const timer = setTimeout(() => {
      if (this.observationEpoch !== epoch) return;
      const replay = rawReplay();
      if (this.idleTimer !== timer) return;
      delete this.idleTimer;
      delete this.armedScreenReplay;
      delete this.armedScreenActivityRevision;
      this.bankScreenObservedTurn(replay, evidenceActivityRevision);
    }, SCREEN_TURN_BANK_MS);
    this.idleTimer = timer;
  }

  private bankScreenObservedTurn(replay: string, activityRevision: number): void {
    if (this.activity !== "awaiting-input" || !this.observedWorking) return;
    if (this.observeComposer().occupied) {
      this.options.effects.notifySessionUpdate();
      return;
    }
    const owner = this.turnCaptureOwner;
    if (owner !== undefined) {
      const deferredTarget = owner.kind === "reconcile"
        && owner.bankedThrough === undefined
        && this.deferredScreenCompletionTarget === undefined
        ? owner.completionTarget
        : this.completionReservationFloor() + 1;
      this.deferredScreenCompletionTarget = Math.max(
        this.deferredScreenCompletionTarget ?? 0,
        deferredTarget,
      );
      this.rememberScreenCompletion(deferredTarget, replay, activityRevision);
      if (this.screenTurnsAreSemantic()) this.observedWorking = false;
      this.options.effects.notifySessionUpdate();
      return;
    }
    if (this.pendingTurnCommit !== undefined) {
      this.options.effects.notifySessionUpdate();
      return;
    }
    const claim = this.acquireTurnCapture("screen", this.completedTurnCount + 1);
    this.rememberScreenCompletion(claim.completionTarget, replay, activityRevision);
    this.observedWorking = false;
    void this.completeSemanticTurn(replay, claim)
      .finally(() => this.finishTurnCapture(claim));
  }

  private finishTurnCapture(claim: TurnCaptureClaim): void {
    this.releaseTurnCapture(claim);
    this.pendingTurnCaptures.delete(claim.settlement);
    claim.settle();
  }

  private releaseTurnCapture(claim: TurnCaptureClaim): void {
    if (!this.isCurrentCapture(claim)) return;
    delete this.turnCaptureOwner;
    this.observationRevision += 1;
    const deferredTarget = this.deferredScreenCompletionTarget;
    if (deferredTarget === undefined) {
      if (claim.bankedThrough !== undefined) {
        this.forgetScreenCompletionsThrough(claim.bankedThrough);
      }
      return;
    }
    if ((claim.bankedThrough ?? 0) >= deferredTarget) {
      const deferredEvidence = this.screenCompletionEvidence.get(deferredTarget);
      delete this.deferredScreenCompletionTarget;
      this.forgetScreenCompletionsThrough(claim.bankedThrough ?? 0);
      // The receipt owns the ledger even if newer process activity exists. Generation-local UI and
      // delivery effects only belong to the completed screen revision that justified the receipt.
      if (deferredEvidence?.activityRevision === this.activityRevision) {
        this.observedWorking = false;
        this.notifyDeliveryBoundary();
      }
      return;
    }
    if (claim.bankedThrough !== undefined) {
      this.forgetScreenCompletionsThrough(claim.bankedThrough);
    }
    this.drainNextDeferredScreenCompletion();
  }

  /**
   * Continue an already debounce/composer-proven screen backlog from its oldest frozen ordinal.
   *
   * Current terminal activity may belong to a newer turn and is deliberately irrelevant here. A
   * generic screen bank would either drop this evidence while Working or resample the newest frame
   * into the older ordinal. Missing exact evidence leaves the reservation in place to fail closed.
   */
  private drainNextDeferredScreenCompletion(): void {
    if (this.pendingTurnCommit !== undefined || this.turnCaptureOwner !== undefined) return;
    const completionTarget = this.completedTurnCount + 1;
    const evidence = this.screenCompletionEvidence.get(completionTarget);
    if (evidence === undefined) return;
    const claim = this.acquireTurnCapture("screen", completionTarget);
    void this.completeSemanticTurn(evidence.replay, claim)
      .finally(() => this.finishTurnCapture(claim));
  }

  private isCurrentCapture(claim: TurnCaptureClaim): boolean {
    return this.observationEpoch === claim.epoch
      && this.observationRevision === claim.revision
      && this.turnCaptureOwner === claim;
  }

  /** A stale read cannot commit, but its exact candidates extend the fence before it settles. */
  private reserveFencedObservation(
    claim: TurnCaptureClaim,
    observation: WorkerTurnObservation,
  ): void {
    if (observation.turns.length === 0) return;
    this.completionBarrierFloor = Math.max(
      this.completionBarrierFloor,
      claim.completionTarget + observation.turns.length - 1,
    );
  }

  private acquireTurnCapture(
    kind: TurnCaptureClaim["kind"],
    completionTarget: number,
  ): TurnCaptureClaim {
    this.observationRevision += 1;
    let settle!: () => void;
    const settlement = new Promise<void>((resolve) => { settle = resolve; });
    const claim: TurnCaptureClaim = {
      kind,
      epoch: this.observationEpoch,
      revision: this.observationRevision,
      activityRevision: this.activityRevision,
      completionTarget,
      settlement,
      settle,
    };
    this.turnCaptureOwner = claim;
    this.pendingTurnCaptures.add(settlement);
    return claim;
  }

  private isCurrentCompletionHead(
    claim: TurnCaptureClaim,
    receipt: BankedTurnReceipt,
  ): boolean {
    if (!this.isCurrentCapture(claim)) return false;
    const deferredTarget = this.deferredScreenCompletionTarget;
    if (deferredTarget === undefined) return this.activityRevision === claim.activityRevision;
    const deferredEvidence = deferredTarget === undefined
      ? undefined
      : this.screenCompletionEvidence.get(deferredTarget);
    return receipt.bankedThrough >= deferredTarget
      && deferredEvidence?.activityRevision === this.activityRevision;
  }

  private isCurrentCompletionEffect(
    claim: TurnCaptureClaim,
    receipt: BankedTurnReceipt,
    activityRevision: number,
  ): boolean {
    return this.activityRevision === activityRevision
      && this.isCurrentCompletionHead(claim, receipt);
  }

  /** Highest completion ordinal already banked, capture-owned, or deferred behind that owner. */
  private completionReservationFloor(): number {
    const claim = this.turnCaptureOwner;
    return Math.max(
      this.completedTurnCount,
      this.completionBarrierFloor,
      this.deferredScreenCompletionTarget ?? 0,
      this.pendingTurnCommit?.reservationThrough ?? 0,
      claim !== undefined && this.isCurrentCapture(claim) ? claim.completionTarget : 0,
    );
  }

  private armCanonicalReconcile(): void {
    if (
      this.options.transcripts?.observeProviderTurns === undefined
      || this.options.transcripts.commitProviderTurns === undefined
      || !this.canReconcileCanonicalTurns()
    ) return;
    if (this.canonicalReconcileTimer !== undefined) clearTimeout(this.canonicalReconcileTimer);
    const epoch = this.observationEpoch;
    this.canonicalReconcileTimer = setTimeout(() => {
      if (this.observationEpoch !== epoch) return;
      delete this.canonicalReconcileTimer;
      void this.reconcileCanonicalTurns();
    }, CANONICAL_RECONCILE_QUIET_MS);
    this.canonicalReconcileTimer.unref?.();
  }

  private canReconcileCanonicalTurns(): boolean {
    if (this.record.executionState !== "active") return false;
    if (this.suppressSemanticTurns === true || this.record.profile === "scout") return false;
    if (this.record.provider !== "claude" && this.record.provider !== "codex") return false;
    return this.observedWorking || this.rendered.length > 0;
  }

  async reconcileCanonicalTurns(): Promise<void> {
    const transcripts = this.options.transcripts;
    const observe = transcripts?.observeProviderTurns;
    const commit = transcripts?.commitProviderTurns;
    if (
      transcripts === undefined
      || observe === undefined
      || commit === undefined
      || this.turnCaptureOwner !== undefined
      || this.pendingTurnCommit !== undefined
    ) {
      return;
    }
    if (!this.canReconcileCanonicalTurns() || this.idleTimer !== undefined) return;
    const claim = this.acquireTurnCapture("reconcile", this.completedTurnCount + 1);
    try {
      const before = this.completedTurnCount;
      let observation: WorkerTurnObservation;
      try {
        observation = await observe.call(transcripts, {
          sessionId: this.record.id,
          provider: this.record.provider,
          cwd: this.record.cwd,
          createdAt: this.record.createdAt,
          turnNumber: before + 1,
          allowFallback: false,
        });
      } catch {
        return;
      }
      if (!this.isCurrentCapture(claim)) {
        this.reserveFencedObservation(claim, observation);
        return;
      }
      const nativeTurns = observation.turns.filter((turn) => turn.transport === "provider-native");
      if (nativeTurns.length === 0 || this.completedTurnCount !== before) return;
      const nativeObservation: WorkerTurnObservation = {
        ...observation,
        turns: nativeTurns,
      };
      let outcome: TurnCommitOutcome;
      try {
        outcome = await this.commitObservedProviderTurns(nativeObservation, claim);
      } catch {
        return;
      }
      if (outcome.status !== "committed" || outcome.banked === undefined) return;

      // A receipt from a fenced generation owns ledger ordinals only. Reconcile events, instruction
      // state, preview/model, and attention all belong to the still-current process generation.
      if (!this.isCurrentCapture(claim)) return;
      this.applyCurrentTurnReceipt(outcome.banked);
      if (this.isCurrentCompletionHead(claim, outcome.banked)) {
        this.observedWorking = false;
        if (this.activity === "working") this.activity = "awaiting-input";
        this.observeComposer();
      }
      const native = outcome.turns.filter(
        (turn) => turn.data?.transport === "provider-native",
      );
      await this.options.effects.appendEvent("session.turn_reconciled", {
        provider: this.record.provider,
        completionTarget: outcome.banked.bankedThrough,
        turns: native.length,
      }).catch(() => undefined);
      if (!this.isCurrentCapture(claim)) return;
      await this.appendTranscript(
        "lifecycle",
        "broker",
        "turn recorded from the provider transcript; the terminal never reported it finishing",
        { provider: this.record.provider, completionTarget: this.completedTurnCount },
      ).catch(() => undefined);
      if (!this.isCurrentCapture(claim)) return;
      if (!this.isCurrentCompletionHead(claim, outcome.banked)) return;
      const effectActivityRevision = this.activityRevision;
      await this.refreshPreview(
        this.options.effects.snapshot() ?? "",
        native.map((turn) => ({ role: "assistant", text: turn.text ?? "" })),
        claim.epoch,
        claim.revision,
        claim,
        effectActivityRevision,
      ).catch(() => undefined);
      if (!this.isCurrentCompletionEffect(claim, outcome.banked, effectActivityRevision)) return;
      await this.refreshObservedModel(
        claim.epoch,
        claim.revision,
        claim,
        effectActivityRevision,
      )
        .catch(() => undefined);
      if (!this.isCurrentCompletionEffect(claim, outcome.banked, effectActivityRevision)) return;
      await this.options.effects.setAttention(
        this.activity === "needs-input" ? "needs-input" : "done",
        true,
      );
      if (!this.isCurrentCompletionEffect(claim, outcome.banked, effectActivityRevision)) return;
      this.options.effects.notifySessionUpdate();
      this.notifyDeliveryBoundary();
    } finally {
      this.finishTurnCapture(claim);
    }
  }

  private async refreshPreview(
    replay: string,
    captured: readonly WorkerTurnTranscriptMessage[],
    epoch: number,
    revision: number,
    owner: TurnCaptureClaim | undefined,
    activityRevision: number,
  ): Promise<void> {
    if (!this.isCurrentObservation(epoch, revision, owner, activityRevision)) return;
    const previews = this.options.preview;
    if (previews === undefined) return;
    let preview = previews.preview({ transcript: captured, maxLength: PREVIEW_STORAGE_LIMIT });
    if (preview.kind === "none") {
      const transcript = await this.readTranscriptMessages().catch(() => []);
      if (!this.isCurrentObservation(epoch, revision, owner, activityRevision)) return;
      preview = previews.preview({
        transcript,
        ...(this.record.latestPreview === undefined
          ? {}
          : { storedPreview: this.record.latestPreview }),
        replay,
        maxLength: PREVIEW_STORAGE_LIMIT,
      });
    }
    if (!this.isCurrentObservation(epoch, revision, owner, activityRevision)) return;
    if (preview.kind === "none" || preview.text === this.record.latestPreview) return;
    this.record.latestPreview = preview.text;
    await this.options.effects.persist();
  }

  private async refreshObservedModel(
    epoch: number,
    revision: number,
    owner: TurnCaptureClaim | undefined,
    activityRevision: number,
  ): Promise<void> {
    if (!this.isCurrentObservation(epoch, revision, owner, activityRevision)) return;
    const transcripts = this.options.transcripts;
    const read = transcripts?.readObservedModel;
    if (transcripts === undefined || read === undefined) return;
    const observed = await read.call(transcripts, {
      sessionId: this.record.id,
      provider: this.record.provider,
      cwd: this.record.cwd,
      createdAt: this.record.createdAt,
      turnNumber: this.completedTurnCount,
    }).catch(() => undefined);
    if (!this.isCurrentObservation(epoch, revision, owner, activityRevision)) return;
    if (observed === undefined) return;
    const current = this.record.observedModel;
    if (current?.model === observed.model && current.effort === observed.effort) return;
    this.record.observedModel = observed;
    await this.options.effects.persist();
    if (!this.isCurrentObservation(epoch, revision, owner, activityRevision)) return;
    this.options.effects.notifySessionUpdate();
  }

  private isCurrentObservation(
    epoch: number,
    revision: number,
    owner: TurnCaptureClaim | undefined,
    activityRevision: number,
  ): boolean {
    return this.observationEpoch === epoch
      && this.observationRevision === revision
      && this.turnCaptureOwner === owner
      && this.activityRevision === activityRevision;
  }

  private async readTranscriptMessages(): Promise<WorkerTurnTranscriptMessage[]> {
    const transcripts = this.options.transcripts;
    const read = transcripts?.readTranscriptMessages;
    if (transcripts === undefined || read === undefined) return [];
    return read.call(transcripts, {
      sessionId: this.record.id,
      provider: this.record.provider,
      cwd: this.record.cwd,
      createdAt: this.record.createdAt,
      turnNumber: this.completedTurnCount,
    });
  }

  private appendTranscript(
    kind: Parameters<WorkerTurnTranscriptPort["append"]>[0]["kind"],
    source: Parameters<WorkerTurnTranscriptPort["append"]>[0]["source"],
    text: string,
    data: Record<string, unknown>,
  ): Promise<unknown> {
    return this.options.transcripts?.append({
      sessionId: this.record.id,
      kind,
      source,
      text,
      data,
    }) ?? Promise.resolve();
  }
}
