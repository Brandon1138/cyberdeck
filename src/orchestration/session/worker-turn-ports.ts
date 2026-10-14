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
  /** Rendered rows with cursor positioning preserved; unknown screens return empty text. */
  modalFrameText?(): string;
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
  /** Explicit caller authorization from a positively observed boundary in this session's own terminal. */
  allowFallback?: boolean;
  /** Launch receipts require exact native attribution before any first-turn capture. */
  initialInstructionId?: string | undefined;
  /** Marker-injected Codex launches cannot adopt legacy markerless rollouts. */
  codexMarkerRequired?: boolean;
}

export type WorkerTurnTransport = "provider-native" | "terminal-replay-fallback" | "broker-lifecycle";
export type NativeSourceStatus = "available" | "missing" | "unbound" | "conflict" | "source-error";

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
  /** Bound native file plus complete-line offset; movement is independent of terminal bytes. */
  activityVersion?: string;
  /** Existence of an exactly attributed native source, independently of completed turns. */
  nativeSourceAvailable?: boolean;
  /** Missing sources and refused/unreadable identities are different evidence. */
  nativeSourceStatus?: NativeSourceStatus;
  nativeSourceReason?: string;
  /** True only for explicitly authorized own-terminal fallback when the native source is missing. */
  nativeFallbackAllowed?: boolean;
  nativeSessionId?: string;
  /** Provider-authored activity only; idle is never a statement about task success. */
  nativeActivity?: "working" | "idle" | "unknown";
  nativeActivityEvidence?: { id: string; occurredAt?: string; kind: string; providerTurnId?: string;
    generation?: number; executionId?: string; nativeSessionId?: string;
    /** Exact source identity/interval to retain if the engine banks an authoritative negative closure. */
    receiptData?: Record<string, unknown> };
}

export interface InstructionTurnTarget { instructionId: string; expectedTurn: number; renderedAt: string }

export interface WorkerTurnLedger {
  completedTurns: number;
  canonicalTurns: number;
  providerOccurredThrough?: string;
  instructionTargets?: readonly InstructionTurnTarget[];
  lastNativeTurn?: WorkerTurnTranscript;
  turns: readonly WorkerTurnTranscript[];
}

/** Provider transcript access expressed only in application and domain values. */
export interface WorkerTurnTranscriptPort {
  append(event: AppendWorkerTurnTranscriptEvent): Promise<unknown>;
  observeProviderTurns?(input: CaptureWorkerTurns): Promise<WorkerTurnObservation>;
  /** Durable high-water and recent receipts, restored before assigning new Claude ordinals. */
  readCompletionLedger?(sessionId: string): Promise<WorkerTurnLedger>;
  /** Return one ordered durable acknowledgement per observed turn, including deduped turns. */
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
  /** The provider's bare submit keystroke, pressed again if the composer is later seen still holding the text. */
  submitKey?: Buffer;
  source: "orchestrator" | "worker" | "broker";
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
