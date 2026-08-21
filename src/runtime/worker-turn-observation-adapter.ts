import type { ProviderId } from "../domain/session.js";
import type {
  BoundedReplayTail,
  ReplayObservation,
  WorkerTurnObservationPort,
  WorkerTurnPreviewInput,
  WorkerTurnPreviewPort,
} from "../orchestration/session/worker-turn-ports.js";
import { frameComposerState } from "./composer-state.js";
import { conversationPreview } from "./conversation-preview.js";
import { ReplayDigest } from "./replay-digest.js";
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
  constructor(readonly digest: ReplayDigest) {}

  appendBytes(chunk: Buffer): void {
    this.digest.appendBytes(chunk);
  }

  reset(replay: string): void {
    this.digest.reset(replay);
  }

  frameText(): string {
    return this.digest.frameText();
  }

  strippedTail(maxChars: number): BoundedReplayTail {
    return this.digest.strippedTail(maxChars);
  }

  tokenCount(): number | undefined {
    return this.digest.tokenCount();
  }

  get version(): number {
    return this.digest.version;
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

  composer(provider: string, replay: ReplayObservation) {
    return frameComposerState(provider as ProviderId, replay.frameText(), {
      modalOpen: this.activity(provider, replay) === "needs-input",
    });
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
