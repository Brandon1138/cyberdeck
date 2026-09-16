import type { SessionRecord } from "../domain/session.js";
import type { ThreadEvent } from "../domain/thread.js";
import type { CaptureWorkerTurns, WorkerTurnObservation, WorkerTurnTranscript } from "../orchestration/session/worker-turn-ports.js";
import { ContainerNativeSource, type PendingNativeInterval } from "../runtime/activity/container-native-source.js";
import type { ProviderBudgetWindow } from "../runtime/provider-budget-telemetry.js";
import { ThreadTranscriptStore, type ThreadTranscriptStoreOptions } from "./thread-transcript-store.js";

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
  override async dropClaudeBinding(sessionId: string): Promise<void> {
    // Both explicit deletion and retention retirement call this final cleanup boundary.
    this.containerSource.forget(sessionId);
    await super.dropClaudeBinding(sessionId);
  }
  private container(id: string): SessionRecord | undefined {
    const record = this.session(id);
    return record?.executor === "orbstack-container" ? record : undefined;
  }
  override async observeProviderTurns(input: CaptureWorkerTurns): Promise<WorkerTurnObservation> {
    const session = this.container(input.sessionId);
    if (!session) return super.observeProviderTurns(input);
    try {
      await this.init();
      const source = await this.containerSource.read(session);
      const turns = source.turns.filter((turn) => !this.hasSemanticTurn(session.id, `${session.provider}:${turn.providerTurnId}`));
      // The running turn's ordinal is only certain once every completed one is committed.
      if (source.pending && turns.length === 0 && this.capture) {
        let cursor = 0, committedThrough = 0;
        for (;;) {
          const page = await this.read(session.id, cursor, 1000);
          for (const event of page.events) {
            if (event.kind === "turn" && typeof event.data.turnNumber === "number") committedThrough = Math.max(committedThrough, event.data.turnNumber);
          }
          if (page.events.length < 1000) break;
          cursor = page.nextCursor;
        }
        void this.capture.captureRunning(session, source.pending, committedThrough + 1).catch(() => undefined);
      }
      return { sessionId: session.id, provider: session.provider, turnNumber: input.turnNumber, turns };
    } catch {
      // Terminal fallback is a semantic observation only; native coverage remains unavailable.
      return { sessionId: session.id, provider: session.provider, turnNumber: input.turnNumber,
        turns: input.allowFallback ? [{ providerTurnId: `fallback:${input.turnNumber}`, providerOccurredAt: new Date().toISOString(),
          text: input.fallbackText ?? "No useful provider output yet", transport: "terminal-replay-fallback",
          data: { nativeCaptureStatus: "unavailable" } }] : [] };
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
    return session ? (await this.containerSource.read(session, "session", false)).messages : super.readTranscriptMessages(input);
  }
  override async readObservedModel(input: CaptureWorkerTurns) {
    const session = this.container(input.sessionId);
    return session ? (await this.containerSource.read(session, "session", false)).model : super.readObservedModel(input);
  }
  override async readProviderBudgetTelemetry(input: CaptureWorkerTurns, window: ProviderBudgetWindow) {
    const session = this.container(input.sessionId);
    return session ? (await this.containerSource.read(session, window, false)).budget : super.readProviderBudgetTelemetry(input, window);
  }
}
