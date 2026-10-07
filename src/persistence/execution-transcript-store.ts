import { lstatSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionRecord } from "../domain/session.js";
import type { ThreadEvent } from "../domain/thread.js";
import type { CaptureWorkerTurns, WorkerTurnObservation, WorkerTurnTranscript } from "../orchestration/session/worker-turn-ports.js";
import { ContainerNativeBindingSchema, ContainerNativeSource, type PendingNativeInterval } from "../runtime/activity/container-native-source.js";
import type { ProviderBudgetWindow } from "../runtime/provider-budget-telemetry.js";
import { ThreadTranscriptStore, type ThreadTranscriptStoreOptions } from "./thread-transcript-store.js";

/** Native activity follows durable semantic receipts; it never decides what a turn is. */
export interface NativeTurnCapture {
  captureCompleted(session: SessionRecord, receipt: ThreadEvent): Promise<void>;
  captureRunning(session: SessionRecord, pending: PendingNativeInterval, turnNumber: number): Promise<void>;
  outstandingTools?(session: SessionRecord, turnNumber: number): number | null;
  invalidate?(sessionId: string): void;
  forget?(sessionId: string): void;
}
interface ParkingBinding {
  identity: string; revision: number; pending: number;
  verified?: { conversationId: string; path: string; stamp: string; bindingPath: string; bindingStamp: string; hookPath?: string; hookStamp?: string | null };
}
function identity(session: SessionRecord): string {
  return JSON.stringify([session.id, session.provider, session.executor, session.generation, session.execution?.executionId, session.execution?.generation]);
}
function stamp(path: string): string {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isFile()) throw new Error("NATIVE_PARKING_SOURCE_UNSAFE");
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}
function optionalStamp(path: string): string | null {
  try { return stamp(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
/** One canonical semantic journal; execution changes only where native observations come from. */
export class ExecutionTranscriptStore extends ThreadTranscriptStore {
  private capture: NativeTurnCapture | undefined;
  private readonly parking = new Map<string, ParkingBinding>();
  constructor(directory: string, options: ThreadTranscriptStoreOptions,
    private readonly containerSource: ContainerNativeSource,
    private readonly session: (id: string) => SessionRecord | undefined,
  ) { super(directory, options); }
  attachNativeCapture(capture: NativeTurnCapture): void { this.capture = capture; }
  /** Synchronous facts are usable only for the exact execution whose native source was checked. */
  parkingFacts(sessionId: string, turnNumber: number): { conversationId: string | null; resumeSupported: boolean; outstandingTools: number | null } {
    const unknown = { conversationId: null, resumeSupported: false, outstandingTools: null };
    const session = this.container(sessionId), fact = this.parking.get(sessionId);
    if (!session || !fact || fact.identity !== identity(session) || fact.pending || !fact.verified) return unknown;
    const verified = fact.verified;
    try {
      if (stamp(verified.path) !== verified.stamp || stamp(verified.bindingPath) !== verified.bindingStamp) return unknown;
      if (verified.hookPath && optionalStamp(verified.hookPath) !== verified.hookStamp) return unknown;
      return { conversationId: verified.conversationId, resumeSupported: true,
        outstandingTools: this.capture?.outstandingTools?.(session, turnNumber) ?? null };
    } catch { return unknown; }
  }
  /** Wake/restart callers can confirm the existing native binding before taking a synchronous snapshot. */
  async refreshParkingFacts(sessionId: string): Promise<void> {
    const session = this.container(sessionId);
    if (!session) { this.parking.delete(sessionId); this.capture?.invalidate?.(sessionId); return; }
    await this.readNative(session).catch(() => undefined);
  }
  private async readNative(session: SessionRecord) {
    let fact = this.parking.get(session.id);
    const key = identity(session);
    if (!fact || fact.identity !== key) {
      fact = { identity: key, revision: 0, pending: 0 }; this.parking.set(session.id, fact);
      this.capture?.invalidate?.(session.id);
    }
    const revision = ++fact.revision;
    fact.pending++; delete fact.verified;
    while (this.parking.size > 128) this.parking.delete(this.parking.keys().next().value!);
    try {
      let before: { path: string; stamp: string } | undefined;
      try {
        if (session.execution && session.execution.generation === session.generation
          && (session.provider === "claude" || session.provider === "codex")) {
          const resolved = await this.containerSource.resolve(session);
          before = { path: resolved.path, stamp: stamp(resolved.path) };
        }
      } catch { /* unavailable parking evidence cannot suppress semantic observations */ }
      const source = await this.containerSource.read(session);
      try {
        if (!before) throw new Error("NATIVE_PARKING_UNSUPPORTED");
        const after = await this.containerSource.resolve(session);
        const bindingPath = this.containerSource.bindingPath(session.id), bindingStamp = stamp(bindingPath);
        const hookPath = session.provider === "claude" ? join(after.sourceRoot, "cyberdeck-native-binding.json") : undefined;
        const hookStamp = hookPath ? optionalStamp(hookPath) : undefined;
        const binding = ContainerNativeBindingSchema.parse(JSON.parse(await readFile(bindingPath, "utf8")));
        if (hookPath && hookStamp !== null) {
          const hook = JSON.parse(await readFile(hookPath, "utf8")) as { nativeSessionId?: unknown; relativePath?: unknown };
          if (hook.nativeSessionId !== binding.nativeSessionId || hook.relativePath !== binding.relativePath
            || optionalStamp(hookPath) !== hookStamp) throw new Error("NATIVE_PARKING_CHANGED");
        }
        if (binding.sessionId !== session.id || binding.provider !== session.provider
          || join(after.sourceRoot, binding.relativePath) !== after.path || before.path !== after.path
          || stamp(after.path) !== before.stamp || stamp(bindingPath) !== bindingStamp) throw new Error("NATIVE_PARKING_CHANGED");
        if (source.pending) this.capture?.invalidate?.(session.id);
        const current = this.session(session.id);
        if (this.parking.get(session.id) === fact && fact.revision === revision && current && identity(current) === key) {
          fact.verified = { conversationId: binding.nativeSessionId, path: after.path, stamp: before.stamp, bindingPath, bindingStamp,
            ...(hookPath ? { hookPath, hookStamp: hookStamp ?? null } : {}) };
        }
      } catch { this.capture?.invalidate?.(session.id); }
      return source;
    } catch (error) { this.capture?.invalidate?.(session.id); throw error; }
    finally { fact.pending--; }
  }
  override async dropClaudeBinding(sessionId: string): Promise<void> {
    // Both explicit deletion and retention retirement call this final cleanup boundary.
    this.containerSource.forget(sessionId);
    this.parking.delete(sessionId);
    this.capture?.forget?.(sessionId);
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
      const source = await this.readNative(session);
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
