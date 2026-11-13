import type { ProviderId } from "../domain/session.js";
import type {
  BoundedReplayTail,
  ReplayObservation,
  WorkerTurnObservationPort,
  WorkerTurnPreviewInput,
  WorkerTurnPreviewPort,
} from "../orchestration/session/worker-turn-ports.js";
import { frameComposerState, frameInputReady } from "./composer-state.js";
import { conversationPreview } from "./conversation-preview.js";
import { ReplayDigest } from "./replay-digest.js";
import { CodexScreenProgress } from "./codex-progress.js";
import {
  detectProviderLimitTerminationInTail,
  detectSessionFatalErrorInTail,
} from "./session-liveness.js";
import {
  compactFrameResult,
  compactTerminalResult,
  markerTerminalActivity,
  terminalFallbackResult,
  truncateResult,
} from "./terminal-replay.js";

class RuntimeReplayObservation implements ReplayObservation {
  private readonly codexProgress = new CodexScreenProgress();
  constructor(readonly digest: ReplayDigest) {}

  appendBytes(chunk: Buffer): void {
    this.digest.appendBytes(chunk);
  }

  reset(replay: string): void {
    this.digest.reset(replay);
    this.codexProgress.reset();
  }

  frameText(): string {
    return this.digest.frameText();
  }

  modalFrameText(): string { return this.digest.inputFrameText(); }

  strippedTail(maxChars: number): BoundedReplayTail {
    return this.digest.strippedTail(maxChars);
  }

  tokenCount(): number | undefined {
    return this.digest.tokenCount();
  }

  get version(): number {
    return this.digest.version;
  }

  progressVersion(provider: string): number {
    return provider === "codex" ? this.codexProgress.observe(this.digest.inputFrameText()) : 0;
  }
}

/** Concrete terminal interpretation composed at the broker boundary. */
export class WorkerTurnObservationAdapter
implements WorkerTurnObservationPort, WorkerTurnPreviewPort {
  createReplay(replayChars: number): ReplayObservation {
    return new RuntimeReplayObservation(new ReplayDigest(replayChars));
  }

  activity(provider: string, replay: ReplayObservation) {
    return markerTerminalActivity(provider as ProviderId, this.digest(replay));
  }

  starting(provider: string, replay: ReplayObservation): boolean {
    return provider === "codex"
      && /^\s*•\s+Starting MCP servers \(\d+\/\d+\):/mu.test(this.digest(replay).inputFrameText());
  }

  composer(provider: string, replay: ReplayObservation) {
    const digest = this.digest(replay);
    // An unreliable screen can retain a draft hold, but it can never authorize input. Once the
    // projection is reliable, erased history is not evidence that a draft still occupies the UI.
    const frame = digest.currentScreen()?.text ?? replay.frameText();
    const composer = frameComposerState(provider as ProviderId, frame, {
      modalOpen: this.activity(provider, replay) === "needs-input",
    });
    return {
      ...composer,
      inputReady: !composer.modalOpen && !composer.occupied
        && frameInputReady(provider as ProviderId, digest.inputFrameText()),
    };
  }

  fatalTermination(tail: BoundedReplayTail, at: string) {
    const limit = detectProviderLimitTerminationInTail(tail);
    if (limit !== undefined) {
      return { kind: limit.kind, reason: limit.reason, detail: limit.detail, at };
    }
    const fault = detectSessionFatalErrorInTail(tail);
    return fault === undefined
      ? undefined
      : { kind: "provider-fault" as const, reason: fault.reason, detail: fault.detail, at };
  }

  compactFrame(frame: string, maxChars?: number): string {
    return compactFrameResult(frame, maxChars);
  }

  compactTerminal(replay: string, maxChars?: number): string {
    return compactTerminalResult(replay, maxChars);
  }

  fallbackTerminal(replay: string): string {
    return terminalFallbackResult(replay);
  }

  truncateResult(text: string, maxChars: number): string {
    return truncateResult(text, maxChars);
  }

  preview(input: WorkerTurnPreviewInput) {
    return conversationPreview(input);
  }

  private digest(replay: ReplayObservation): ReplayDigest {
    if (!(replay instanceof RuntimeReplayObservation)) {
      throw new TypeError("WorkerTurnObservationAdapter requires its own replay observation");
    }
    return replay.digest;
  }
}
