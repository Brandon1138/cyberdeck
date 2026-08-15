import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import type { BrokerRuntimeConfig } from "../config.js";
import { MAX_WAIT_SECONDS } from "../limits.js";
import type { BrokerEvent, BrokerEventType } from "../domain/events.js";
import { evaluateStart, type SessionAncestryEntry, type StartPolicyCode } from "../domain/policy.js";
import {
  StartSessionRequestSchema,
  type ResolvedLaunchRecord,
  type SessionRecord,
  type StartSessionRequest,
  type ThreadAttentionState,
} from "../domain/session.js";
import { resolvedLaunchRecord } from "../providers/launch-record.js";
import type {
  ProviderAdapter,
  ProviderLaunchSpec,
  ProviderSessionTerminal,
} from "../providers/provider.js";
import type {
  AppendThreadEvent,
  CaptureProviderTurns,
  ThreadTranscriptStore,
} from "../persistence/thread-transcript-store.js";
import { applyWorkerMode } from "../providers/worker-mode.js";
import { addWorkerReportingGuidance } from "../providers/worker-reporting.js";
import {
  conversationPreview,
  PREVIEW_STORAGE_LIMIT,
  type TranscriptMessage,
} from "../runtime/conversation-preview.js";
import type { ObservedModel } from "../runtime/observed-model.js";
import {
  compactTerminalResult,
  providerTerminalActivity,
  terminalTokenCount,
  terminalFallbackResult,
  truncateResult,
  type ProviderTerminalActivity,
} from "../runtime/terminal-replay.js";
import { detectProviderLimitTermination, detectSessionFatalError } from "../runtime/session-liveness.js";
import { terminalComposerState } from "../runtime/composer-state.js";
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
} from "../domain/worker-truth.js";
import { selectExpiredThreads } from "../domain/thread-retention.js";
import {
  MIN_SCOUT_REPLAY_BYTES,
  resolveScoutEffectiveState,
  scoutScopeViolation,
} from "../domain/worker-profile.js";
import type {
  ScoutArtifactKind,
  ScoutRuntimeState,
} from "../domain/worker-profile.js";
import {
  type ScoutDecisionCard,
} from "../domain/scout-output.js";
import type {
  ScoutArtifactRead,
  ScoutReportCapture,
  ScoutReportStore,
} from "../persistence/scout-report-store.js";
import { captureScoutWorkspaceStateHash } from "../providers/cursor/workspace-state.js";

export interface PtyHandle {
  readonly pid: number;
  write(data: Buffer): void;
  resize(cols: number, rows: number): void;
  snapshot(): Buffer;
  kill(signal?: string): void;
  onOutput(listener: (chunk: Buffer) => void): () => void;
  onExit(listener: (exitCode: number, signal?: number) => void): () => void;
}

export type PtyFactory = (spec: ProviderLaunchSpec, replayBytes: number) => PtyHandle;
export type AttachmentMode = "control" | "watch";
export type OutputSink = (chunk: Buffer) => void;
export type ExitSink = (exitCode: number) => void;
export type FailureSink = (failure: { code: string; message: string }) => void;

interface JournalLike {
  append(event: BrokerEvent): Promise<void>;
}

interface SessionStoreLike {
  put(record: SessionRecord): Promise<void>;
  delete(sessionId: string): Promise<void>;
}

interface TranscriptLike {
  append(event: AppendThreadEvent): Promise<unknown>;
  captureProviderTurns?(input: CaptureProviderTurns): Promise<Array<{ text?: string | undefined }>>;
  readTranscriptMessages?(input: CaptureProviderTurns): Promise<TranscriptMessage[]>;
  readObservedModel?(input: CaptureProviderTurns): Promise<ObservedModel | undefined>;
}

interface Controller {
  clientId: string;
  output: OutputSink;
  ended: ExitSink;
  failed: FailureSink;
}

interface Watcher {
  output: OutputSink;
  ended: ExitSink;
  failed: FailureSink;
}

/**
 * One completed turn, kept so the same `completionTarget` stays retrievable after the caller's
 * transport dies. `deliveries` makes a replay distinguishable from a first read, which is what lets
 * an orchestrator prove a mutation already ran instead of relaunching a duplicate worker.
 */
interface CompletionLedgerEntry {
  text: string;
  completedAt: string;
  deliveries: number;
  /**
   * Where the text came from. `provider-transcript` is a canonical turn the provider itself wrote;
   * `terminal-replay` is a screen scrape the broker settled for. Both count as completed turns —
   * refusing to count a replay turn would hang every provider without a native transcript — but a
   * caller that was told a worker "completed" while `thread_read` showed zero semantic turns was
   * looking at this distinction with no way to see it.
   */
  provenance: "provider-transcript" | "terminal-replay";
}

/**
 * An instruction whose bytes are in the provider's input surface but whose submission has not been
 * observed. It is the object the `rendered` state is about.
 */
interface RenderedInstruction {
  instructionId: string;
  /** The turn ordinal that will answer this instruction, fixed at render time. */
  expectedTurn: number;
  renderedAt: string;
  state: InstructionLifecycleState;
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

interface RuntimeSession {
  record: SessionRecord;
  pty?: PtyHandle;
  controller?: Controller;
  watchers: Map<string, Watcher>;
  stopRequested: boolean;
  stopRequestedAt?: string;
  activity: ProviderTerminalActivity;
  observedWorking: boolean;
  completedTurns: number;
  /** Subset of `completedTurns` whose text came from a provider-native transcript turn. */
  canonicalTurns: number;
  /**
   * Completed turns at the moment the newest instruction was rendered. A `completionTarget` at or
   * below this floor names a turn that finished before the instruction existed, so settling a wait
   * from that ledger slot would hand back an answer to an older question.
   */
  turnsBeforeLatestInstruction: number;
  /** What the provider's input surface is holding, refreshed from every observed frame. */
  composer: ComposerObservation;
  /** Instructions written into the composer whose submission has not been observed yet. */
  rendered: RenderedInstruction[];
  /** Set while the delivery boundary is unsafe, so the return to safety can be announced once. */
  deliveryHeld: boolean;
  /** Set once the provider stopped itself on its own limits. */
  providerLimit?: ProviderLimitTermination;
  latestResult?: string;
  /** Set once a fatal provider fault has been recorded, so replay never re-reports the same death. */
  fatalReported: boolean;
  /** The stop that killed this session was a broker shutdown of an already-finished thread. */
  outcomePreserved?: boolean;
  /** Per-turn results keyed by completion target, bounded by MAX_COMPLETION_LEDGER_ENTRIES. */
  completions: Map<number, CompletionLedgerEntry>;
  idleTimer?: ReturnType<typeof setTimeout>;
  /** Provider-native setup output must never satisfy the worker task's first completion target. */
  suppressSemanticTurns?: boolean;
  stallObservation?: {
    replay: string;
    tokenCount: number;
    unchangedSinceMs: number;
  };
  /** Serializes provider launch-artifact work so a pending cleanup cannot delete a fresh resume. */
  launchTail: Promise<void>;
  /** Serializes framed drop-box capture so older PTY snapshots cannot overwrite newer ones. */
  scoutCaptureTail?: Promise<void>;
  /** Serializes the full provider stream into the durable trace artifact. */
  scoutTraceTail?: Promise<void>;
  scoutTraceFailure?: string;
  /** Prevents duplicate async finalization when a child process reports more than one close path. */
  scoutFinalizing?: boolean;
  scoutBudgetTimer?: ReturnType<typeof setTimeout>;
  scoutBudgetActive?: boolean;
  scoutBudgetExhausting?: boolean;
  scoutCutoffStarted?: boolean;
  scoutExpectedSuccessfulStop?: boolean;
  scoutAcceptedCardStopRequested?: boolean;
  scoutCard?: ScoutDecisionCard;
}

const MAX_COMPLETION_LEDGER_ENTRIES = 64;

/**
 * The state-machine fields every runtime session starts with, in one place so a construction site
 * added later cannot silently omit one and leave a worker projecting from undefined.
 */
function freshTruthState(): Pick<
  RuntimeSession,
  | "completedTurns"
  | "canonicalTurns"
  | "turnsBeforeLatestInstruction"
  | "composer"
  | "rendered"
  | "deliveryHeld"
> {
  return {
    completedTurns: 0,
    canonicalTurns: 0,
    turnsBeforeLatestInstruction: 0,
    composer: { modalOpen: false, occupied: false },
    rendered: [],
    deliveryHeld: false,
  };
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

export interface SessionTreeProgress {
  rootSessionId: string;
  rootKind: "worker" | "orchestrator";
  childCount: number;
  total: number;
  active: number;
  stopping: number;
  terminal: number;
}

export type ReattachTarget =
  | { status: "ready"; record: SessionRecord; requiresResume: boolean }
  | { status: "unavailable"; record: SessionRecord }
  | { status: "stale" };

export interface SessionRegistryOptions {
  adapters: Record<string, ProviderAdapter>;
  ptyFactory: PtyFactory;
  journal: JournalLike;
  transcripts?: ThreadTranscriptStore | TranscriptLike;
  store?: SessionStoreLike;
  recoveredSessions?: readonly SessionRecord[];
  validateCwd?: ((cwd: string) => Promise<void>) | undefined;
  config: BrokerRuntimeConfig;
  /** Injected monotonic-enough wall clock for stalled-worker tests. */
  now?: () => number;
  scoutReports?: Pick<
    ScoutReportStore,
    "initialize" | "capture" | "collect" | "appendTrace" | "readArtifact" | "remove"
  >;
  scoutWorkspaceState?: (cwd: string) => Promise<string>;
}

export class RegistryError extends Error {
  constructor(
    readonly code:
      | StartPolicyCode
      | "PROVIDER_NOT_REGISTERED"
      | "SESSION_NOT_FOUND"
      | "SESSION_ALREADY_CONTROLLED"
      | "SESSION_NOT_ACTIVE"
      | "SESSION_ALREADY_ACTIVE"
      | "NOT_SESSION_CONTROLLER"
      | "SESSION_BUSY"
      | "SESSION_STILL_ACTIVE"
      | "PARENT_SESSION_NOT_ACTIVE"
      | "INVALID_SESSION_CWD"
      | "INVALID_WORKER_PROFILE"
      | "SCOUT_REPORT_STORE_UNAVAILABLE"
      | "SCOUT_LAUNCH_FAILED",
    message: string,
    readonly sessionId?: string,
  ) {
    super(message);
    this.name = "RegistryError";
  }
}

export class SessionRegistry {
  private readonly sessions = new Map<string, RuntimeSession>();
  private readonly controllerReleasedListeners = new Set<(sessionId: string) => void>();
  private readonly sessionUpdateListeners = new Set<(sessionId: string) => void>();
  private readonly deliveryBoundaryListeners = new Set<(sessionId: string) => void>();
  private readonly instructionStateListeners = new Set<(update: InstructionStateUpdate) => void>();
  private readonly scoutWorkspaceStateInflight = new Map<string, Promise<string>>();
  private readonly recovery: Promise<void>;
  /** Starts admitted by policy but not yet represented in `sessions`. */
  private pendingWorkerStarts = 0;
  /** Set by `stopAll` so the shutdown kill is distinguishable from an operator stop. */
  private shuttingDown = false;

  constructor(private readonly options: SessionRegistryOptions) {
    const writes: Promise<void>[] = [];
    for (const stored of options.recoveredSessions ?? []) {
      const record = this.recoverRecord(stored);
      // A provider limit is the one piece of runtime truth that survives the process that observed
      // it, because the cap belongs to the account rather than to the PTY. Recovery folds `errored`
      // into `failed`, so without rehydrating this the operator is told the worker crashed when it
      // was actually told to come back at 3:00pm.
      const providerLimit = providerLimitFromTermination(record.termination);
      this.sessions.set(record.id, {
        record,
        watchers: new Map(),
        stopRequested: false,
        activity: "unknown",
        observedWorking: false,
        ...freshTruthState(),
        ...(providerLimit === undefined ? {} : { providerLimit }),
        fatalReported: false,
        completions: new Map(),
        launchTail: Promise.resolve(),
      });
      // Recovery rewrites lifecycle fields, so the catalog is only authoritative once the rewrite
      // is written back. Persist whenever recovery actually changed the outcome, not just for the
      // interrupted case — a thread recovered as finished has to survive the *next* restart too.
      const rewritten = record.executionState !== stored.executionState
        || record.attentionState !== stored.attentionState
        || record.exitCode !== stored.exitCode;
      if (rewritten) {
        writes.push(this.options.store?.put(this.cloneRecord(record)) ?? Promise.resolve());
      }
    }
    this.recovery = Promise.all(writes)
      .then(() => this.recoverScoutReports())
      .then(() => undefined);
  }

  async ready(): Promise<void> {
    await this.recovery;
  }

  onControllerReleased(listener: (sessionId: string) => void): () => void {
    this.controllerReleasedListeners.add(listener);
    return () => this.controllerReleasedListeners.delete(listener);
  }

  /**
   * `activate` is the caller's chance to make a record durable *before* the session can act on it.
   * A provider whose instructions have to be submitted as a message rather than a system prompt
   * takes its first model turn inside `initializeSession`, still within this call, so anything that
   * turn may read back through the broker — an orchestrator's grant above all — cannot be written
   * after `start` returns. A throwing `activate` tears the session down exactly as a failed
   * initialization does; it is never left live but unauthorized.
   */
  async start(
    request: StartSessionRequest,
    initialPrompt?: string,
    activate?: (record: SessionRecord) => Promise<void>,
  ): Promise<SessionRecord> {
    const validated = StartSessionRequestSchema.parse(request);
    if (validated.profile === "scout") {
      if (validated.brief === undefined) {
        throw new RegistryError("INVALID_WORKER_PROFILE", "Scout profile requires a structured brief");
      }
      if ((validated.kind ?? "worker") !== "worker") {
        throw new RegistryError("INVALID_WORKER_PROFILE", "Scout profile can only use worker lifecycle");
      }
      if (
        validated.provider !== "cursor"
        || validated.model !== "composer"
        || validated.sandbox !== "read-only"
        || validated.approvalMode !== "auto"
        || validated.workerMode === "caveman"
      ) {
        throw new RegistryError(
          "INVALID_WORKER_PROFILE",
          "Scout profile requires Cursor Composer, read-only sandbox, auto approval, and normal worker mode",
        );
      }
      const scopeViolation = scoutScopeViolation(validated.cwd, validated.brief.scope);
      if (scopeViolation !== undefined) {
        throw new RegistryError("INVALID_WORKER_PROFILE", scopeViolation);
      }
    }
    await (this.options.validateCwd ?? validateSessionCwd)(validated.cwd);
    const parsed = validated;
    this.requireActiveParent(parsed.parentSessionId);
    const ancestry = this.resolveAncestry(parsed.parentSessionId);
    const decision = evaluateStart(parsed, ancestry, {
      activeWorkerCount: this.activeWorkerCount() + this.pendingWorkerStarts,
      maxConcurrentWorkers: this.options.config.maxConcurrentWorkers,
      maxDelegationDepth: this.options.config.maxDelegationDepth,
    });
    if (!decision.allowed) {
      const message = decision.code === "MAX_CONCURRENT_WORKERS"
        ? `Worker limit reached: ${decision.activeWorkers ?? 0} active / ${decision.maxConcurrentWorkers ?? "unknown"} allowed`
        : decision.code;
      throw new RegistryError(decision.code, message);
    }

    const reservesWorker = (parsed.kind ?? "worker") === "worker";
    if (reservesWorker) this.pendingWorkerStarts += 1;
    let reservationHeld = reservesWorker;
    const releaseReservation = () => {
      if (!reservationHeld) return;
      this.pendingWorkerStarts -= 1;
      reservationHeld = false;
    };

    const id = randomUUID();
    const now = new Date().toISOString();
    let scout: ScoutRuntimeState | undefined;
    try {
      scout = parsed.profile === "scout"
        ? await this.requireScoutReports().initialize(id, parsed.cwd)
        : undefined;
    } catch (error) {
      releaseReservation();
      throw error;
    }
    const provisional: SessionRecord = {
      ...parsed,
      kind: parsed.kind ?? "worker",
      id,
      generation: 1,
      createdAt: now,
      updatedAt: now,
      executionState: "starting",
      attachmentState: "detached",
      pid: 0,
      exitCode: null,
      childIds: [],
      attentionState: initialPrompt === undefined ? "done" : "working",
      meaningfulUpdatedAt: now,
      ...(parsed.profile === "scout"
        ? {
            effectiveState: resolveScoutEffectiveState(parsed.leasePolicy),
            scout,
          }
        : {}),
    };
    let adapter: ProviderAdapter;
    let preparedInitialPrompt: string | undefined;
    let deferredInitialPrompt: boolean;
    let launchSpec: ProviderLaunchSpec | undefined;
    let pty: PtyHandle;
    let scoutLaunchPhase: NonNullable<ScoutRuntimeState["launchFailure"]>["phase"] = "prepare";
    try {
      if (provisional.profile === "scout" && provisional.scout !== undefined) {
        scoutLaunchPhase = "verify";
        provisional.scout.workspaceStateHash = await this.scoutWorkspaceState(provisional.cwd);
      }
      scoutLaunchPhase = "prepare";
      adapter = this.requireAdapter(parsed.provider);
      preparedInitialPrompt = initialPrompt === undefined
        ? undefined
        : provisional.profile === "scout"
          ? initialPrompt
          : (provisional.kind ?? "worker") === "worker"
          ? addWorkerReportingGuidance(
              applyWorkerMode(initialPrompt, provisional.workerMode),
              provisional.id,
            )
          : applyWorkerMode(initialPrompt, provisional.workerMode);
      deferredInitialPrompt = initialPrompt !== undefined
        && adapter.deferInitialPrompt?.(provisional) === true;
      launchSpec = adapter.buildLaunchSpec(
        provisional,
        initialPrompt === undefined || deferredInitialPrompt
          ? undefined
          : preparedInitialPrompt,
      );
      pty = await this.spawnPreparedLaunch(
        adapter,
        provisional,
        launchSpec,
        async () => {
          this.requireActiveParent(parsed.parentSessionId);
          if (initialPrompt !== undefined && !deferredInitialPrompt) {
            await this.options.transcripts?.append({
              sessionId: id,
              kind: "prompt",
              source: "human",
              text: initialPrompt,
              data: { initial: true },
            });
          }
          this.requireActiveParent(parsed.parentSessionId);
        },
        (phase) => { scoutLaunchPhase = phase; },
      );
    } catch (error) {
      releaseReservation();
      if (provisional.profile === "scout" && provisional.scout !== undefined) {
        await this.preserveFailedScoutLaunch(
          provisional,
          scoutLaunchPhase,
          error,
          launchSpec,
        );
        throw this.scoutLaunchError(provisional.id, error);
      }
      throw error;
    }
    const record: SessionRecord = {
      ...provisional,
      pid: pty.pid,
      executionState: "active",
      updatedAt: new Date().toISOString(),
      launchRecord: resolvedLaunchRecord(launchSpec, "launch"),
    };
    const runtime: RuntimeSession = {
      record,
      pty,
      watchers: new Map(),
      stopRequested: false,
      activity: "unknown",
      observedWorking: false,
      ...freshTruthState(),
      fatalReported: false,
      completions: new Map(),
      suppressSemanticTurns: true,
      launchTail: Promise.resolve(),
    };
    this.sessions.set(id, runtime);
    releaseReservation();
    this.adoptPty(runtime, pty);

    if (record.profile === "scout") {
      try {
        await this.registerSession(runtime);
      } catch (error) {
        await this.failLiveScout(runtime, "initialize", error);
        throw this.scoutLaunchError(record.id, error);
      }
    }

    try {
      const sessionTerminal: ProviderSessionTerminal = {
        snapshot: () => pty.snapshot(),
        write: (data) => pty.write(data),
        wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
      };
      // Before initialization, because initialization is where a message-instructed provider takes
      // its first model turn and can immediately call back into the broker.
      await activate?.(this.cloneRecord(record));
      await adapter.initializeSession?.(record, sessionTerminal);
      if (
        runtime.record.profile !== "scout"
        && runtime.record.executionState !== "active"
      ) {
        throw new RegistryError(
          "SESSION_NOT_ACTIVE",
          runtime.latestResult ?? "Provider session exited during initialization",
        );
      }
      runtime.activity = "unknown";
      runtime.observedWorking = false;
      delete runtime.stallObservation;
      delete runtime.suppressSemanticTurns;
      if (
        deferredInitialPrompt
        && initialPrompt !== undefined
        && preparedInitialPrompt !== undefined
      ) {
        await this.options.transcripts?.append({
          sessionId: id,
          kind: "prompt",
          source: "human",
          text: initialPrompt,
          data: { initial: true },
        });
        this.requireActiveParent(parsed.parentSessionId);
        this.armScoutBudget(runtime);
        if (adapter.submitInputToTerminal !== undefined) {
          await adapter.submitInputToTerminal(preparedInitialPrompt, sessionTerminal);
        } else {
          const data = adapter.submitInput?.(preparedInitialPrompt)
            ?? Buffer.from(`${preparedInitialPrompt}\n`);
          pty.write(data);
        }
      } else {
        this.armScoutBudget(runtime);
      }
    } catch (error) {
      if (record.profile === "scout") {
        await this.failLiveScout(runtime, "initialize", error);
        throw this.scoutLaunchError(record.id, error);
      }
      if (runtime.idleTimer !== undefined) clearTimeout(runtime.idleTimer);
      delete runtime.idleTimer;
      if (runtime.pty === pty) delete runtime.pty;
      pty.kill();
      this.sessions.delete(id);
      await this.cleanupLaunchArtifacts(record, "initialization-failed");
      throw error;
    }

    if (record.profile !== "scout") {
      try {
        await this.registerSession(runtime);
      } catch (error) {
        pty.kill();
        this.sessions.delete(id);
        await this.cleanupLaunchArtifacts(record, "launch-failed");
        throw error;
      }
    }

    return this.cloneRecord(runtime.record);
  }

  list(): SessionRecord[] {
    return [...this.sessions.values()].map(({ record }) => this.cloneRecord(record));
  }

  workerCapacity(): { activeWorkers: number; maxConcurrentWorkers: number | null } {
    return {
      activeWorkers: this.activeWorkerCount(),
      maxConcurrentWorkers: this.options.config.maxConcurrentWorkers,
    };
  }

  get(sessionId: string): SessionRecord {
    return this.cloneRecord(this.requireRuntime(sessionId).record);
  }

  async readScoutArtifact(
    sessionId: string,
    artifact: ScoutArtifactKind,
    afterByte = 0,
    maxBytes = 16 * 1024,
  ): Promise<ScoutArtifactRead> {
    const record = this.requireRuntime(sessionId).record;
    if (record.profile !== "scout" || record.scout === undefined) {
      throw new RegistryError(
        "INVALID_WORKER_PROFILE",
        `Session ${sessionId} is not a Scout`,
      );
    }
    return this.requireScoutReports().readArtifact(
      record.scout,
      artifact,
      afterByte,
      maxBytes,
    );
  }

  scoutDecisionCard(sessionId: string): ScoutDecisionCard | undefined {
    const card = this.requireRuntime(sessionId).scoutCard;
    return card === undefined
      ? undefined
      : { ...card, evidence: [...card.evidence] };
  }

  /**
   * The sanitized record of the launch or resume the broker actually performed. Purely a read of
   * state captured at spawn time: inspection never rebuilds a spec and never touches the filesystem.
   */
  launchRecord(sessionId: string): ResolvedLaunchRecord | undefined {
    return cloneLaunchRecord(this.requireRuntime(sessionId).record.launchRecord);
  }

  resolveReattachTarget(sessionId: string): ReattachTarget {
    const runtime = this.sessions.get(sessionId);
    if (runtime === undefined) return { status: "stale" };
    if (runtime.record.executionState === "active") {
      const record = this.cloneRecord(runtime.record);
      return runtime.controller === undefined
        ? { status: "ready", record, requiresResume: false }
        : { status: "unavailable", record };
    }
    // A thread whose outcome survived a restart is still the operator's last thread, so it offers
    // a resume rather than dropping them back to the list because their agent happened to finish.
    // A stopped, failed, or errored thread stays stale: those are outcomes to look at, not resume.
    if (
      runtime.record.exitCode !== null
      && (runtime.record.attentionState === "interrupted" || runtime.record.attentionState === "done")
    ) {
      return {
        status: "ready",
        record: this.cloneRecord(runtime.record),
        requiresResume: true,
      };
    }
    return { status: "stale" };
  }

  async waitForWorkerResults(
    targets: readonly WorkerWaitTarget[],
    timeoutMs: number,
    maxResultChars = 1_200,
  ): Promise<WorkerWaitResult> {
    // The floor is zero: a caller that already spent its logical budget must get an immediate
    // structured answer, not another second of blocking. The ceiling is the same constant the
    // schemas validate against, so no layer can accept a value another layer would silently cut.
    const boundedTimeout = Math.max(0, Math.min(timeoutMs, MAX_WAIT_SECONDS * 1_000));
    const snapshot = (): WorkerResultSnapshot[] => targets.map((target) =>
      this.workerResultSnapshot(target, maxResultChars)
    );
    const isSettled = (result: WorkerResultSnapshot): boolean =>
      result.status !== "working" && result.status !== "waiting";

    const initial = snapshot();
    if (initial.every(isSettled)) return { timedOut: false, results: this.deliver(targets, initial) };

    return new Promise<WorkerWaitResult>((resolve) => {
      let settled = false;
      const finish = (timedOut: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.sessionUpdateListeners.delete(onUpdate);
        const results = snapshot();
        resolve({
          timedOut: timedOut && !results.every(isSettled),
          results: this.deliver(targets, results),
        });
      };
      const targetIds = new Set(targets.map(({ sessionId }) => sessionId));
      const onUpdate = (sessionId: string) => {
        if (!targetIds.has(sessionId)) return;
        if (snapshot().every(isSettled)) finish(false);
      };
      const timer = setTimeout(() => finish(true), boundedTimeout);
      this.sessionUpdateListeners.add(onUpdate);
      if (snapshot().every(isSettled)) finish(false);
    });
  }

  /** Observe material session changes without taking attachment ownership. */
  onSessionUpdate(listener: (sessionId: string) => void): () => void {
    this.sessionUpdateListeners.add(listener);
    return () => this.sessionUpdateListeners.delete(listener);
  }

  async attach(
    sessionId: string,
    clientId: string,
    mode: AttachmentMode,
    output: OutputSink,
    ended: ExitSink = () => {},
    failed: FailureSink = () => {},
  ): Promise<Buffer> {
    const runtime = this.requireRuntime(sessionId);
    if (runtime.record.executionState !== "active") {
      throw new RegistryError("SESSION_NOT_ACTIVE", "Session is not active; resume it before attaching");
    }
    const pty = this.requirePty(runtime);
    if (mode === "control") {
      if (runtime.controller !== undefined && runtime.controller.clientId !== clientId) {
        throw new RegistryError("SESSION_ALREADY_CONTROLLED", "Session already has a controller");
      }
      runtime.controller = { clientId, output, ended, failed };
      runtime.watchers.delete(clientId);
    } else {
      runtime.watchers.set(clientId, { output, ended, failed });
    }
    this.updateAttachmentState(runtime);
    try {
      await this.appendEvent("session.attached", sessionId, { clientId, mode });
    } catch (error) {
      if (runtime.controller?.clientId === clientId) delete runtime.controller;
      runtime.watchers.delete(clientId);
      this.updateAttachmentState(runtime);
      throw error;
    }
    return pty.snapshot();
  }

  async detach(sessionId: string, clientId: string): Promise<void> {
    const runtime = this.requireRuntime(sessionId);
    let detached = false;
    let controllerReleased = false;
    if (runtime.controller?.clientId === clientId) {
      delete runtime.controller;
      detached = true;
      controllerReleased = true;
    }
    if (runtime.watchers.delete(clientId)) {
      detached = true;
    }
    if (!detached) return;
    this.updateAttachmentState(runtime);
    await this.appendEvent("session.detached", sessionId, { clientId });
    if (controllerReleased) {
      for (const listener of this.controllerReleasedListeners) listener(sessionId);
    }
  }

  async releaseClient(clientId: string): Promise<void> {
    for (const sessionId of this.sessions.keys()) {
      await this.detach(sessionId, clientId);
    }
  }

  async write(sessionId: string, clientId: string | undefined, data: Buffer): Promise<void> {
    const runtime = this.requireRuntime(sessionId);
    if (runtime.record.executionState !== "active") {
      throw new RegistryError("SESSION_NOT_ACTIVE", "Session is not active");
    }
    this.requireInteractiveInput(runtime);
    if (runtime.controller !== undefined && runtime.controller.clientId !== clientId) {
      throw new RegistryError("NOT_SESSION_CONTROLLER", "Another client controls this session");
    }
    this.requirePty(runtime).write(data);
    await this.appendEvent("session.input", sessionId, { bytes: data.length });
  }

  async submit(sessionId: string, clientId: string | undefined, message: string): Promise<void> {
    const runtime = this.requireRuntime(sessionId);
    this.requireInteractiveInput(runtime);
    const adapter = this.requireAdapter(runtime.record.provider);
    const data = adapter.submitInput?.(message) ?? Buffer.from(`${message}\n`);
    delete runtime.stallObservation;
    await this.appendTranscript(sessionId, "prompt", "human", message, {});
    await this.setAttention(runtime, "working", true);
    await this.write(sessionId, clientId, data);
  }

  /**
   * Put one instruction in front of a worker, and report only what actually happened.
   *
   * The old contract wrote the payload at the PTY unconditionally and let the caller record
   * `delivered`. Bytes written at a terminal are not delivery: a worker sitting at a permission
   * modal is not reading its composer, so the entire instruction stayed there unsent while the
   * orchestrator had been told it landed, and the worker's next turn — a stale one — settled the
   * wait that was asking about it.
   *
   * Two rules replace that. The payload is never written at an unsafe boundary, so nothing lands in
   * a composer nobody is going to submit; and the strongest state this call can return is
   * `rendered`, because submission is something the broker observes afterwards rather than something
   * it may assume.
   */
  async submitInstruction(
    sessionId: string,
    message: string,
    source: "orchestrator" | "worker" = "orchestrator",
    metadata: Record<string, unknown> = {},
    instructionId?: string,
  ): Promise<InstructionDelivery> {
    const runtime = this.requireRuntime(sessionId);
    if (runtime.record.executionState !== "active") {
      // Not an exception: a worker that died between acceptance and delivery has answered the
      // question. Throwing here left the durable record `accepted` forever, deduplicating every
      // retry of an instruction nothing would ever read.
      return this.terminalDelivery(runtime, source, instructionId);
    }
    if (runtime.controller !== undefined) {
      throw new RegistryError("SESSION_BUSY", "A human controller currently owns this thread");
    }
    this.requireInteractiveInput(runtime);
    const hold = this.deliveryHold(runtime);
    if (hold !== undefined) return this.holdInstruction(runtime, hold, source, instructionId);
    const adapter = this.requireAdapter(runtime.record.provider);
    const encoded = adapter.submitInput?.(message) ?? Buffer.from(`${message}\n`);
    const pty = this.requirePty(runtime);
    delete runtime.stallObservation;
    const at = new Date().toISOString();
    const expectedTurn = runtime.completedTurns + 1;
    // Nothing is awaited between the boundary check and the write. An await here is a window for a
    // human to attach or for the provider to start a turn of its own, and either one would make the
    // ordinal above name a turn this instruction did not cause.
    runtime.turnsBeforeLatestInstruction = runtime.completedTurns;
    if (instructionId !== undefined) {
      runtime.rendered.push({ instructionId, expectedTurn, renderedAt: at, state: "rendered" });
    }
    pty.write(encoded);
    await this.appendTranscript(sessionId, "instruction", source, message, {
      ...metadata,
      instructionState: "rendered" satisfies InstructionLifecycleState,
      expectedTurn,
      ...(instructionId === undefined ? {} : { instructionId }),
    });
    await this.setAttention(runtime, "working", true);
    await this.appendEvent("session.input", sessionId, { bytes: encoded.length, source });
    return { state: "rendered", expectedTurn, at };
  }

  /**
   * Whether the provider is in a state where a written payload would actually be read.
   *
   * A blocking modal and an occupied composer are both "the input surface is not yours right now".
   * The difference from a human controller is only who took it, and all three answers are the same:
   * hold the instruction rather than writing into a surface that will swallow it.
   */
  private deliveryHold(runtime: RuntimeSession): DeliveryHoldReason | undefined {
    if (runtime.record.executionState !== "active") return "worker-terminal";
    if (runtime.controller !== undefined) return "human-controller";
    this.observeComposer(runtime);
    if (runtime.composer.modalOpen || runtime.activity === "needs-input") return "provider-modal";
    if (runtime.composer.occupied) return "composer-occupied";
    // A turn in flight owns the ordinal this instruction would otherwise be given. `observedWorking`
    // keeps the hold through the gap between the provider returning to its prompt and the ledger
    // counting that turn: for those milliseconds the screen looks idle and the turn is not banked
    // yet, which is the same ordinal collision one frame later.
    if (runtime.activity === "working" || runtime.observedWorking) return "provider-busy";
    return undefined;
  }

  /**
   * Answer an instruction aimed at a worker that is already gone.
   *
   * `queued` would be a lie with no end: nothing will ever clear this hold, and the queue would keep
   * the record alive and deduplicated against every retry. `undelivered` is terminal and says the
   * one thing the caller needs — the payload was never read, so the work did not happen.
   */
  private async terminalDelivery(
    runtime: RuntimeSession,
    source: "orchestrator" | "worker",
    instructionId: string | undefined,
  ): Promise<InstructionDelivery> {
    const at = new Date().toISOString();
    await this.appendTranscript(runtime.record.id, "lifecycle", "broker", "instruction undelivered", {
      instructionState: "undelivered" satisfies InstructionLifecycleState,
      holdReason: "worker-terminal" satisfies DeliveryHoldReason,
      executionState: runtime.record.executionState,
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
    runtime: RuntimeSession,
    hold: DeliveryHoldReason,
    source: "orchestrator" | "worker",
    instructionId: string | undefined,
  ): Promise<InstructionDelivery> {
    runtime.deliveryHeld = true;
    const at = new Date().toISOString();
    await this.appendTranscript(runtime.record.id, "lifecycle", "broker", "instruction held", {
      instructionState: "queued" satisfies InstructionLifecycleState,
      holdReason: hold,
      source,
      ...(instructionId === undefined ? {} : { instructionId }),
    });
    await this.appendEvent("session.input", runtime.record.id, {
      bytes: 0,
      source,
      held: hold,
    });
    return { state: "queued", hold, detail: DELIVERY_HOLD_DETAIL[hold], at };
  }

  /** Announce that a worker which was refusing instructions can take one again. */
  onDeliveryBoundary(listener: (sessionId: string) => void): () => void {
    this.deliveryBoundaryListeners.add(listener);
    return () => this.deliveryBoundaryListeners.delete(listener);
  }

  /** Observe an instruction the broker had already rendered moving on through its lifecycle. */
  onInstructionState(listener: (update: InstructionStateUpdate) => void): () => void {
    this.instructionStateListeners.add(listener);
    return () => this.instructionStateListeners.delete(listener);
  }

  /**
   * The one place any surface may ask what a worker is doing.
   *
   * `cyberdeck_workers_wait`, `cyberdeck_threads_list` and `cyberdeck_worker_events` all render this
   * value, which is what stops them contradicting each other in front of an orchestrator.
   */
  /**
   * The one authoritative reading of what a worker is doing.
   *
   * `workers_wait`, `threads_list`, and `worker_events` all project from this, so an orchestrator
   * cannot be told a worker is done by one surface and active by another — the contradiction MIK-71
   * was filed for.
   */
  workerTruth(sessionId: string): WorkerTruth {
    const runtime = this.requireRuntime(sessionId);
    return this.projectTruth(runtime, runtime.pty?.snapshot().toString("utf8") ?? "");
  }

  private projectTruth(runtime: RuntimeSession, replay: string): WorkerTruth {
    this.observeComposer(runtime, replay);
    const stalled = this.stalledWorker(runtime, replay);
    return projectWorkerTruth({
      executionState: runtime.record.executionState,
      exitCode: runtime.record.exitCode,
      activity: runtime.activity,
      composer: runtime.composer,
      completedTurns: runtime.completedTurns,
      canonicalTurns: runtime.canonicalTurns,
      pendingInstructions: runtime.rendered.length,
      providerLimit: runtime.providerLimit,
      stalledForSeconds: stalled?.stalledForSeconds,
      scoutTerminalState: runtime.record.scout?.terminalState,
      stopRequested: runtime.stopRequested,
    });
  }

  resize(sessionId: string, clientId: string | undefined, cols: number, rows: number): void {
    const runtime = this.requireRuntime(sessionId);
    if (runtime.record.executionState !== "active") {
      throw new RegistryError("SESSION_NOT_ACTIVE", "Session is not active");
    }
    if (runtime.controller !== undefined && runtime.controller.clientId !== clientId) {
      throw new RegistryError("NOT_SESSION_CONTROLLER", "Another client controls this session");
    }
    this.requirePty(runtime).resize(cols, rows);
  }

  snapshot(sessionId: string): Buffer {
    return this.requireRuntime(sessionId).pty?.snapshot() ?? Buffer.alloc(0);
  }

  ownsProcess(sessionId: string): boolean {
    return this.requireRuntime(sessionId).pty !== undefined;
  }

  isStopRequested(sessionId: string): boolean {
    return this.requireRuntime(sessionId).stopRequested;
  }

  stopRequestedAt(sessionId: string): string | undefined {
    return this.requireRuntime(sessionId).stopRequestedAt;
  }

  async stop(sessionId: string): Promise<void> {
    const runtime = this.requireRuntime(sessionId);
    if (runtime.record.exitCode !== null) {
      if (runtime.record.attentionState === "stopped") return;
      await this.setAttention(runtime, "stopped", true);
      await this.appendEvent("session.stopped", sessionId, {});
      await this.appendTranscript(sessionId, "lifecycle", "broker", "session stopped", {});
      this.notifySessionUpdate(sessionId);
      return;
    }
    if (runtime.stopRequested) {
      // A repeated graceful request is idempotent. Force escalation is deliberately available
      // only through `forceStop`, where broker policy can require a grace period and audit it.
      return;
    }
    // An errored or failed session may still own a running OS process, so stop must be able to reach
    // it even though the broker no longer counts it as active.
    if (
      runtime.record.executionState !== "active"
      && runtime.record.executionState !== "errored"
      && runtime.record.executionState !== "failed"
    ) return;
    runtime.stopRequested = true;
    runtime.stopRequestedAt = new Date().toISOString();
    runtime.record.executionState = "cancelled";
    // Shutting the broker down does not undo what an agent already delivered. A thread that had
    // finished its task keeps that outcome through the kill, so it rehydrates as Done rather than
    // as Stopped. An operator-initiated stop still reads as Stopped — that is their action.
    runtime.outcomePreserved = this.shuttingDown && runtime.record.attentionState === "done";
    if (runtime.outcomePreserved !== true) await this.setAttention(runtime, "stopping", true);
    this.requirePty(runtime).kill("SIGTERM");
    await this.appendEvent("session.stopped", sessionId, {});
    await this.appendTranscript(sessionId, "lifecycle", "broker", "session stopped", {});
  }

  /** Force only one already-stopping session. Child sessions are deliberately untouched. */
  forceStop(sessionId: string): void {
    const runtime = this.requireRuntime(sessionId);
    if (runtime.record.exitCode !== null) return;
    if (!runtime.stopRequested) {
      throw new RegistryError("SESSION_NOT_ACTIVE", "Graceful stop must be requested before force");
    }
    this.requirePty(runtime).kill("SIGKILL");
  }

  async stopTree(sessionId: string): Promise<SessionTreeProgress> {
    const tree = this.sessionTree(sessionId);
    await this.stop(sessionId);
    await Promise.all(tree.slice(1).map((runtime) => this.stop(runtime.record.id)));
    return this.treeProgress(sessionId);
  }

  /**
   * Shutdown path: stop the sessions that still own a process.
   *
   * Threads whose process is already gone are skipped deliberately. `stop` on a finished thread is
   * the operator's explicit "mark this stopped" action and rewrites its attention state, so running
   * it across the whole fleet at shutdown rewrote every Done thread to Stopped — the finished state
   * was lost on the way out, before recovery ever got a chance to restore it.
   */
  async stopAll(): Promise<void> {
    this.shuttingDown = true;
    for (const [sessionId, runtime] of this.sessions) {
      if (runtime.record.exitCode !== null) continue;
      await this.stop(sessionId);
    }
  }

  async resume(sessionId: string): Promise<SessionRecord> {
    const runtime = this.requireRuntime(sessionId);
    if (runtime.record.executionState === "active" || runtime.record.executionState === "starting") {
      throw new RegistryError("SESSION_ALREADY_ACTIVE", "Session is already active");
    }

    // The outgoing PTY stops speaking for this session here, before anything is awaited. A kill is
    // acknowledged asynchronously, so its exit would otherwise land in the middle of the respawn
    // and tear down the session it was replaced by — rewriting executionState, dropping the new
    // controller and watchers, and queueing a launch-artifact cleanup onto the fresh resume.
    const previousPty = runtime.pty;
    delete runtime.pty;

    // An errored session's process outlived its provider session. Resuming would otherwise leave
    // that orphan running alongside the replacement, so it is killed before the respawn.
    if (runtime.record.executionState === "errored") previousPty?.kill();

    const adapter = this.requireAdapter(runtime.record.provider);
    const record = this.cloneRecord(runtime.record);
    const resumeSpec = adapter.buildResumeSpec(record);
    // A resume spec can name provider-owned artifacts (Claude's payload files) that the previous
    // exit removed, so wait for any in-flight cleanup and then rebuild them before the spawn.
    await runtime.launchTail;
    const pty = await this.resumePty(runtime, adapter, record, resumeSpec, previousPty);
    runtime.stopRequested = false;
    delete runtime.stopRequestedAt;
    delete runtime.controller;
    runtime.watchers.clear();
    runtime.record.pid = pty.pid;
    runtime.record.generation = (runtime.record.generation ?? 1) + 1;
    runtime.record.executionState = "active";
    runtime.record.attachmentState = "detached";
    runtime.record.exitCode = null;
    runtime.record.updatedAt = new Date().toISOString();
    runtime.record.attentionState = "done";
    runtime.record.launchRecord = resolvedLaunchRecord(resumeSpec, "resume");
    runtime.activity = "unknown";
    runtime.observedWorking = false;
    runtime.fatalReported = false;
    // The limit belonged to the generation that hit it. A resumed session is a new generation with
    // its own budget, so carrying the old one forward would report a live worker as terminal for
    // the rest of its life. The journal keeps the history; the record carries current truth only.
    delete runtime.providerLimit;
    delete runtime.record.termination;
    delete runtime.stallObservation;
    if (runtime.idleTimer !== undefined) clearTimeout(runtime.idleTimer);
    delete runtime.idleTimer;
    this.adoptPty(runtime, pty);
    await this.appendEvent("session.resumed", sessionId, {
      provider: runtime.record.provider,
      model: runtime.record.model ?? null,
      pid: runtime.record.pid,
    });
    await this.appendTranscript(sessionId, "lifecycle", "broker", "session resumed", {
      pid: runtime.record.pid,
    });
    await this.persist(runtime);
    return this.cloneRecord(runtime.record);
  }

  async delete(sessionId: string, beforeDelete?: () => Promise<void>): Promise<void> {
    const runtime = this.requireRuntime(sessionId);
    if (
      runtime.record.executionState === "active"
      || runtime.record.executionState === "starting"
      || runtime.record.exitCode === null
    ) {
      throw new RegistryError("SESSION_STILL_ACTIVE", "Stop the agent before deleting its thread");
    }
    await beforeDelete?.();

    // Workers outlive an orchestrator. Detach their live parent reference before
    // removing the parent record, leaving each worker's own durable state intact.
    const children = runtime.record.childIds
      .map((childId) => this.sessions.get(childId))
      .filter((child): child is RuntimeSession => child !== undefined);
    await Promise.all(children.map(async (child) => {
      if (child.record.parentSessionId !== sessionId) return;
      delete child.record.parentSessionId;
      child.record.updatedAt = new Date().toISOString();
      await this.persist(child);
    }));

    await this.appendEvent("session.deleted", sessionId, {
      executionState: runtime.record.executionState,
    });
    await this.appendTranscript(sessionId, "lifecycle", "broker", "session deleted", {});
    if (runtime.record.parentSessionId !== undefined) {
      const parent = this.sessions.get(runtime.record.parentSessionId);
      if (parent !== undefined) {
        parent.record.childIds = parent.record.childIds.filter((childId) => childId !== sessionId);
        parent.record.updatedAt = new Date().toISOString();
        await this.persist(parent);
      }
    }
    await runtime.launchTail;
    await this.cleanupLaunchArtifacts(runtime.record, "session-deleted");
    await this.options.store?.delete(sessionId);
    this.sessions.delete(sessionId);
  }

  async rename(sessionId: string, name: string): Promise<SessionRecord> {
    const normalized = name.replace(/\s+/gu, " ").trim();
    if (normalized === "") throw new Error("Thread name cannot be empty");
    const runtime = this.requireRuntime(sessionId);
    runtime.record.name = normalized.slice(0, 120);
    runtime.record.updatedAt = new Date().toISOString();
    await this.persist(runtime);
    return this.cloneRecord(runtime.record);
  }

  async togglePin(sessionId: string): Promise<SessionRecord> {
    const runtime = this.requireRuntime(sessionId);
    runtime.record.pinned = runtime.record.pinned !== true;
    runtime.record.updatedAt = new Date().toISOString();
    await this.persist(runtime);
    return this.cloneRecord(runtime.record);
  }

  async reorder(sessionId: string, direction: "up" | "down"): Promise<SessionRecord[]> {
    const runtime = this.requireRuntime(sessionId);
    const group = [...this.sessions.values()]
      .filter((candidate) => candidate.record.cwd === runtime.record.cwd && candidate.record.kind === runtime.record.kind)
      .sort((left, right) => this.compareDisplayOrder(left.record, right.record));
    const index = group.findIndex((candidate) => candidate.record.id === sessionId);
    const target = direction === "up" ? index - 1 : index + 1;
    if (index < 0 || target < 0 || target >= group.length) return group.map(({ record }) => this.cloneRecord(record));
    [group[index], group[target]] = [group[target]!, group[index]!];
    await Promise.all(group.map(async (candidate, displayOrder) => {
      candidate.record.displayOrder = displayOrder;
      candidate.record.updatedAt = new Date().toISOString();
      await this.persist(candidate);
    }));
    return group.map(({ record }) => this.cloneRecord(record));
  }

  /**
   * Retire finished threads that have fallen outside the retention policy.
   *
   * Only threads whose process is gone are candidates, so this frees history, never capacity. A
   * failure to retire one thread is not allowed to abort the sweep — retention is housekeeping, and
   * the next sweep will retry.
   */
  async sweepRetention(now: number = Date.now()): Promise<string[]> {
    const expired = selectExpiredThreads(this.list(), this.options.config.threadRetention, now);
    const retired: string[] = [];
    for (const sessionId of expired) {
      if (!this.sessions.has(sessionId)) continue;
      try {
        await this.delete(sessionId);
        retired.push(sessionId);
      } catch {
        // Left in place on purpose; a thread that cannot be retired now stays visible.
      }
    }
    return retired;
  }

  /**
   * Worker slots are held by *running* agents only. A finished thread is history: it owns no
   * process, and an `errored` thread owns a process that can no longer do work, so neither may
   * count against the ceiling. This is what lets the fleet view accumulate finished threads
   * without the operator stopping and deleting them to reclaim capacity.
   */
  private activeWorkerCount(): number {
    return [...this.sessions.values()].filter(({ record }) =>
      record.executionState === "active" && record.kind !== "orchestrator"
    ).length;
  }

  private compareDisplayOrder(left: SessionRecord, right: SessionRecord): number {
    if (left.pinned !== right.pinned) return left.pinned === true ? -1 : 1;
    const leftOrder = left.displayOrder ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = right.displayOrder ?? Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return (right.meaningfulUpdatedAt ?? right.updatedAt).localeCompare(left.meaningfulUpdatedAt ?? left.updatedAt);
  }

  private resolveAncestry(parentSessionId: string | undefined): SessionAncestryEntry[] {
    if (parentSessionId === undefined) return [];
    const ancestry: SessionAncestryEntry[] = [];
    let current: RuntimeSession | undefined = this.sessions.get(parentSessionId);
    if (current === undefined) {
      throw new RegistryError("SESSION_NOT_FOUND", `Parent session ${parentSessionId} was not found`);
    }
    while (current !== undefined) {
      ancestry.push({
        id: current.record.id,
        parentSessionId: current.record.parentSessionId,
      });
      const nextId: string | undefined = current.record.parentSessionId;
      current = nextId === undefined ? undefined : this.sessions.get(nextId);
    }
    return ancestry;
  }

  private requireRuntime(sessionId: string): RuntimeSession {
    const runtime = this.sessions.get(sessionId);
    if (runtime === undefined) {
      throw new RegistryError("SESSION_NOT_FOUND", `Session ${sessionId} was not found`);
    }
    return runtime;
  }

  private requireActiveParent(parentSessionId: string | undefined): void {
    if (parentSessionId === undefined) return;
    const parent = this.requireRuntime(parentSessionId);
    if (parent.record.executionState !== "active" || parent.stopRequested) {
      throw new RegistryError(
        "PARENT_SESSION_NOT_ACTIVE",
        `Parent session ${parentSessionId} is not active`,
      );
    }
  }

  private sessionTree(sessionId: string): RuntimeSession[] {
    const root = this.requireRuntime(sessionId);
    const ordered: RuntimeSession[] = [];
    const visited = new Set<string>();
    const visit = (runtime: RuntimeSession) => {
      if (visited.has(runtime.record.id)) return;
      visited.add(runtime.record.id);
      ordered.push(runtime);
      for (const childId of runtime.record.childIds) {
        const child = this.sessions.get(childId);
        if (child !== undefined) visit(child);
      }
    };
    visit(root);
    return ordered;
  }

  private treeProgress(sessionId: string): SessionTreeProgress {
    return this.progressForTree(this.sessionTree(sessionId));
  }

  private progressForTree(tree: readonly RuntimeSession[]): SessionTreeProgress {
    const root = tree[0]!;
    const terminal = tree.filter(({ record }) => record.exitCode !== null).length;
    const active = tree.filter(({ record }) =>
      record.executionState === "active" || record.executionState === "starting").length;
    return {
      rootSessionId: root.record.id,
      rootKind: root.record.kind ?? "worker",
      childCount: tree.length - 1,
      total: tree.length,
      active,
      stopping: tree.length - active - terminal,
      terminal,
    };
  }

  private requireAdapter(provider: string): ProviderAdapter {
    const adapter = this.options.adapters[provider];
    if (adapter === undefined) {
      throw new RegistryError(
        "PROVIDER_NOT_REGISTERED",
        `Provider ${provider} is not registered for interactive sessions`,
      );
    }
    return adapter;
  }

  private updateAttachmentState(runtime: RuntimeSession): void {
    runtime.record.attachmentState = runtime.controller !== undefined
      ? "controlled"
      : runtime.watchers.size > 0
        ? "watched"
        : "detached";
    runtime.record.updatedAt = new Date().toISOString();
  }

  private broadcast(runtime: RuntimeSession, chunk: Buffer): void {
    runtime.record.updatedAt = new Date().toISOString();
    const pty = runtime.pty;
    if (pty === undefined) return;
    const replay = pty.snapshot().toString("utf8");
    if (runtime.record.scout?.transport === "headless-stream-json") {
      this.appendScoutTrace(runtime, chunk);
      this.captureScoutReport(runtime, replay);
      runtime.controller?.output(chunk);
      for (const watcher of runtime.watchers.values()) watcher.output(chunk);
      this.notifySessionUpdate(runtime.record.id);
      return;
    }
    this.captureScoutReport(runtime, replay);
    if (this.observeFatalError(runtime, replay)) {
      // The bytes still reach anyone attached — the operator should be able to read the fault —
      // but no activity is derived from them. A dead session has no activity to derive.
      const controller = runtime.controller;
      const watchers = [...runtime.watchers.values()];
      controller?.output(chunk);
      for (const watcher of watchers) watcher.output(chunk);
      delete runtime.controller;
      runtime.watchers.clear();
      this.updateAttachmentState(runtime);
      const failure = {
        code: "SESSION_ERRORED",
        message: runtime.latestResult ?? "Provider session failed",
      };
      controller?.failed(failure);
      for (const watcher of watchers) watcher.failed(failure);
      void this.persist(runtime).catch(() => undefined);
      this.notifySessionUpdate(runtime.record.id);
      return;
    }
    const activity = providerTerminalActivity(runtime.record.provider, replay);
    if (activity === "working") {
      runtime.observedWorking = true;
      if (runtime.idleTimer !== undefined) clearTimeout(runtime.idleTimer);
      delete runtime.idleTimer;
      if (runtime.record.attentionState !== "working") {
        void this.setAttention(runtime, "working", false);
      }
    }
    runtime.activity = activity;
    this.observeComposer(runtime, replay);
    // The provider left the composer and started a turn: the only evidence that a payload the broker
    // wrote was actually consumed. Nothing about the write itself is admissible here.
    if (activity === "working" && !runtime.composer.occupied) {
      this.advanceRenderedInstructions(runtime, "submitted");
      this.advanceRenderedInstructions(runtime, "acknowledged");
    }
    this.notifyDeliveryBoundary(runtime);
    if (runtime.suppressSemanticTurns === true) {
      runtime.controller?.output(chunk);
      for (const watcher of runtime.watchers.values()) watcher.output(chunk);
      this.notifySessionUpdate(runtime.record.id);
      return;
    }
    this.updateStallObservation(runtime, replay);
    if (activity === "awaiting-input" && runtime.observedWorking) {
      if (runtime.idleTimer !== undefined) clearTimeout(runtime.idleTimer);
      runtime.idleTimer = setTimeout(() => {
        delete runtime.idleTimer;
        if (runtime.activity !== "awaiting-input" || !runtime.observedWorking) return;
        const completedReplay = runtime.pty?.snapshot().toString("utf8") ?? replay;
        // A composer holding text the provider never took is not a finished turn. Counting it is how
        // an unsent instruction came to satisfy the very wait that was asking whether it had run.
        if (this.observeComposer(runtime, completedReplay).occupied) {
          this.notifySessionUpdate(runtime.record.id);
          return;
        }
        runtime.completedTurns += 1;
        runtime.observedWorking = false;
        // The turn that owned the next ordinal has banked it. Anything held for that reason can go
        // now, and this is the only announcement it will get: a provider that has finished and is
        // sitting at its prompt emits nothing more to trigger one.
        this.notifyDeliveryBoundary(runtime);
        void this.completeSemanticTurn(runtime, completedReplay);
      }, 200);
    } else if (activity === "needs-input") {
      runtime.latestResult = compactTerminalResult(replay);
      if (runtime.record.attentionState !== "needs-input") {
        void this.setAttention(runtime, "needs-input", true);
        // A blocked session has no completed turn, so the transcript is the only place the last
        // real reply exists. Read it off the broadcast path, once per transition into the state.
        void this.refreshPreview(runtime, replay, []).catch(() => undefined);
        // A session can sit blocked for a long time after a model switch, so this transition is the
        // other place the running model is worth re-reading.
        void this.refreshObservedModel(runtime).catch(() => undefined);
      }
    }
    runtime.controller?.output(chunk);
    for (const watcher of runtime.watchers.values()) {
      watcher.output(chunk);
    }
    this.notifySessionUpdate(runtime.record.id);
  }

  /**
   * Detect a session that has died inside a process that is still running, and move it to a
   * terminal state.
   *
   * Liveness used to be inferred from the PTY being open, which is not evidence of anything: a
   * worker killed by an unrecoverable API 4xx keeps its process, so it reported `active` with a
   * null exit code, consumed a worker slot forever, and could even show `needs-input` — inviting
   * the operator to type at a session that can never read it again. The verdict comes from the
   * session's last result instead.
   */
  private observeFatalError(runtime: RuntimeSession, replay: string): boolean {
    if (runtime.record.executionState === "errored") return true;
    if (runtime.fatalReported || runtime.record.executionState !== "active") return false;
    // A limit the provider set for itself is read first. It is terminal for the same reason a fault
    // is — nothing more will run — but "hit the session cap" and "prompt too long" name a remedy,
    // and the generic 4xx pattern below would otherwise swallow both into "rejected the request".
    const limit = detectProviderLimitTermination(replay);
    const fault = limit === undefined ? detectSessionFatalError(replay) : undefined;
    const at = new Date().toISOString();
    const termination: SessionTermination | undefined = limit !== undefined
      ? { kind: limit.kind, reason: limit.reason, detail: limit.detail, at }
      : fault === undefined
        ? undefined
        : { kind: "provider-fault", reason: fault.reason, detail: fault.detail, at };
    if (termination === undefined) return false;
    if (limit !== undefined) runtime.providerLimit = limit;
    runtime.record.termination = termination;

    // Whatever is still sitting in the composer will never be read now, and anything the queue was
    // holding for a safe boundary has run out of boundaries.
    this.advanceRenderedInstructions(runtime, "undelivered");
    this.releaseDeliveryHolds(runtime);
    runtime.fatalReported = true;
    if (runtime.idleTimer !== undefined) clearTimeout(runtime.idleTimer);
    delete runtime.idleTimer;
    runtime.activity = "unknown";
    runtime.observedWorking = false;
    runtime.latestResult = termination.detail;
    // exitCode stays null on purpose: the process is still there, and deleting the thread must
    // still require stopping it. Only the slot and the "can accept input" claim are released.
    runtime.record.executionState = "errored";
    void this.appendEvent("session.errored", runtime.record.id, {
      reason: termination.reason,
      detail: termination.detail,
      kind: termination.kind,
      pid: runtime.record.pid,
    }).catch(() => undefined);
    void this.appendTranscript(runtime.record.id, "lifecycle", "broker", "session errored", {
      reason: termination.reason,
      detail: termination.detail,
      kind: termination.kind,
    }).catch(() => undefined);
    void this.setAttention(runtime, "failed", true).catch(() => undefined);
    return true;
  }

  private handleExit(runtime: RuntimeSession, exitCode: number, signal?: number): void {
    if (runtime.idleTimer !== undefined) clearTimeout(runtime.idleTimer);
    delete runtime.idleTimer;
    if (runtime.scoutBudgetTimer !== undefined) clearTimeout(runtime.scoutBudgetTimer);
    delete runtime.scoutBudgetTimer;
    runtime.scoutBudgetActive = false;
    const scoutTerminal = runtime.record.scout?.terminalState;
    runtime.record.executionState = scoutTerminal === "complete"
      ? "exited"
      : scoutTerminal === "budget_exhausted"
        ? "cancelled"
        : runtime.stopRequested
          ? "cancelled"
          : scoutTerminal === "failed"
            ? "failed"
            : exitCode === 0
              ? "exited"
              : "failed";
    runtime.record.exitCode = exitCode;
    // Anything still sitting in the composer died with the process. Saying so is the difference
    // between an orchestrator retrying an instruction and one waiting forever on a turn that can
    // no longer happen.
    this.advanceRenderedInstructions(runtime, "undelivered");
    this.releaseDeliveryHolds(runtime);
    const controller = runtime.controller;
    const watchers = [...runtime.watchers.values()];
    delete runtime.controller;
    runtime.watchers.clear();
    runtime.record.attachmentState = "detached";
    runtime.record.updatedAt = new Date().toISOString();
    runtime.record.attentionState = scoutTerminal === "complete"
      ? "done"
      : scoutTerminal === "budget_exhausted"
        ? "stopped"
        : runtime.stopRequested
          ? (runtime.outcomePreserved === true ? "done" : "stopped")
          : scoutTerminal === "failed"
            ? "failed"
            : exitCode === 0
              ? "done"
              : "failed";
    runtime.record.meaningfulUpdatedAt = runtime.record.updatedAt;
    controller?.ended(exitCode);
    for (const watcher of watchers) watcher.ended(exitCode);
    void this.appendEvent("session.exited", runtime.record.id, {
      exitCode,
      signal: signal ?? null,
    });
    void this.appendTranscript(runtime.record.id, "lifecycle", "broker", "session exited", {
      exitCode,
      signal: signal ?? null,
    }).catch(() => undefined);
    // A thread reaching a terminal state is the moment the retained set can grow, so it is also
    // the moment to check whether the oldest history has fallen out of the retention policy.
    void this.persist(runtime).then(() => this.sweepRetention()).catch(() => undefined);
    // The provider process is gone, so its launch artifacts are no longer referenced by anything.
    // A resume rebuilds them from the record; keeping them alive here would only widen the window
    // in which a private payload file sits on disk.
    runtime.launchTail = runtime.launchTail
      .then(() => this.cleanupLaunchArtifacts(runtime.record, "session-exited"))
      .catch(() => undefined);
    this.notifySessionUpdate(runtime.record.id);
  }

  private async finalizeHeadlessScout(
    runtime: RuntimeSession,
    exitCode: number,
    signal?: number,
  ): Promise<void> {
    if (runtime.scoutFinalizing === true) return;
    runtime.scoutFinalizing = true;
    if (runtime.scoutBudgetTimer !== undefined) clearTimeout(runtime.scoutBudgetTimer);
    delete runtime.scoutBudgetTimer;
    runtime.scoutBudgetActive = false;

    const scout = runtime.record.scout;
    if (scout === undefined) {
      this.handleExit(runtime, exitCode, signal);
      return;
    }

    const replay = runtime.pty?.snapshot().toString("utf8") ?? "";
    this.captureScoutReport(runtime, replay);
    await runtime.scoutCaptureTail?.catch(() => undefined);
    await runtime.scoutTraceTail?.catch(() => undefined);

    if (runtime.scoutTraceFailure !== undefined) {
      await this.markFinalScoutFailure(
        runtime,
        "verify",
        `Durable Scout trace could not be persisted: ${runtime.scoutTraceFailure}`,
        true,
      );
      this.handleExit(runtime, exitCode, signal);
      return;
    }

    const baseline = scout.workspaceStateHash;
    if (baseline === undefined) {
      await this.markFinalScoutFailure(
        runtime,
        "verify",
        "Scout has no pre-launch workspace state baseline",
        true,
      );
      this.handleExit(runtime, exitCode, signal);
      return;
    }
    let after: string;
    try {
      after = await this.scoutWorkspaceState(runtime.record.cwd);
    } catch (error) {
      await this.markFinalScoutFailure(
        runtime,
        "verify",
        `Post-run workspace verification failed: ${errorMessage(error)}`,
        true,
      );
      this.handleExit(runtime, exitCode, signal);
      return;
    }
    if (after !== baseline) {
      await this.markFinalScoutFailure(
        runtime,
        "verify",
        "Scout changed observable repository state despite its read-only profile",
        true,
      );
      this.handleExit(runtime, exitCode, signal);
      return;
    }

    // A launch/setup failure already carries its more precise reason. Workspace immutability still
    // ran above, but it must not rewrite that failure into a successful canary.
    if (scout.terminalState === "failed") {
      this.handleExit(runtime, exitCode, signal);
      return;
    }

    const verifiedAt = new Date().toISOString();
    scout.canary = { status: "verified", verifiedAt };
    await this.appendEvent("scout.canary.verified", runtime.record.id, {
      verifiedAt,
      workspaceStateHash: baseline,
    }).catch(() => undefined);

    if (runtime.stopRequested) {
      scout.terminalState = "failed";
      await this.persist(runtime).catch(() => undefined);
      this.handleExit(runtime, exitCode, signal);
      return;
    }
    if (scout.terminalState === "budget_exhausted") {
      await this.persist(runtime).catch(() => undefined);
      this.handleExit(runtime, exitCode, signal);
      return;
    }
    if (exitCode !== 0 && runtime.scoutExpectedSuccessfulStop !== true) {
      await this.markFinalScoutFailure(
        runtime,
        "execute",
        `Cursor Scout exited with code ${exitCode}`,
        false,
      );
      this.handleExit(runtime, exitCode, signal);
      return;
    }

    const captured = await this.requireScoutReports().collect(scout).catch((error) => ({
      state: "invalid" as const,
      text: "",
      reason: errorMessage(error),
    }));
    await this.applyScoutCapture(runtime, captured);
    if (captured.state !== "complete" || !("card" in captured)) {
      const detail = captured.state === "invalid"
        ? captured.reason
        : `result state is ${captured.state}`;
      await this.markFinalScoutFailure(
        runtime,
        "execute",
        `Cursor Scout did not produce a valid decision card: ${detail}`,
        false,
      );
      this.handleExit(runtime, exitCode, signal);
      return;
    }

    scout.terminalState = "complete";
    runtime.scoutCard = captured.card;
    runtime.latestResult = captured.text;
    runtime.record.latestPreview = captured.card.finding.slice(0, PREVIEW_STORAGE_LIMIT);
    runtime.completedTurns = Math.max(runtime.completedTurns, 1);
    this.recordCompletion(runtime, 1, captured.text);
    runtime.record.attentionState = "done";
    runtime.record.updatedAt = new Date().toISOString();
    runtime.record.meaningfulUpdatedAt = runtime.record.updatedAt;
    await this.appendEvent("scout.report.captured", runtime.record.id, {
      reportPath: scout.reportPath,
      evidencePath: scout.evidencePath ?? null,
      tracePath: scout.tracePath ?? null,
      verdict: captured.card.verdict,
      basis: captured.card.basis,
    }).catch(() => undefined);
    await this.persist(runtime).catch(() => undefined);
    this.handleExit(runtime, exitCode, signal);
  }

  private async markFinalScoutFailure(
    runtime: RuntimeSession,
    phase: "execute" | "verify",
    message: string,
    canaryFailed: boolean,
  ): Promise<void> {
    const scout = runtime.record.scout;
    if (scout === undefined) return;
    const failedAt = new Date().toISOString();
    scout.terminalState = "failed";
    scout.launchFailure = { phase, failedAt, message };
    if (canaryFailed) {
      scout.canary = { status: "failed", failedAt, reason: message };
      await this.appendEvent("scout.canary.failed", runtime.record.id, {
        phase,
        message,
      }).catch(() => undefined);
    }
    runtime.latestResult = `Scout failed during ${phase}: ${message}`;
    runtime.record.latestPreview = runtime.latestResult.slice(0, PREVIEW_STORAGE_LIMIT);
    runtime.record.executionState = "failed";
    runtime.record.attentionState = "failed";
    runtime.record.updatedAt = failedAt;
    runtime.record.meaningfulUpdatedAt = failedAt;
    await this.appendEvent("scout.run.failed", runtime.record.id, {
      phase,
      message,
      reportPath: scout.reportPath,
    }).catch(() => undefined);
    await this.appendTranscript(
      runtime.record.id,
      "lifecycle",
      "broker",
      "Scout failed",
      { phase, message },
    ).catch(() => undefined);
    await this.persist(runtime).catch(() => undefined);
    this.notifySessionUpdate(runtime.record.id);
  }

  /**
   * Bind a PTY's callbacks to that PTY, not merely to the session it currently drives.
   *
   * A session outlives its processes: a resume replaces the handle, and the outgoing one keeps
   * reporting output and its exit long after it has stopped representing the session. Every
   * callback therefore checks that it is still the adopted handle before it is allowed to touch
   * shared state.
   */
  private adoptPty(runtime: RuntimeSession, pty: PtyHandle): void {
    runtime.pty = pty;
    pty.onOutput((chunk) => {
      if (runtime.pty !== pty) return;
      this.broadcast(runtime, chunk);
    });
    pty.onExit((exitCode, signal) => {
      if (runtime.pty !== pty) return;
      if (runtime.record.scout?.transport === "headless-stream-json") {
        void this.finalizeHeadlessScout(runtime, exitCode, signal);
      } else {
        this.handleExit(runtime, exitCode, signal);
      }
    });
  }

  /**
   * Spawn the replacement PTY for a resume, restoring the outgoing handle if the spawn fails.
   *
   * `resume` releases the old handle up front so its exit cannot land on the new session. When no
   * new handle arrives, the session is left exactly as the resume found it, so an operator can
   * still stop the process the failed resume did not replace.
   */
  private async resumePty(
    runtime: RuntimeSession,
    adapter: ProviderAdapter,
    record: SessionRecord,
    spec: ProviderLaunchSpec,
    previousPty: PtyHandle | undefined,
  ): Promise<PtyHandle> {
    try {
      return await this.spawnPreparedLaunch(adapter, record, spec);
    } catch (error) {
      if (runtime.pty === undefined && previousPty !== undefined) runtime.pty = previousPty;
      throw error;
    }
  }

  /**
   * Provider launch artifacts belong to the prepared launch until a live PTY takes them over, so
   * any failure before that hand-off has to remove them itself — nothing downstream will.
   */
  private async spawnPreparedLaunch(
    adapter: ProviderAdapter,
    record: SessionRecord,
    spec: ProviderLaunchSpec,
    beforeSpawn?: () => Promise<void>,
    onPhase?: (phase: "prepare" | "spawn") => void,
  ): Promise<PtyHandle> {
    try {
      onPhase?.("prepare");
      if (adapter.prepareLaunch !== undefined) await adapter.prepareLaunch(record, spec);
      await beforeSpawn?.();
      const replayBytes = record.profile === "scout"
        ? Math.max(this.options.config.replayBytes, MIN_SCOUT_REPLAY_BYTES)
        : this.options.config.replayBytes;
      onPhase?.("spawn");
      return this.options.ptyFactory(spec, replayBytes);
    } catch (error) {
      await this.cleanupLaunchArtifacts(record, "launch-failed");
      throw error;
    }
  }

  /**
   * Cleanup is deliberately non-throwing: it runs on exit, delete, and failed-launch paths, and a
   * failure to remove one artifact must be recorded rather than raised so it can never mask the
   * primary outcome that triggered it.
   */
  private async cleanupLaunchArtifacts(record: SessionRecord, reason: string): Promise<void> {
    const cleanupFailures: string[] = [];
    const adapter = this.options.adapters[record.provider];
    if (adapter?.cleanupLaunch !== undefined) {
      try {
        await adapter.cleanupLaunch(record);
      } catch (error) {
        cleanupFailures.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (
      record.profile === "scout"
      && reason === "session-deleted"
      && this.options.scoutReports !== undefined
    ) {
      try {
        await this.options.scoutReports.remove(record.id);
      } catch (error) {
        cleanupFailures.push(error instanceof Error ? error.message : String(error));
      }
    }
    for (const message of cleanupFailures) {
      await this.appendTranscript(
        record.id,
        "lifecycle",
        "broker",
        "provider launch artifact cleanup failed",
        { reason, message },
      ).catch(() => undefined);
    }
  }

  private async registerSession(runtime: RuntimeSession): Promise<void> {
    const record = runtime.record;
    await this.persist(runtime);
    if (record.parentSessionId !== undefined) {
      const parent = this.requireRuntime(record.parentSessionId);
      if (!parent.record.childIds.includes(record.id)) {
        parent.record.childIds.push(record.id);
        parent.record.updatedAt = new Date().toISOString();
        await this.persist(parent);
      }
    }
    await this.appendEvent("session.created", record.id, {
      provider: record.provider,
      model: record.model ?? null,
      role: record.role ?? null,
      parentSessionId: record.parentSessionId ?? null,
      pid: record.pid,
      executionState: record.executionState,
    });
    await this.appendTranscript(record.id, "lifecycle", "broker", "session created", {
      provider: record.provider,
      model: record.model ?? null,
      executionState: record.executionState,
    });
  }

  private async preserveFailedScoutLaunch(
    record: SessionRecord,
    phase: NonNullable<ScoutRuntimeState["launchFailure"]>["phase"],
    error: unknown,
    launchSpec?: ProviderLaunchSpec,
  ): Promise<void> {
    const scout = record.scout;
    if (scout === undefined) return;
    const failedAt = new Date().toISOString();
    const message = errorMessage(error);
    scout.canary = { status: "failed", failedAt, reason: message };
    scout.terminalState = "failed";
    scout.launchFailure = { phase, failedAt, message };
    record.executionState = "failed";
    record.attentionState = "failed";
    record.pid = 0;
    record.exitCode = 1;
    record.updatedAt = failedAt;
    record.meaningfulUpdatedAt = failedAt;
    record.latestPreview = `Scout launch failed during ${phase}: ${message}`.slice(
      0,
      PREVIEW_STORAGE_LIMIT,
    );
    if (launchSpec !== undefined) {
      record.launchRecord = resolvedLaunchRecord(launchSpec, "launch");
    }
    const runtime: RuntimeSession = {
      record,
      watchers: new Map(),
      stopRequested: false,
      activity: "unknown",
      observedWorking: false,
      ...freshTruthState(),
      latestResult: record.latestPreview,
      fatalReported: false,
      completions: new Map(),
      launchTail: Promise.resolve(),
    };
    this.sessions.set(record.id, runtime);
    await this.registerSession(runtime).catch(() => this.persist(runtime).catch(() => undefined));
    await this.appendEvent("scout.launch.failed", record.id, {
      phase,
      message,
      reportPath: scout.reportPath,
    }).catch(() => undefined);
    await this.appendEvent("scout.canary.failed", record.id, {
      phase,
      message,
    }).catch(() => undefined);
    await this.appendTranscript(
      record.id,
      "lifecycle",
      "broker",
      "Scout launch failed",
      { phase, message },
    ).catch(() => undefined);
    this.notifySessionUpdate(record.id);
  }

  private async failLiveScout(
    runtime: RuntimeSession,
    phase: NonNullable<ScoutRuntimeState["launchFailure"]>["phase"],
    error: unknown,
  ): Promise<void> {
    const scout = runtime.record.scout;
    if (scout === undefined) return;
    if (runtime.scoutBudgetTimer !== undefined) clearTimeout(runtime.scoutBudgetTimer);
    delete runtime.scoutBudgetTimer;
    runtime.scoutBudgetActive = false;
    const failedAt = new Date().toISOString();
    const message = errorMessage(error);
    scout.canary = { status: "failed", failedAt, reason: message };
    scout.terminalState = "failed";
    scout.launchFailure = { phase, failedAt, message };
    runtime.latestResult = `Scout failed during ${phase}: ${message}`;
    runtime.record.latestPreview = runtime.latestResult.slice(0, PREVIEW_STORAGE_LIMIT);
    runtime.record.executionState = "failed";
    runtime.record.attentionState = "failed";
    runtime.record.updatedAt = failedAt;
    runtime.record.meaningfulUpdatedAt = failedAt;
    await this.appendEvent("scout.launch.failed", runtime.record.id, {
      phase,
      message,
      reportPath: scout.reportPath,
    }).catch(() => undefined);
    await this.appendEvent("scout.canary.failed", runtime.record.id, {
      phase,
      message,
    }).catch(() => undefined);
    await this.appendTranscript(
      runtime.record.id,
      "lifecycle",
      "broker",
      "Scout failed",
      { phase, message },
    ).catch(() => undefined);
    await this.persist(runtime).catch(() => undefined);
    this.notifySessionUpdate(runtime.record.id);
    runtime.pty?.kill("SIGTERM");
  }

  private scoutLaunchError(sessionId: string, error: unknown): RegistryError {
    return new RegistryError(
      "SCOUT_LAUNCH_FAILED",
      `Scout ${sessionId} failed to launch: ${errorMessage(error)}`,
      sessionId,
    );
  }

  private workerResultSnapshot(target: WorkerWaitTarget, maxResultChars: number): WorkerResultSnapshot {
    const runtime = this.requireRuntime(target.sessionId);
    const replay = runtime.pty?.snapshot().toString("utf8") ?? runtime.record.latestPreview ?? "";
    // A recorded completion wins over live runtime state: once the target turn is in the ledger its
    // text is fixed, so a later turn cannot overwrite the answer this wait was asked for.
    const recorded = runtime.completions.get(target.completionTarget);
    const scoutTerminal = runtime.record.scout?.terminalState;
    const result = recorded?.text
      ?? (runtime.record.profile === "scout"
        ? scoutTerminal === "failed" || scoutTerminal === "budget_exhausted"
          ? runtime.latestResult
            ?? runtime.record.latestPreview
            ?? `Scout ${scoutTerminal}`
          : runtime.record.executionState === "active"
              || runtime.record.executionState === "starting"
            ? `Scout running · result ${runtime.record.scout?.reportState ?? "missing"} · raw provider stream retained in trace artifact`
            : `Scout ${runtime.record.executionState} without a verified decision card`
        : runtime.latestResult === undefined
          ? compactTerminalResult(replay, maxResultChars)
          : runtime.latestResult);
    const text = truncateResult(result, maxResultChars);
    const base = {
      sessionId: runtime.record.id,
      ...(runtime.record.name === undefined ? {} : { name: runtime.record.name }),
      provider: runtime.record.provider,
      ...(runtime.record.model === undefined ? {} : { model: runtime.record.model }),
      ...(runtime.record.effort === undefined ? {} : { effort: runtime.record.effort }),
      ...(runtime.record.profile === undefined ? {} : { profile: runtime.record.profile }),
      ...(runtime.record.effectiveState === undefined
        ? {}
        : { effectiveState: { ...runtime.record.effectiveState } }),
      ...(runtime.record.scout === undefined
        ? {}
        : {
            reportPath: runtime.record.scout.reportPath,
            reportState: runtime.record.scout.reportState,
            ...(runtime.record.scout.terminalState === undefined
              ? {}
              : { terminalState: runtime.record.scout.terminalState }),
          }),
      completedTurns: runtime.completedTurns,
      text,
      truth: this.projectTruth(runtime, replay),
      ...(recorded === undefined ? {} : { provenance: recorded.provenance }),
      ...(runtime.providerLimit === undefined ? {} : { providerLimit: runtime.providerLimit }),
    };
    if (runtime.scoutBudgetExhausting === true) {
      return { ...base, status: "working" };
    }
    if (
      runtime.record.scout?.terminalState === "budget_exhausted"
      && runtime.record.exitCode === null
    ) {
      return { ...base, status: "working" };
    }
    if (runtime.record.scout?.terminalState === "budget_exhausted") {
      return { ...base, status: "budget_exhausted" };
    }
    // `completionTarget` is an ordinal, not an identity, so a target the worker passed before its
    // newest instruction was written must not settle: the ledger slot it names was filled by a turn
    // that predates the question this wait is asking. A slot that has already been handed to a
    // caller is exempt — re-asking for a result you were given is a replay, not a stale settle, and
    // that replay is how an orchestrator proves the work already ran.
    const alreadyDelivered = (recorded?.deliveries ?? 0) > 0;
    if (
      runtime.completedTurns >= target.completionTarget
      && (alreadyDelivered || target.completionTarget > runtime.turnsBeforeLatestInstruction)
    ) {
      return {
        ...base,
        status: "completed",
        ...(recorded === undefined ? {} : { completedAt: recorded.completedAt }),
      };
    }
    if (runtime.providerLimit !== undefined) {
      return { ...base, status: "provider-limit", providerLimit: runtime.providerLimit };
    }
    if (runtime.activity === "needs-input") return { ...base, status: "needs-input" };
    if (runtime.record.executionState === "failed") return { ...base, status: "failed" };
    if (runtime.record.executionState === "cancelled") return { ...base, status: "stopped" };
    if (runtime.record.executionState === "exited") return { ...base, status: "exited" };
    if (runtime.activity === "working") return { ...base, status: "working" };
    const stalled = this.stalledWorker(runtime, replay);
    if (stalled !== undefined) {
      return {
        ...base,
        status: "stalled",
        stalledForSeconds: stalled.stalledForSeconds,
        stallReason: "transcript-and-token-count-unchanged-while-idle",
        tokenCount: stalled.tokenCount,
      };
    }
    return { ...base, status: "waiting" };
  }

  private updateStallObservation(runtime: RuntimeSession, replay: string): void {
    const tokenCount = terminalTokenCount(replay);
    if (tokenCount === undefined) {
      delete runtime.stallObservation;
      return;
    }
    const previous = runtime.stallObservation;
    if (
      previous === undefined
      || previous.replay !== replay
      || previous.tokenCount !== tokenCount
    ) {
      runtime.stallObservation = {
        replay,
        tokenCount,
        unchangedSinceMs: this.now(),
      };
    }
  }

  private stalledWorker(
    runtime: RuntimeSession,
    replay: string,
  ): { stalledForSeconds: number; tokenCount: number } | undefined {
    this.updateStallObservation(runtime, replay);
    const observation = runtime.stallObservation;
    if (
      observation === undefined
      || runtime.record.executionState !== "active"
      || runtime.activity === "working"
      || runtime.activity === "needs-input"
    ) {
      return undefined;
    }
    const stalledForSeconds = Math.floor((this.now() - observation.unchangedSinceMs) / 1_000);
    if (stalledForSeconds < this.options.config.workerStallSeconds) return undefined;
    return { stalledForSeconds, tokenCount: observation.tokenCount };
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private scoutWorkspaceState(cwd: string): Promise<string> {
    const existing = this.scoutWorkspaceStateInflight.get(cwd);
    if (existing !== undefined) return existing;
    const capture = this.options.scoutWorkspaceState ?? captureScoutWorkspaceStateHash;
    const pending = capture(cwd).finally(() => {
      if (this.scoutWorkspaceStateInflight.get(cwd) === pending) {
        this.scoutWorkspaceStateInflight.delete(cwd);
      }
    });
    this.scoutWorkspaceStateInflight.set(cwd, pending);
    return pending;
  }

  /**
   * Stamps the results a wait is about to hand back. Marking happens here rather than in the
   * snapshot helper because a wait probes the snapshot on every session update; only the batch that
   * actually reaches the caller counts as a delivery.
   */
  private deliver(
    targets: readonly WorkerWaitTarget[],
    results: WorkerResultSnapshot[],
  ): WorkerResultSnapshot[] {
    return results.map((result, index) => {
      const target = targets[index];
      if (result.status !== "completed" || target === undefined) return result;
      const runtime = this.sessions.get(target.sessionId);
      if (runtime === undefined) return result;
      // A completion the semantic-turn path never recorded (an exit that raced the ledger, a
      // recovered session) is admitted on first delivery so replays stay stable from here on.
      const entry = runtime.completions.get(target.completionTarget)
        ?? this.recordCompletion(runtime, target.completionTarget, result.text);
      entry.deliveries += 1;
      return {
        ...result,
        retrieval: entry.deliveries === 1 ? "fresh" : "replay",
        completedAt: entry.completedAt,
      };
    });
  }

  private recordCompletion(
    runtime: RuntimeSession,
    completionTarget: number,
    text: string,
    provenance: CompletionLedgerEntry["provenance"] = "terminal-replay",
  ): CompletionLedgerEntry {
    const existing = runtime.completions.get(completionTarget);
    if (existing !== undefined) return existing;
    if (provenance === "provider-transcript") runtime.canonicalTurns += 1;
    const entry: CompletionLedgerEntry = {
      text,
      completedAt: new Date().toISOString(),
      deliveries: 0,
      provenance,
    };
    runtime.completions.set(completionTarget, entry);
    while (runtime.completions.size > MAX_COMPLETION_LEDGER_ENTRIES) {
      const oldest = Math.min(...runtime.completions.keys());
      runtime.completions.delete(oldest);
    }
    return entry;
  }

  private notifySessionUpdate(sessionId: string): void {
    for (const listener of this.sessionUpdateListeners) listener(sessionId);
  }

  /**
   * Refresh what the provider's input surface is holding.
   *
   * Called from the broadcast path and from anything that is about to make a claim about the
   * worker, because a claim made from a composer reading taken minutes ago is the class of lie this
   * whole change exists to stop.
   */
  private observeComposer(runtime: RuntimeSession, replay?: string): ComposerObservation {
    const frame = replay ?? runtime.pty?.snapshot().toString("utf8");
    if (frame === undefined) return runtime.composer;
    runtime.composer = terminalComposerState(runtime.record.provider, frame, {
      modalOpen: runtime.activity === "needs-input",
    });
    return runtime.composer;
  }

  /**
   * Announce the boundary reopening, once per closure.
   *
   * Held instructions are flushed by whoever is listening; the registry deliberately does not hold
   * a queue of its own. Its job is to say when writing would be safe, not to decide what to write.
   */
  private notifyDeliveryBoundary(runtime: RuntimeSession): void {
    if (!runtime.deliveryHeld) return;
    if (this.deliveryHold(runtime) !== undefined) return;
    runtime.deliveryHeld = false;
    for (const listener of this.deliveryBoundaryListeners) listener(runtime.record.id);
  }

  /**
   * Wake the queue for a worker that just became terminal.
   *
   * The boundary this announces is not a safe one — it is the last one. Held instructions have to be
   * told something, and a re-delivery attempt against a terminal session is exactly what turns each
   * of them into `undelivered` rather than leaving them queued against a worker that is never coming
   * back.
   */
  private releaseDeliveryHolds(runtime: RuntimeSession): void {
    if (!runtime.deliveryHeld) return;
    runtime.deliveryHeld = false;
    for (const listener of this.deliveryBoundaryListeners) listener(runtime.record.id);
  }

  /**
   * Move every rendered instruction on, and tell anyone recording instruction state.
   *
   * `submitted` is only ever reached here, from an observation: the provider left the composer and
   * started a turn. Nothing about writing bytes reaches this path.
   */
  private advanceRenderedInstructions(
    runtime: RuntimeSession,
    state: InstructionLifecycleState,
    turn?: number,
  ): void {
    if (runtime.rendered.length === 0) return;
    const at = new Date().toISOString();
    const remaining: RenderedInstruction[] = [];
    for (const entry of runtime.rendered) {
      // A completion only answers the instruction whose expected turn it is. An instruction rendered
      // during turn N is not answered by turn N-1 finishing, which is exactly how a wait used to
      // settle on output older than the question it was asking.
      const applies = state !== "completed" || turn === undefined || entry.expectedTurn <= turn;
      // A turn can complete without the broker having caught the frame where the provider took the
      // payload — a fast turn between two polls. Walk the intermediate states rather than dropping
      // the completion on the floor: the instruction did reach the provider, that is what a
      // completed turn for its ordinal means.
      const path = state === "completed"
        ? (["submitted", "acknowledged", "completed"] as const)
        : ([state] as const);
      let next = entry.state;
      if (applies) for (const step of path) next = advanceInstruction(next, step);
      if (next !== entry.state) {
        entry.state = next;
        for (const listener of this.instructionStateListeners) {
          listener({
            sessionId: runtime.record.id,
            instructionId: entry.instructionId,
            state: next,
            at,
            ...(turn === undefined ? {} : { turn }),
          });
        }
      }
      if (next !== "completed" && next !== "undelivered" && next !== "cancelled") {
        remaining.push(entry);
      }
    }
    runtime.rendered = remaining;
  }

  private async completeSemanticTurn(runtime: RuntimeSession, replay: string): Promise<void> {
    // Scout completion comes only from a validated canonical drop-box report. Cursor returning to
    // input corroborates that event but cannot replace it.
    if (runtime.record.profile === "scout" && runtime.record.scout?.terminalState !== "complete") {
      runtime.completedTurns = Math.max(0, runtime.completedTurns - 1);
      runtime.latestResult = terminalFallbackResult(replay);
      await this.refreshPreview(runtime, replay, []);
      await this.setAttention(runtime, "done", true);
      this.notifySessionUpdate(runtime.record.id);
      return;
    }
    const fallback = terminalFallbackResult(replay);
    let nativeTurns: Array<{ text?: string | undefined; data?: Record<string, unknown> }> = [];
    try {
      const capture = this.options.transcripts?.captureProviderTurns;
      const attempts = runtime.record.provider === "claude" || runtime.record.provider === "codex"
        ? 4
        : 1;
      for (let attempt = 0; capture !== undefined && attempt < attempts; attempt += 1) {
        nativeTurns = await capture.call(this.options.transcripts, {
          sessionId: runtime.record.id,
          provider: runtime.record.provider,
          cwd: runtime.record.cwd,
          createdAt: runtime.record.createdAt,
          turnNumber: runtime.completedTurns,
          fallbackText: fallback,
          // A screen scrape is accepted only once the provider's own transcript has been given every
          // retry. Accepting one earlier would mark real canonical turns as replay-derived.
          allowFallback: attempt + 1 === attempts,
        });
        if (nativeTurns.length > 0) break;
        if (attempt + 1 < attempts) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
    } catch {
      // Native transcript can lag its TUI frame. Keep worker completion usable without persisting PTY bytes.
    }
    // `completedTurns` already counts the turn that just ended, so it names the last turn the
    // native transcript describes. Ledger each captured turn under the completionTarget a waiter
    // would ask for, oldest first.
    const firstTurn = runtime.completedTurns;
    if (nativeTurns.length > 1) runtime.completedTurns += nativeTurns.length - 1;
    const latest = nativeTurns.at(-1)?.text ?? fallback;
    const texts = nativeTurns.length > 0
      ? nativeTurns.map((turn) => turn.text ?? fallback)
      : [fallback];
    // Where the text came from travels with it. A worker that completed turns with nothing but
    // screen scrapes behind them is exactly the shape of the incident where two Codex workers
    // stamped identical completion seconds and `thread_read` showed no semantic turn at all. The
    // transcript store labels each turn it wrote; a fallback turn is a scrape wearing a turn's shape.
    const provenance = nativeTurns.some((turn) => turn.data?.transport === "provider-native")
      ? "provider-transcript"
      : "terminal-replay";
    texts.forEach((text, index) =>
      this.recordCompletion(runtime, firstTurn + index, text, provenance));
    // The turn that answers an instruction is the one it has been waiting for since it was written.
    this.advanceRenderedInstructions(runtime, "completed", runtime.completedTurns);
    runtime.latestResult = latest;
    await this.refreshPreview(
      runtime,
      replay,
      nativeTurns.map((turn): TranscriptMessage => ({ role: "assistant", text: turn.text ?? "" })),
    );
    await this.refreshObservedModel(runtime);
    await this.setAttention(runtime, "done", true);
    this.notifySessionUpdate(runtime.record.id);
  }

  /**
   * Store the preview the fleet renders.
   *
   * The turns just captured are the cheapest source, so they are tried first; only when they yield
   * nothing usable does this re-read the provider transcript, and only when that is also empty does
   * a pane scrape get a say. A pass that recovers nothing leaves the previous preview in place,
   * because a stale-but-real reply beats spinner debris.
   */
  private async refreshPreview(
    runtime: RuntimeSession,
    replay: string,
    captured: readonly TranscriptMessage[],
  ): Promise<void> {
    let preview = conversationPreview({ transcript: captured, maxLength: PREVIEW_STORAGE_LIMIT });
    if (preview.kind === "none") {
      const transcript = await this.readTranscriptMessages(runtime).catch(() => []);
      preview = conversationPreview({
        transcript,
        storedPreview: runtime.record.latestPreview,
        replay,
        maxLength: PREVIEW_STORAGE_LIMIT,
      });
    }
    if (preview.kind === "none" || preview.text === runtime.record.latestPreview) return;
    runtime.record.latestPreview = preview.text;
    await this.persist(runtime);
  }

  /**
   * Project the model the provider is actually running onto the session record.
   *
   * Read at the same points the preview is: a provider writes the new model into its transcript with
   * the first turn that model produces, so turn completion is the earliest moment the switch is a
   * fact rather than a guess. Unchanged observations persist nothing; a provider that keeps no
   * transcript leaves the field absent, which is what every reader renders as "launch value, not a
   * current one" instead of silently passing the launch model off as observed.
   */
  private async refreshObservedModel(runtime: RuntimeSession): Promise<void> {
    const transcripts = this.options.transcripts;
    const read = transcripts?.readObservedModel;
    if (transcripts === undefined || read === undefined) return;
    const observed = await read.call(transcripts, {
      sessionId: runtime.record.id,
      provider: runtime.record.provider,
      cwd: runtime.record.cwd,
      createdAt: runtime.record.createdAt,
      turnNumber: runtime.completedTurns,
    }).catch(() => undefined);
    if (observed === undefined) return;
    const current = runtime.record.observedModel;
    if (
      current?.model === observed.model
      && current.effort === observed.effort
    ) return;
    runtime.record.observedModel = observed;
    await this.persist(runtime);
    this.notifySessionUpdate(runtime.record.id);
  }

  private async readTranscriptMessages(runtime: RuntimeSession): Promise<TranscriptMessage[]> {
    const transcripts = this.options.transcripts;
    const read = transcripts?.readTranscriptMessages;
    if (transcripts === undefined || read === undefined) return [];
    return read.call(transcripts, {
      sessionId: runtime.record.id,
      provider: runtime.record.provider,
      cwd: runtime.record.cwd,
      createdAt: runtime.record.createdAt,
      turnNumber: runtime.completedTurns,
    });
  }

  private requirePty(runtime: RuntimeSession): PtyHandle {
    if (runtime.pty === undefined) {
      throw new RegistryError("SESSION_NOT_ACTIVE", "Session runtime is not active; resume it before use");
    }
    return runtime.pty;
  }

  private requireInteractiveInput(runtime: RuntimeSession): void {
    if (runtime.record.scout?.transport === "headless-stream-json") {
      throw new RegistryError(
        "SESSION_BUSY",
        "A headless Scout is one-shot and accepts no follow-up input; launch a new Scout probe",
      );
    }
  }

  private requireScoutReports(): NonNullable<SessionRegistryOptions["scoutReports"]> {
    if (this.options.scoutReports === undefined) {
      throw new RegistryError(
        "SCOUT_REPORT_STORE_UNAVAILABLE",
        "Scout profile requires broker-owned drop-box storage",
      );
    }
    return this.options.scoutReports;
  }

  private appendScoutTrace(runtime: RuntimeSession, chunk: Buffer): void {
    const scout = runtime.record.scout;
    const reports = this.options.scoutReports;
    if (scout === undefined || reports === undefined || chunk.length === 0) return;
    runtime.scoutTraceTail = (runtime.scoutTraceTail ?? Promise.resolve())
      .then(() => reports.appendTrace(scout, chunk))
      .catch(async (error) => {
        runtime.scoutTraceFailure = errorMessage(error);
        runtime.latestResult ??= `Scout trace persistence failed: ${runtime.scoutTraceFailure}`;
        await this.persist(runtime).catch(() => undefined);
      });
  }

  private captureScoutReport(runtime: RuntimeSession, replay: string): void {
    if (
      runtime.record.profile !== "scout"
      || runtime.record.scout === undefined
      || runtime.record.scout.terminalState === "complete"
      || runtime.record.scout.terminalState === "failed"
      || runtime.record.scout.terminalState === "budget_exhausted"
      || runtime.scoutCutoffStarted === true
      || this.options.scoutReports === undefined
    ) return;
    const scout = { ...runtime.record.scout, canary: { ...runtime.record.scout.canary } };
    const capture = this.options.scoutReports.capture.bind(this.options.scoutReports);
    runtime.scoutCaptureTail = (runtime.scoutCaptureTail ?? Promise.resolve())
      .then(async () => {
        const result = await capture(scout, replay);
        await this.applyScoutCapture(runtime, result);
      })
      .catch(async (error) => {
        if (runtime.record.scout === undefined) return;
        if (runtime.record.scout.reportState === "complete") return;
        runtime.record.scout.reportState = "invalid";
        runtime.latestResult = error instanceof Error ? error.message : String(error);
        await this.persist(runtime).catch(() => undefined);
        this.notifySessionUpdate(runtime.record.id);
      });
  }

  private async applyScoutCapture(runtime: RuntimeSession, result: ScoutReportCapture): Promise<void> {
    const scout = runtime.record.scout;
    if (scout === undefined || scout.terminalState === "complete" || result.state === "missing") return;
    const changed = scout.reportState !== result.state;
    scout.reportState = result.state;
    if ("text" in result && result.text !== "") runtime.latestResult = result.text;
    if (result.state === "complete" && "card" in result) runtime.scoutCard = result.card;
    if (scout.terminalState === "budget_exhausted") {
      if (changed) await this.persist(runtime);
      this.notifySessionUpdate(runtime.record.id);
      return;
    }
    if (changed || result.state === "complete") await this.persist(runtime);
    this.notifySessionUpdate(runtime.record.id);
    if (
      result.state === "complete"
      && "card" in result
      && runtime.scoutFinalizing !== true
      && runtime.scoutAcceptedCardStopRequested !== true
    ) {
      runtime.scoutAcceptedCardStopRequested = true;
      runtime.scoutExpectedSuccessfulStop = true;
      runtime.pty?.kill("SIGTERM");
    }
  }

  private armScoutBudget(runtime: RuntimeSession): void {
    const budget = runtime.record.brief?.budget;
    if (
      runtime.record.profile !== "scout"
      || budget === undefined
      || runtime.scoutBudgetActive === true
    ) return;
    runtime.scoutBudgetActive = true;
    runtime.scoutBudgetTimer = setTimeout(() => {
      void this.exhaustScoutBudget(runtime, "time", budget.maxWallClockMs);
    }, budget.maxWallClockMs);
    runtime.scoutBudgetTimer.unref?.();
  }

  private async exhaustScoutBudget(
    runtime: RuntimeSession,
    dimension: "time",
    observed: number,
  ): Promise<void> {
    const scout = runtime.record.scout;
    if (
      scout === undefined
      || scout.terminalState !== undefined
      || runtime.scoutBudgetExhausting === true
    ) return;
    runtime.scoutBudgetExhausting = true;
    runtime.scoutCutoffStarted = true;
    runtime.scoutBudgetActive = false;
    if (runtime.scoutBudgetTimer !== undefined) clearTimeout(runtime.scoutBudgetTimer);
    delete runtime.scoutBudgetTimer;
    await runtime.scoutCaptureTail?.catch(() => undefined);
    if (scout.reportState === "complete" && runtime.scoutCard !== undefined) {
      runtime.scoutExpectedSuccessfulStop = true;
      if (runtime.scoutAcceptedCardStopRequested !== true) {
        runtime.scoutAcceptedCardStopRequested = true;
        runtime.pty?.kill("SIGTERM");
      }
      runtime.scoutBudgetExhausting = false;
      this.notifySessionUpdate(runtime.record.id);
      return;
    }
    scout.terminalState = "budget_exhausted";
    runtime.record.executionState = "cancelled";
    runtime.record.attentionState = "stopped";
    runtime.record.updatedAt = new Date().toISOString();
    runtime.record.meaningfulUpdatedAt = runtime.record.updatedAt;
    try {
      // Persist cutoff before stopping provider. Later output cannot promote this terminal result.
      await this.persist(runtime);
      runtime.pty?.kill("SIGTERM");
      await this.appendEvent("scout.budget.exhausted", runtime.record.id, {
        dimension,
        observed,
        reportState: scout.reportState,
        reportPath: scout.reportPath,
      });
      await this.appendTranscript(
        runtime.record.id,
        "lifecycle",
        "broker",
        "Scout budget exhausted",
        { dimension, observed, reportState: scout.reportState },
      );
    } catch (error) {
      // A persistence failure must not leave an over-budget provider running indefinitely.
      runtime.pty?.kill("SIGTERM");
      throw error;
    } finally {
      runtime.scoutBudgetExhausting = false;
      this.notifySessionUpdate(runtime.record.id);
    }
  }

  private async recoverScoutReports(): Promise<void> {
    if (this.options.scoutReports === undefined) return;
    for (const runtime of this.sessions.values()) {
      const scout = runtime.record.scout;
      if (runtime.record.profile !== "scout" || scout === undefined) continue;
      const captured = await this.options.scoutReports.collect(scout).catch(() => undefined);
      if (captured === undefined || captured.state === "missing") continue;
      let changed = scout.reportState !== captured.state;
      scout.reportState = captured.state;
      if ("text" in captured) runtime.latestResult = captured.text;
      if (captured.state === "complete") {
        if ("card" in captured) runtime.scoutCard = captured.card;
        const verifiedHeadlessResult = scout.transport === "headless-stream-json"
          && scout.terminalState === "complete";
        const recoverableLegacyResult = scout.transport !== "headless-stream-json"
          && scout.terminalState !== "budget_exhausted"
          && scout.terminalState !== "failed";
        if (verifiedHeadlessResult || recoverableLegacyResult) {
          changed ||= scout.terminalState !== "complete"
            || runtime.record.executionState !== "exited"
            || runtime.record.attentionState !== "done";
          scout.terminalState = "complete";
          runtime.completedTurns = 1;
          this.recordCompletion(runtime, 1, captured.text);
          runtime.record.executionState = "exited";
          runtime.record.attentionState = "done";
          runtime.record.exitCode ??= 0;
        }
      }
      if (changed) {
        runtime.record.updatedAt = new Date().toISOString();
        runtime.record.meaningfulUpdatedAt = runtime.record.updatedAt;
        await this.persist(runtime);
      }
    }
  }

  private async setAttention(
    runtime: RuntimeSession,
    attentionState: ThreadAttentionState,
    meaningful: boolean,
  ): Promise<void> {
    const now = new Date().toISOString();
    runtime.record.attentionState = attentionState;
    runtime.record.updatedAt = now;
    if (meaningful) runtime.record.meaningfulUpdatedAt = now;
    await this.persist(runtime);
  }

  private async persist(runtime: RuntimeSession): Promise<void> {
    await this.options.store?.put(this.cloneRecord(runtime.record));
  }

  /**
   * Rebuild a durable record into a runtime one after a restart.
   *
   * The broker cannot inherit a PTY it did not spawn, so nothing that was live before the restart
   * is live now. What survives is the *outcome*: a thread whose last observed state was `done` had
   * already finished its task, and losing the process loses nothing of it — it rehydrates as a
   * finished thread. Only a thread that was mid-turn (working, needs-input, stopping) actually had
   * work cut off, and only that thread is `interrupted`. Previously every live record was recovered
   * as interrupted, which is why finished threads came back as anything but Done.
   */
  private recoverRecord(stored: SessionRecord): SessionRecord {
    const record = this.cloneRecord(stored);
    record.attachmentState = "detached";
    if (
      record.executionState === "active"
      || record.executionState === "starting"
      || record.executionState === "errored"
    ) {
      const finished = record.executionState === "active" && record.attentionState === "done";
      const errored = record.executionState === "errored";
      record.executionState = finished ? "exited" : errored ? "failed" : "cancelled";
      record.exitCode = 0;
      record.attentionState = finished ? "done" : errored ? "failed" : "interrupted";
      record.updatedAt = new Date().toISOString();
      return record;
    }
    record.attentionState ??= record.executionState === "failed"
      ? "failed"
      : record.executionState === "cancelled"
        ? "stopped"
        : "done";
    if (record.executionState === "cancelled" && record.attentionState === "stopping") {
      record.attentionState = "stopped";
    }
    return record;
  }

  private async appendTranscript(
    sessionId: string,
    kind: "prompt" | "output" | "instruction" | "lifecycle",
    source: "human" | "provider" | "orchestrator" | "worker" | "broker",
    text: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    await this.options.transcripts?.append({ sessionId, kind, source, text, data });
  }

  private async appendEvent(
    type: BrokerEventType,
    sessionId: string | undefined,
    data: Record<string, unknown>,
  ): Promise<void> {
    await this.options.journal.append({
      id: randomUUID(),
      type,
      ...(sessionId === undefined ? {} : { sessionId }),
      occurredAt: new Date().toISOString(),
      data,
    });
  }

  private cloneRecord(record: SessionRecord): SessionRecord {
    const launchRecord = cloneLaunchRecord(record.launchRecord);
    return {
      ...record,
      childIds: [...record.childIds],
      ...(record.brief === undefined
        ? {}
        : {
            brief: {
              ...record.brief,
              scope: [...record.brief.scope],
              questions: [...record.brief.questions],
              budget: { ...record.brief.budget },
            },
          }),
      ...(record.effectiveState === undefined
        ? {}
        : { effectiveState: { ...record.effectiveState } }),
      ...(record.scout === undefined
        ? {}
        : {
            scout: {
              ...record.scout,
              canary: { ...record.scout.canary },
              ...(record.scout.launchFailure === undefined
                ? {}
                : { launchFailure: { ...record.scout.launchFailure } }),
            },
          }),
      ...(launchRecord === undefined ? {} : { launchRecord }),
      ...(record.termination === undefined ? {} : { termination: { ...record.termination } }),
    };
  }
}

function cloneLaunchRecord(record: ResolvedLaunchRecord | undefined): ResolvedLaunchRecord | undefined {
  if (record === undefined) return undefined;
  return { ...record, args: [...record.args], cyberdeckEnv: { ...record.cyberdeckEnv } };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function validateSessionCwd(cwd: string): Promise<void> {
  try {
    const canonical = await realpath(cwd);
    if (!(await stat(canonical)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new RegistryError(
      "INVALID_SESSION_CWD",
      `Session cwd is not an accessible directory: ${cwd}`,
    );
  }
}
