import type { SessionRecord } from "../domain/session.js";
import type { ThreadEvent } from "../domain/thread.js";
import type { CaptureWorkerTurns, WorkerTurnObservation, WorkerTurnTranscript, WorkerTurnLedger } from "../orchestration/session/worker-turn-ports.js";
import { ContainerNativeSource, type PendingNativeInterval } from "../runtime/activity/container-native-source.js";
import type { ProviderBudgetWindow } from "../runtime/provider-budget-telemetry.js";
import { ThreadTranscriptStore, type ThreadTranscriptStoreOptions } from "./thread-transcript-store.js";
import { nativeSourceFailure } from "./native-source-observation.js";

/** Native activity follows durable semantic receipts; it never decides what a turn is. */
export interface NativeTurnCapture {
  captureCompleted(session: SessionRecord, receipt: ThreadEvent): Promise<void>;
  captureRunning(session: SessionRecord, pending: PendingNativeInterval, turnNumber: number): Promise<void>;
}
/** One canonical semantic journal; execution changes only where native observations come from. */
export class ExecutionTranscriptStore extends ThreadTranscriptStore {
  private capture: NativeTurnCapture | undefined;
  constructor(directory: string, options: ThreadTranscriptStoreOptions,
    private readonly containerSource: ContainerNativeSource,
    private readonly session: (id: string) => SessionRecord | undefined,
  ) { super(directory, options); }
  attachNativeCapture(capture: NativeTurnCapture): void { this.capture = capture; }
  override async dropCodexBinding(sessionId: string): Promise<void> {
    await super.dropCodexBinding(sessionId);
    await this.containerSource.dropBinding(sessionId);
  }
  override async dropClaudeBinding(sessionId: string): Promise<void> {
    await super.dropClaudeBinding(sessionId);
    await this.containerSource.dropBinding(sessionId);
  }
  private container(id: string): SessionRecord | undefined {
    const record = this.session(id);
    return record?.executor === "orbstack-container" ? record : undefined;
  }
  override async observeProviderTurns(input: CaptureWorkerTurns): Promise<WorkerTurnObservation> {
    const current = this.container(input.sessionId);
    if (!current) return super.observeProviderTurns(input);
    const session = { ...current, execution: current.execution === undefined ? undefined : { ...current.execution } } as SessionRecord;
    let ledger: WorkerTurnLedger;
    try { ledger = await this.readCompletionLedger(session.id); }
    catch { return { sessionId: session.id, provider: session.provider, turnNumber: input.turnNumber, turns: [],
      nativeSourceAvailable: false, nativeSourceStatus: "source-error", nativeSourceReason: "NATIVE_LEDGER_READ_ERROR",
      nativeActivity: "unknown", nativeFallbackAllowed: false }; }
    try {
      const source = await this.containerSource.read(session);
      const seen = new Set(ledger.turns.flatMap((turn) => typeof turn.data?.semanticTurnId === "string" ? [turn.data.semanticTurnId] : []));
      const lastNative = [...ledger.turns, ...(ledger.lastNativeTurn === undefined ? [] : [ledger.lastNativeTurn])].reverse().find((turn) => {
        const interval = turn.data?.nativeActivity as { path?: string } | undefined;
        const legacyNegative = turn.data?.nativeSessionId === undefined && interval?.path === undefined
          && typeof turn.data?.nativeActivityId === "string";
        return turn.data?.transport === "provider-native" && turn.data.provider === session.provider
          && (turn.data.nativeSessionId === source.nativeSessionId || interval?.path === source.path || legacyNegative);
      });
      let nativeTurns = source.turns;
      let missingBoundary = false;
      if (lastNative !== undefined && typeof lastNative.data?.semanticTurnId === "string") {
        const id = lastNative.data.semanticTurnId.slice(`${session.provider}:`.length);
        const boundary = source.boundaries.find((candidate) => candidate.providerTurnId === id
          || (typeof lastNative.data?.nativeActivityId === "string" && candidate.nativeActivityId === lastNative.data.nativeActivityId));
        missingBoundary = boundary === undefined;
        nativeTurns = boundary === undefined ? [] : nativeTurns.filter((turn) =>
          (turn.data?.nativeActivity as { throughOffset: number }).throughOffset > boundary.throughOffset);
      }
      const turns = nativeTurns.filter((turn) => !seen.has(`${session.provider}:${turn.providerTurnId}`));
      // The running turn's ordinal is only certain once every completed one is committed.
      if (!missingBoundary && source.pending && turns.length === 0 && this.capture) {
        void this.capture.captureRunning(session, source.pending, ledger.completedTurns + 1).catch(() => undefined);
      }
      return { sessionId: session.id, provider: session.provider, turnNumber: input.turnNumber, turns,
        nativeSourceAvailable: true, nativeSourceStatus: "available", nativeFallbackAllowed: false,
        nativeSessionId: source.nativeSessionId, nativeActivity: source.nativeActivity, activityVersion: source.activityVersion,
        ...(missingBoundary ? { nativeSourceReason: "NATIVE_COMPLETION_BOUNDARY_MISSING" } : {}),
        ...(source.nativeActivityEvidence === undefined ? {} : { nativeActivityEvidence: source.nativeActivityEvidence }) };
    } catch (error) {
      const failure = nativeSourceFailure(error);
      const fallbackAllowed = failure.status === "missing" && input.allowFallback === true && input.turnNumber > ledger.completedTurns;
      return { sessionId: session.id, provider: session.provider, turnNumber: input.turnNumber,
        nativeSourceAvailable: false, nativeSourceStatus: failure.status, nativeSourceReason: failure.reason,
        nativeActivity: "unknown", nativeFallbackAllowed: fallbackAllowed,
        turns: fallbackAllowed ? [{ providerTurnId: `fallback:${input.turnNumber}`, providerOccurredAt: new Date().toISOString(),
          text: input.fallbackText ?? "No useful provider output yet", transport: "terminal-replay-fallback",
          data: { nativeCaptureStatus: "unavailable", nativeSourceStatus: failure.status, nativeSourceReason: failure.reason } }] : [] };
    }
  }
  /** Every freshly persisted native receipt is captured; dedupe hits were captured when first persisted. */
  override async commitProviderTurns(observation: WorkerTurnObservation): Promise<WorkerTurnTranscript[]> {
    const receipts = await super.commitProviderTurns(observation);
    const session = this.container(observation.sessionId);
    if (session && this.capture) {
      for (const receipt of receipts) {
        if (receipt.data?.transport !== "provider-native" || !("cursor" in receipt)) continue;
        void this.capture.captureCompleted(session, receipt as ThreadEvent).catch(() => undefined);
      }
    }
    return receipts;
  }
  override async readTranscriptMessages(input: CaptureWorkerTurns) {
    const session = this.container(input.sessionId);
    return session ? (await this.containerSource.read(session)).messages : super.readTranscriptMessages(input);
  }
  override async readObservedModel(input: CaptureWorkerTurns) {
    const session = this.container(input.sessionId);
    return session ? (await this.containerSource.read(session)).model : super.readObservedModel(input);
  }
  override async readProviderBudgetTelemetry(input: CaptureWorkerTurns, window: ProviderBudgetWindow) {
    const session = this.container(input.sessionId);
    return session ? (await this.containerSource.read(session, window)).budget : super.readProviderBudgetTelemetry(input, window);
  }
}
