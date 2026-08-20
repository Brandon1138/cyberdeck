import type { InstructionRecord } from "../../domain/instruction.js";
import type { OrchestratorBinding } from "../../domain/orchestrator.js";
import type {
  SessionRecord,
  StartSessionRequest,
} from "../../domain/session.js";
import type { ScoutDecisionCard } from "../../domain/scout-output.js";
import type {
  ScoutArtifactKind,
  ScoutRuntimeState,
} from "../../domain/worker-profile.js";
import type {
  DeliveryHoldReason,
  InstructionLifecycleState,
  ProviderLimitTermination,
  WorkerTruth,
} from "../../domain/worker-truth.js";

export interface SessionLookupPort {
  get(sessionId: string): SessionRecord;
}

export interface SessionStartPort {
  start(
    request: StartSessionRequest,
    initialPrompt?: string,
    activate?: (record: SessionRecord) => Promise<void>,
  ): Promise<SessionRecord>;
}

export interface SessionResumePort {
  resume(sessionId: string): Promise<SessionRecord>;
}

export interface SessionProcessControlPort {
  ownsProcess(sessionId: string): boolean;
  isStopRequested(sessionId: string): boolean;
  stopRequestedAt(sessionId: string): string | undefined;
  stop(sessionId: string): Promise<void>;
  forceStop(sessionId: string): void;
}

export interface SessionUpdatePort {
  onSessionUpdate(listener: (sessionId: string) => void): () => void;
}

export interface WorkerWaitTarget {
  sessionId: string;
  completionTarget: number;
}

export interface WorkerResultSnapshot {
  sessionId: string;
  name?: string;
  provider: string;
  model?: string;
  effort?: string;
  status:
    | "completed"
    | "needs-input"
    | "working"
    | "waiting"
    | "stalled"
    | "failed"
    | "stopped"
    | "exited"
    | "budget_exhausted"
    /** The provider stopped itself on its own limits. Terminal, and the process may still be alive. */
    | "provider-limit";
  completedTurns: number;
  text: string;
  /**
   * The authoritative worker state this snapshot was projected from. `status` above answers "what
   * happened to the turn this wait asked about"; `truth` answers "what is this worker doing", and
   * both come from the same projection so a wait cannot disagree with `threads_list`.
   */
  truth: WorkerTruth;
  /** Whether the target turn's text is a provider turn or a screen scrape the broker settled for. */
  provenance?: "provider-transcript" | "terminal-replay";
  providerLimit?: ProviderLimitTermination;
  /** Only on a completed target: whether this delivery is the first one for that completion. */
  retrieval?: "fresh" | "replay";
  completedAt?: string;
  stalledForSeconds?: number;
  stallReason?: "transcript-and-token-count-unchanged-while-idle";
  tokenCount?: number;
  profile?: "scout";
  effectiveState?: SessionRecord["effectiveState"];
  reportPath?: string;
  reportState?: ScoutRuntimeState["reportState"];
  terminalState?: ScoutRuntimeState["terminalState"];
}

export interface WorkerWaitResult {
  timedOut: boolean;
  results: WorkerResultSnapshot[];
}

export interface WorkerTruthQueryPort {
  list(): SessionRecord[];
  workerTruth(sessionId: string): WorkerTruth;
  waitForWorkerResults(
    targets: readonly WorkerWaitTarget[],
    timeoutMs: number,
    maxResultChars?: number,
  ): Promise<WorkerWaitResult>;
}

export interface ScoutArtifactRead {
  artifact: ScoutArtifactKind;
  text: string;
  afterByte: number;
  nextByte: number;
  totalBytes: number;
  complete: boolean;
}

export interface ScoutArtifactQueryPort {
  readScoutArtifact(
    sessionId: string,
    artifact: ScoutArtifactKind,
    afterByte?: number,
    maxBytes?: number,
  ): Promise<ScoutArtifactRead>;
  scoutDecisionCard(sessionId: string): ScoutDecisionCard | undefined;
}

/** What `submitInstruction` actually did, as opposed to what it hopes happened next. */
export interface InstructionDelivery {
  /**
   * Never stronger than `rendered`: submission is observed later, never claimed synchronously.
   * `undelivered` is the other terminal answer — the worker will not read this, ever.
   */
  state: "queued" | "rendered" | "undelivered";
  hold?: DeliveryHoldReason;
  detail?: string;
  /** Present when `rendered`: the turn ordinal that will answer this instruction. */
  expectedTurn?: number;
  at: string;
}

/** A transition the broker observed for an instruction it had already rendered. */
export interface InstructionStateUpdate {
  sessionId: string;
  instructionId: string;
  state: InstructionLifecycleState;
  at: string;
  turn?: number;
}

export interface SessionInstructionPort extends SessionLookupPort {
  onControllerReleased(listener: (sessionId: string) => void): () => void;
  onDeliveryBoundary(listener: (sessionId: string) => void): () => void;
  onInstructionState(listener: (update: InstructionStateUpdate) => void): () => void;
  submitInstruction(
    sessionId: string,
    message: string,
    source: "orchestrator" | "worker",
    metadata?: Record<string, unknown>,
    instructionId?: string,
  ): Promise<InstructionDelivery>;
}

export interface InstructionRepository {
  list(targetSessionId?: string): Promise<InstructionRecord[]>;
  put(record: InstructionRecord): Promise<void>;
}

export interface OrchestratorBindingReader {
  findBySessionId(sessionId: string): Promise<OrchestratorBinding | undefined>;
}
