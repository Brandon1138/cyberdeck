import type { BrokerEventType } from "../../domain/events.js";
import type { SessionRecord, ThreadAttentionState } from "../../domain/session.js";
import type { ThreadEventKind, ThreadEventSource } from "../../domain/thread.js";
import type {
  ComposerObservation,
  InstructionLifecycleState,
  SessionTermination,
} from "../../domain/worker-truth.js";
import type { InstructionStateUpdate } from "./session-ports.js";

export type ProviderTerminalActivity =
  | "working"
  | "awaiting-input"
  | "needs-input"
  | "unknown";

/** A stripped replay tail plus whether its first visible line was severed by bounding. */
export interface BoundedReplayTail {
  text: string;
  truncated: boolean;
}

/** The bounded, incrementally maintained reading of one runtime replay. */
export interface ReplayObservation {
  appendBytes(chunk: Buffer): void;
  reset(replay: string): void;
  frameText(): string;
  strippedTail(maxChars: number): BoundedReplayTail;
  tokenCount(): number | undefined;
  readonly version: number;
}

/** Infrastructure-neutral terminal interpretation used by the worker turn state machine. */
export interface WorkerTurnObservationPort {
  createReplay(replayChars: number): ReplayObservation;
  activity(provider: string, replay: ReplayObservation): ProviderTerminalActivity;
  composer(provider: string, replay: ReplayObservation): ComposerObservation;
  fatalTermination(tail: BoundedReplayTail, at: string): SessionTermination | undefined;
  compactFrame(frame: string, maxChars?: number): string;
  compactTerminal(replay: string, maxChars?: number): string;
  fallbackTerminal(replay: string): string;
  truncateResult(text: string, maxChars: number): string;
}

export interface WorkerTurnTranscriptMessage {
  role: "assistant" | "user";
  text: string;
  occurredAt?: string | undefined;
}

export interface WorkerTurnTranscript {
  text?: string | undefined;
  data?: Record<string, unknown> | undefined;
}

export interface AppendWorkerTurnTranscriptEvent {
  sessionId: string;
  kind: ThreadEventKind;
  source: ThreadEventSource;
  text?: string;
  data?: Record<string, unknown>;
}

export interface CaptureWorkerTurns {
  sessionId: string;
  provider: string;
  cwd: string;
  createdAt: string;
  turnNumber: number;
  fallbackText?: string;
  allowFallback?: boolean;
}

export type WorkerTurnTransport = "provider-native" | "terminal-replay-fallback";

/** One provider result observed without mutating Cyberdeck's semantic transcript. */
export interface ObservedWorkerTurn {
  providerTurnId: string;
  providerOccurredAt: string;
  text: string;
  transport: WorkerTurnTransport;
  data?: Record<string, unknown>;
}

/** A side-effect-free provider observation prepared for one serialized commit. */
export interface WorkerTurnObservation {
  sessionId: string;
  provider: string;
  turnNumber: number;
  turns: readonly ObservedWorkerTurn[];
}

/** Provider transcript access expressed only in application and domain values. */
export interface WorkerTurnTranscriptPort {
  append(event: AppendWorkerTurnTranscriptEvent): Promise<unknown>;
  observeProviderTurns?(input: CaptureWorkerTurns): Promise<WorkerTurnObservation>;
  commitProviderTurns?(observation: WorkerTurnObservation): Promise<WorkerTurnTranscript[]>;
  /** Compatibility composition for callers that have not adopted explicit observation ownership. */
  captureProviderTurns?(input: CaptureWorkerTurns): Promise<WorkerTurnTranscript[]>;
  readTranscriptMessages?(input: CaptureWorkerTurns): Promise<WorkerTurnTranscriptMessage[]>;
  readObservedModel?(
    input: CaptureWorkerTurns,
  ): Promise<SessionRecord["observedModel"] | undefined>;
}

export interface WorkerTurnPreview {
  text: string;
  kind: "assistant" | "prompt" | "none";
}

export interface WorkerTurnPreviewInput {
  transcript?: readonly WorkerTurnTranscriptMessage[];
  storedPreview?: string;
  replay?: string;
  maxLength?: number;
}

/** Pure preview projection remains an outer interpretation detail. */
export interface WorkerTurnPreviewPort {
  preview(input: WorkerTurnPreviewInput): WorkerTurnPreview;
}

export interface RenderedWorkerInstruction {
  instructionId: string;
  expectedTurn: number;
  renderedAt: string;
  state?: InstructionLifecycleState;
}

export interface SubmitWorkerInstruction {
  message: string;
  encoded: Buffer | (() => Buffer);
  source: "orchestrator" | "worker";
  metadata?: Record<string, unknown>;
  instructionId?: string;
}

/** Effects the engine may request without learning about registry attachments or infrastructure. */
export interface WorkerTurnEngineEffects {
  hasRuntime?(): boolean;
  snapshot(): string | undefined;
  write(data: Buffer): void;
  appendEvent(type: BrokerEventType, data: Record<string, unknown>): Promise<void>;
  persist(): Promise<void>;
  setAttention(state: ThreadAttentionState, meaningful: boolean): Promise<void>;
  notifyInstructionState(update: InstructionStateUpdate): void;
  notifyDeliveryBoundary(): void;
  notifySessionUpdate(): void;
  scheduleSessionUpdate?(): void;
  stopRequested?(): boolean;
  scoutBudgetExhausting?(): boolean;
}
