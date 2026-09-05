import type { SessionRecord } from "../domain/session.js";
import type { CaptureWorkerTurns, WorkerTurnObservation } from "../orchestration/session/worker-turn-ports.js";
import { ContainerNativeSource } from "../runtime/activity/container-native-source.js";
import type { ProviderBudgetWindow } from "../runtime/provider-budget-telemetry.js";
import { ThreadTranscriptStore, type ThreadTranscriptStoreOptions } from "./thread-transcript-store.js";

/** One canonical semantic journal; execution changes only where native observations come from. */
export class ExecutionTranscriptStore extends ThreadTranscriptStore {
  constructor(directory: string, options: ThreadTranscriptStoreOptions,
    private readonly containerSource: ContainerNativeSource,
    private readonly session: (id: string) => SessionRecord | undefined,
  ) { super(directory, options); }
  private container(id: string): SessionRecord | undefined {
    const record = this.session(id);
    return record?.executor === "orbstack-container" ? record : undefined;
  }
  override async observeProviderTurns(input: CaptureWorkerTurns): Promise<WorkerTurnObservation> {
    const session = this.container(input.sessionId);
    if (!session) return super.observeProviderTurns(input);
    try {
      const source = await this.containerSource.read(session);
      const seen = new Set<string>();
      let cursor = 0;
      for (;;) {
        const page = await this.read(session.id, cursor, 1000);
        for (const event of page.events) if (typeof event.data.semanticTurnId === "string") seen.add(event.data.semanticTurnId);
        if (page.events.length < 1000) break;
        cursor = page.nextCursor;
      }
      return { sessionId: session.id, provider: session.provider, turnNumber: input.turnNumber,
        turns: source.turns.filter((turn) => !seen.has(`${session.provider}:${turn.providerTurnId}`)) };
    } catch {
      // Terminal fallback is a semantic observation only; native coverage remains unavailable.
      return { sessionId: session.id, provider: session.provider, turnNumber: input.turnNumber,
        turns: input.allowFallback ? [{ providerTurnId: `fallback:${input.turnNumber}`, providerOccurredAt: new Date().toISOString(),
          text: input.fallbackText ?? "No useful provider output yet", transport: "terminal-replay-fallback",
          data: { nativeCaptureStatus: "unavailable" } }] : [] };
    }
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
