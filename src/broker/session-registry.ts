import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import type { BrokerRuntimeConfig } from "../config.js";
import { MAX_WAIT_SECONDS } from "../limits.js";
import type { BrokerEvent, BrokerEventType } from "../domain/events.js";
import { evaluateStart, type SessionAncestryEntry, type StartPolicyCode } from "../domain/policy.js";
import type {
  SessionRuntime,
  SessionRuntimeFactory,
} from "../domain/session-runtime.js";
import {
  StartSessionRequestSchema,
  type ResolvedLaunchRecord,
  type SessionRecord,
  type StartSessionRequest,
  type ThreadAttentionState,
} from "../domain/session.js";
import type {
  ProvisionedWorktree,
  WorktreeProvisioner,
} from "../domain/worker-workspace.js";
import { imageInputRefusal, providerAttachesImagesAtLaunch } from "../providers/image-input.js";
import { resolvedLaunchRecord } from "../providers/launch-record.js";
import type {
  ProviderAdapter,
  ProviderLaunchSpec,
  ProviderSessionTerminal,
} from "../providers/provider.js";
import { applyWorkerMode } from "../providers/worker-mode.js";
import { addWorkerReportingGuidance } from "../providers/worker-reporting.js";
import type { WorkerTruth } from "../domain/worker-truth.js";
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
  ScoutReportCapture,
  ScoutReportStore,
} from "../persistence/scout-report-store.js";
import { captureScoutWorkspaceStateHash } from "../providers/cursor/workspace-state.js";
import type {
  InstructionDelivery,
  InstructionStateUpdate,
  ScoutArtifactRead,
  WorkerResultSnapshot,
  WorkerWaitResult,
  WorkerWaitTarget,
} from "../orchestration/session/session-ports.js";
import {
  WorkerTurnEngineFactory,
  type WorkerTurnAppendResult,
  type WorkerTurnEngine,
} from "../orchestration/session/worker-turn-engine.js";
import type {
  AppendWorkerTurnTranscriptEvent,
  CaptureWorkerTurns,
  WorkerTurnObservation,
  WorkerTurnObservationPort,
  WorkerTurnPreviewPort,
  WorkerTurnTranscript,
  WorkerTurnTranscriptMessage,
} from "../orchestration/session/worker-turn-ports.js";

export type {
  InstructionDelivery,
  InstructionStateUpdate,
  WorkerResultSnapshot,
  WorkerWaitResult,
  WorkerWaitTarget,
} from "../orchestration/session/session-ports.js";

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
  append(event: AppendWorkerTurnTranscriptEvent): Promise<unknown>;
  dropClaudeBinding?(sessionId: string): Promise<void>;
  observeProviderTurns?(input: CaptureWorkerTurns): Promise<WorkerTurnObservation>;
  commitProviderTurns?(observation: WorkerTurnObservation): Promise<WorkerTurnTranscript[]>;
  /** Compatibility only; WorkerTurnEngine requires the explicit observation/commit pair. */
  captureProviderTurns?(input: CaptureWorkerTurns): Promise<WorkerTurnTranscript[]>;
  readTranscriptMessages?(input: CaptureWorkerTurns): Promise<WorkerTurnTranscriptMessage[]>;
  readObservedModel?(input: CaptureWorkerTurns): Promise<SessionRecord["observedModel"] | undefined>;
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

interface RuntimeSession {
  record: SessionRecord;
  sessionRuntime?: SessionRuntime;
  turns: WorkerTurnEngine;
  controller?: Controller;
  watchers: Map<string, Watcher>;
  stopRequested: boolean;
  stopRequestedAt?: string;
  /** The stop that killed this session was a broker shutdown of an already-finished thread. */
  outcomePreserved?: boolean;
  /** Serializes provider launch-artifact work so a pending cleanup cannot delete a fresh resume. */
  launchTail: Promise<void>;
  /** Serializes framed drop-box capture so older runtime snapshots cannot overwrite newer ones. */
  scoutCaptureTail?: Promise<void>;
  /** Serializes the full provider stream into the durable trace artifact. */
  scoutTraceTail?: Promise<void>;
  scoutTraceFailure?: string;
  /** Prevents duplicate async finalization when a child process reports more than one close path. */
  scoutFinalizing?: boolean;
  /** The exact exiting runtime is settling its last durable turn before terminal publication. */
  terminalFinalizing?: boolean;
  scoutBudgetTimer?: ReturnType<typeof setTimeout>;
  scoutBudgetActive?: boolean;
  scoutBudgetExhausting?: boolean;
  scoutCutoffStarted?: boolean;
  scoutExpectedSuccessfulStop?: boolean;
  scoutAcceptedCardStopRequested?: boolean;
  scoutCard?: ScoutDecisionCard;
}

/**
 * How long an output-driven session update may sit before it is announced.
 *
 * One frame at 60 Hz. Below the threshold where an operator can see a Fleet row lag, and far above
 * the rate a streaming provider redraws its screen at — which is the point: the announcement is
 * bounded by the clock instead of by how fast a model is emitting tokens.
 */
const SESSION_UPDATE_FLUSH_MS = 16;
const PREVIEW_STORAGE_LIMIT = 600;

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
  sessionRuntimeFactory: SessionRuntimeFactory<ProviderLaunchSpec>;
  journal: JournalLike;
  transcripts?: TranscriptLike;
  workerTurnObservation: WorkerTurnObservationPort & WorkerTurnPreviewPort;
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
  /**
   * Creates the worktree for a `cyberdeck-provisioned` workspace. Absent means the broker cannot
   * provision, and a start that asks it to is refused rather than quietly downgraded to running in
   * whatever checkout the caller happened to name — silently sharing the operator's working copy is
   * the failure the mode exists to prevent.
   */
  worktreeProvisioner?: WorktreeProvisioner;
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
      | "PROVIDER_NO_IMAGE_INPUT"
      | "SCOUT_REPORT_STORE_UNAVAILABLE"
      | "SCOUT_LAUNCH_FAILED"
      | "WORKSPACE_PROVISIONER_UNAVAILABLE"
      | "WORKSPACE_PROVISION_FAILED",
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
  /** Sessions whose output has changed but whose update has not been announced yet. */
  private readonly pendingSessionUpdates = new Set<string>();
  private sessionUpdateFlush?: ReturnType<typeof setTimeout>;
  private readonly recovery: Promise<void>;
  /** Starts admitted by policy but not yet represented in `sessions`. */
  private pendingWorkerStarts = 0;
  /** Set by `stopAll` so the shutdown kill is distinguishable from an operator stop. */
  private shuttingDown = false;

  constructor(private readonly options: SessionRegistryOptions) {
    if (options.workerTurnObservation === undefined) {
      throw new TypeError("SessionRegistry requires workerTurnObservation");
    }
    const writes: Promise<void>[] = [];
    for (const stored of options.recoveredSessions ?? []) {
      const record = this.recoverRecord(stored);
      // A provider limit is the one piece of runtime truth that survives the process that observed
      // it, because the cap belongs to the account rather than to the runtime. Recovery folds `errored`
      // into `failed`, so without rehydrating this the operator is told the worker crashed when it
      // was actually told to come back at 3:00pm.
      this.sessions.set(record.id, this.createRuntimeSession(record, {
        watchers: new Map(),
        stopRequested: false,
        launchTail: Promise.resolve(),
      }));
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
    // The launch boundary is the only place that knows whether an attachment list will actually
    // become launch arguments. A provider with no flag to carry them would drop the whole list
    // without a word, so the start is refused rather than run as a text-only prompt that looks
    // like it carried an image.
    if (
      validated.imageAttachments !== undefined
      && validated.imageAttachments.length > 0
      && !providerAttachesImagesAtLaunch(validated.provider)
    ) {
      throw new RegistryError(
        "PROVIDER_NO_IMAGE_INPUT",
        imageInputRefusal(validated.provider, validated.imageAttachments.length),
      );
    }
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
    // Isolation is created here, after admission and before any provider process exists: a worktree
    // made for a start that the concurrency budget was about to refuse is litter nobody asked for,
    // and a worker that has already launched cannot be moved into one.
    let provisioned: ProvisionedWorktree | undefined;
    try {
      provisioned = await this.provisionWorkspace(parsed, id);
    } catch (error) {
      releaseReservation();
      throw error;
    }
    const provisional: SessionRecord = {
      ...parsed,
      ...(provisioned === undefined
        ? {}
        : { cwd: provisioned.workspace.worktreePath ?? parsed.cwd, workspace: provisioned.workspace }),
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
    let sessionRuntime: SessionRuntime;
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
      sessionRuntime = await this.spawnPreparedLaunch(
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
      // The worktree was made for a worker that never started, so it holds nothing and belongs to
      // nobody. `discard` still refuses to force, so anything that did land in it survives.
      if (provisioned !== undefined) {
        await this.options.worktreeProvisioner?.discard(provisioned.workspace)
          .catch(() => undefined);
      }
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
      pid: sessionRuntime.pid,
      executionState: "active",
      updatedAt: new Date().toISOString(),
      launchRecord: resolvedLaunchRecord(launchSpec, "launch"),
    };
    const runtime = this.createRuntimeSession(record, {
      sessionRuntime,
      watchers: new Map(),
      stopRequested: false,
      launchTail: Promise.resolve(),
    });
    runtime.turns.suppressTurns();
    this.sessions.set(id, runtime);
    releaseReservation();
    this.adoptSessionRuntime(runtime, sessionRuntime);

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
        snapshot: () => sessionRuntime.snapshot(),
        write: (data) => sessionRuntime.write(data),
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
          runtime.turns.latestResult ?? "Provider session exited during initialization",
        );
      }
      runtime.turns.finishInitialization();
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
          sessionRuntime.write(data);
        }
      } else {
        this.armScoutBudget(runtime);
      }
    } catch (error) {
      if (record.profile === "scout") {
        await this.failLiveScout(runtime, "initialize", error);
        throw this.scoutLaunchError(record.id, error);
      }
      runtime.turns.releaseTimers();
      if (runtime.sessionRuntime === sessionRuntime) delete runtime.sessionRuntime;
      sessionRuntime.kill();
      this.sessions.delete(id);
      await this.cleanupLaunchArtifacts(record, "initialization-failed");
      throw error;
    }

    if (record.profile !== "scout") {
      try {
        await this.registerSession(runtime);
      } catch (error) {
        sessionRuntime.kill();
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
      this.requireRuntime(target.sessionId).turns.waitResult(target.completionTarget, maxResultChars)
    );
    const isSettled = (status: WorkerResultSnapshot["status"]): boolean =>
      status !== "working" && status !== "waiting";
    // Settling is decided from statuses, not from full snapshots. Rebuilding every target's
    // snapshot on every update meant one chunk from one worker re-scanned all N workers' replays,
    // which is the fan-out MIK-87 profiled as `ArrayMap` over an accumulated structure. A snapshot
    // is built when the wait actually answers.
    const statuses = targets.map((target) =>
      this.requireRuntime(target.sessionId).turns.waitStatus(target.completionTarget));

    if (statuses.every(isSettled)) {
      return { timedOut: false, results: this.deliver(targets, snapshot()) };
    }

    return new Promise<WorkerWaitResult>((resolve) => {
      let settled = false;
      const finish = (timedOut: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.sessionUpdateListeners.delete(onUpdate);
        const results = snapshot();
        resolve({
          timedOut: timedOut && !results.every((result) => isSettled(result.status)),
          results: this.deliver(targets, results),
        });
      };
      const onUpdate = (sessionId: string) => {
        let touched = false;
        targets.forEach((target, index) => {
          if (target.sessionId !== sessionId) return;
          statuses[index] = this.requireRuntime(target.sessionId).turns.waitStatus(
            target.completionTarget,
          );
          touched = true;
        });
        if (!touched) return;
        if (statuses.every(isSettled)) finish(false);
      };
      const timer = setTimeout(() => finish(true), boundedTimeout);
      this.sessionUpdateListeners.add(onUpdate);
      // A target can settle between the reading above and the listener being attached, and nothing
      // more would arrive to notice it.
      for (const [index, target] of targets.entries()) {
        statuses[index] = this.requireRuntime(target.sessionId).turns.waitStatus(
          target.completionTarget,
        );
      }
      if (statuses.every(isSettled)) finish(false);
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
    this.requireTerminalFinalizationComplete(runtime);
    if (runtime.record.executionState !== "active") {
      throw new RegistryError("SESSION_NOT_ACTIVE", "Session is not active; resume it before attaching");
    }
    const sessionRuntime = this.requireSessionRuntime(runtime);
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
    return sessionRuntime.snapshot();
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
    this.requireTerminalFinalizationComplete(runtime);
    if (runtime.record.executionState !== "active") {
      throw new RegistryError("SESSION_NOT_ACTIVE", "Session is not active");
    }
    this.requireInteractiveInput(runtime);
    if (runtime.controller !== undefined && runtime.controller.clientId !== clientId) {
      throw new RegistryError("NOT_SESSION_CONTROLLER", "Another client controls this session");
    }
    this.requireSessionRuntime(runtime).write(data);
    await this.appendEvent("session.input", sessionId, { bytes: data.length });
  }

  async submit(sessionId: string, clientId: string | undefined, message: string): Promise<void> {
    const runtime = this.requireRuntime(sessionId);
    this.requireTerminalFinalizationComplete(runtime);
    this.requireInteractiveInput(runtime);
    const adapter = this.requireAdapter(runtime.record.provider);
    const data = adapter.submitInput?.(message) ?? Buffer.from(`${message}\n`);
    runtime.turns.resetStallObservation();
    await this.appendTranscript(sessionId, "prompt", "human", message, {});
    await this.setAttention(runtime, "working", true);
    await this.write(sessionId, clientId, data);
  }

  /**
   * Put one instruction in front of a worker, and report only what actually happened.
   *
   * The old contract wrote the payload to the runtime unconditionally and let the caller record
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
    if (runtime.record.executionState === "active" && runtime.controller !== undefined) {
      throw new RegistryError("SESSION_BUSY", "A human controller currently owns this thread");
    }
    if (runtime.record.executionState === "active") this.requireInteractiveInput(runtime);
    return runtime.turns.submitInstruction({
      message,
      encoded: () => {
        const adapter = this.requireAdapter(runtime.record.provider);
        return adapter.submitInput?.(message) ?? Buffer.from(`${message}\n`);
      },
      source,
      metadata,
      ...(instructionId === undefined ? {} : { instructionId }),
    });
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
    return this.requireRuntime(sessionId).turns.projectTruth();
  }

  resize(sessionId: string, clientId: string | undefined, cols: number, rows: number): void {
    const runtime = this.requireRuntime(sessionId);
    this.requireTerminalFinalizationComplete(runtime);
    if (runtime.record.executionState !== "active") {
      throw new RegistryError("SESSION_NOT_ACTIVE", "Session is not active");
    }
    if (runtime.controller !== undefined && runtime.controller.clientId !== clientId) {
      throw new RegistryError("NOT_SESSION_CONTROLLER", "Another client controls this session");
    }
    this.requireSessionRuntime(runtime).resize(cols, rows);
  }

  snapshot(sessionId: string): Buffer {
    return this.requireRuntime(sessionId).sessionRuntime?.snapshot() ?? Buffer.alloc(0);
  }

  ownsProcess(sessionId: string): boolean {
    return this.requireRuntime(sessionId).sessionRuntime !== undefined;
  }

  isStopRequested(sessionId: string): boolean {
    return this.requireRuntime(sessionId).stopRequested;
  }

  stopRequestedAt(sessionId: string): string | undefined {
    return this.requireRuntime(sessionId).stopRequestedAt;
  }

  async stop(sessionId: string): Promise<void> {
    const runtime = this.requireRuntime(sessionId);
    if (runtime.terminalFinalizing === true) return;
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
    this.requireSessionRuntime(runtime).kill("SIGTERM");
    await this.appendEvent("session.stopped", sessionId, {});
    await this.appendTranscript(sessionId, "lifecycle", "broker", "session stopped", {});
  }

  /** Force only one already-stopping session. Child sessions are deliberately untouched. */
  forceStop(sessionId: string): void {
    const runtime = this.requireRuntime(sessionId);
    if (runtime.terminalFinalizing === true) return;
    if (runtime.record.exitCode !== null) return;
    if (!runtime.stopRequested) {
      throw new RegistryError("SESSION_NOT_ACTIVE", "Graceful stop must be requested before force");
    }
    this.requireSessionRuntime(runtime).kill("SIGKILL");
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
    if (runtime.terminalFinalizing === true) {
      throw new RegistryError(
        "SESSION_ALREADY_ACTIVE",
        "Session exit is still finalizing its last durable turn",
      );
    }
    if (runtime.record.executionState === "active" || runtime.record.executionState === "starting") {
      throw new RegistryError("SESSION_ALREADY_ACTIVE", "Session is already active");
    }

    // The outgoing runtime stops speaking for this session here, before anything is awaited. A kill is
    // acknowledged asynchronously, so its exit would otherwise land in the middle of the respawn
    // and tear down the session it was replaced by — rewriting executionState, dropping the new
    // controller and watchers, and queueing a launch-artifact cleanup onto the fresh resume.
    const previousRuntime = runtime.sessionRuntime;
    // Freeze the outgoing runtime's raw replay while its identity is still unambiguous. The turn
    // engine's bounded visible frame is not parity with the legacy terminal fallback, and reading
    // through `runtime.sessionRuntime` after detachment could observe a replacement generation.
    const previousReplay = previousRuntime?.snapshot().toString("utf8") ?? "";
    delete runtime.sessionRuntime;
    // Detaching the process is also the synchronous generation boundary for every in-flight turn.
    // Resume is an ordinal quiescence barrier: observations and commits from the outgoing process
    // must settle, and every frozen completion reservation must have an exact durable receipt before
    // a replacement pid/generation or its input can become visible.
    const turnBarrier = runtime.turns.settleForResume(previousReplay);
    // A delayed old-process exit has not run handleExit's normal instruction cleanup yet. Retire
    // those generation-local instructions now so a later resumed receipt cannot complete them.
    runtime.turns.stopPendingInstructions();
    try {
      await turnBarrier;
    } catch (error) {
      // Indeterminate durable ownership or an unaccounted observation fails closed, but the outgoing
      // handle remains reachable so the operator can still stop or inspect the process.
      if (runtime.sessionRuntime === undefined && previousRuntime !== undefined) {
        runtime.sessionRuntime = previousRuntime;
      }
      throw error;
    }

    // An errored session's process outlived its provider session. Resuming would otherwise leave
    // that orphan running alongside the replacement, so it is killed before the respawn.
    if (runtime.record.executionState === "errored") previousRuntime?.kill();

    const adapter = this.requireAdapter(runtime.record.provider);
    const record = this.cloneRecord(runtime.record);
    const resumeSpec = adapter.buildResumeSpec(record);
    // A resume spec can name provider-owned artifacts (Claude's payload files) that the previous
    // exit removed, so wait for any in-flight cleanup and then rebuild them before the spawn.
    await runtime.launchTail;
    const sessionRuntime = await this.resumeSessionRuntime(
      runtime,
      adapter,
      record,
      resumeSpec,
      previousRuntime,
    );
    runtime.stopRequested = false;
    delete runtime.stopRequestedAt;
    delete runtime.controller;
    runtime.watchers.clear();
    runtime.record.pid = sessionRuntime.pid;
    runtime.record.generation = (runtime.record.generation ?? 1) + 1;
    runtime.record.executionState = "active";
    runtime.record.attachmentState = "detached";
    runtime.record.exitCode = null;
    runtime.record.updatedAt = new Date().toISOString();
    runtime.record.attentionState = "done";
    runtime.record.launchRecord = resolvedLaunchRecord(resumeSpec, "resume");
    runtime.turns.resetForResume();
    // The limit belonged to the generation that hit it. A resumed session is a new generation with
    // its own budget, so carrying the old one forward would report a live worker as terminal for
    // the rest of its life. The journal keeps the history; the record carries current truth only.
    delete runtime.record.termination;
    this.adoptSessionRuntime(runtime, sessionRuntime);
    // Replacing the runtime also replaces its replay. Advance every derived cursor now so a
    // silent resumed process cannot leave clients displaying the previous generation forever.
    this.notifySessionUpdate(sessionId);
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

  private createRuntimeSession(
    record: SessionRecord,
    state: Omit<RuntimeSession, "record" | "turns">,
  ): RuntimeSession {
    let runtime!: RuntimeSession;
    const turns = new WorkerTurnEngineFactory({
      observations: this.options.workerTurnObservation,
      preview: this.options.workerTurnObservation,
      ...(this.options.transcripts === undefined ? {} : { transcripts: this.options.transcripts }),
      effects: {
        hasRuntime: () => runtime.sessionRuntime !== undefined,
        snapshot: () => runtime.sessionRuntime?.snapshot().toString("utf8"),
        write: (data) => this.requireSessionRuntime(runtime).write(data),
        appendEvent: (type, data) => this.appendEvent(type, record.id, data),
        persist: () => this.persist(runtime),
        setAttention: (attentionState, meaningful) =>
          this.setAttention(runtime, attentionState, meaningful),
        notifyInstructionState: (update) => {
          for (const listener of this.instructionStateListeners) listener(update);
        },
        notifyDeliveryBoundary: () => {
          for (const listener of this.deliveryBoundaryListeners) listener(record.id);
        },
        notifySessionUpdate: () => this.notifySessionUpdate(record.id),
        scheduleSessionUpdate: () => this.scheduleSessionUpdate(record.id),
        stopRequested: () => runtime.stopRequested,
        scoutBudgetExhausting: () => runtime.scoutBudgetExhausting === true,
      },
      workerStallSeconds: this.options.config.workerStallSeconds,
      ...(this.options.now === undefined ? {} : { now: this.options.now }),
    }).create(record, this.replayBytesFor(record));
    runtime = { record, turns, ...state };
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

  /**
   * Create the worktree a `cyberdeck-provisioned` start asked for, and answer with nothing for
   * every other mode.
   *
   * This is the whole of "an orchestrator no longer shells out": the declaration reached the broker
   * as typed fields, the broker owns the one `git worktree add`, and the worker's cwd becomes the
   * worktree it never had to know how to make. Every other provisioning mode is untouched — a
   * pre-provisioned worktree is still validated and used as-is, and a worker-provisioned one still
   * gets the grants that let the worker do it itself.
   */
  private async provisionWorkspace(
    request: StartSessionRequest,
    sessionId: string,
  ): Promise<ProvisionedWorktree | undefined> {
    const workspace = request.workspace;
    if (workspace?.provisioning !== "cyberdeck-provisioned") return undefined;
    const provisioner = this.options.worktreeProvisioner;
    if (provisioner === undefined) {
      throw new RegistryError(
        "WORKSPACE_PROVISIONER_UNAVAILABLE",
        "This broker cannot provision worktrees; pre-provision one and declare provisioning "
        + "pre-provisioned",
      );
    }
    let provisioned: ProvisionedWorktree;
    try {
      provisioned = await provisioner.provision({ workspace, cwd: request.cwd, sessionId });
    } catch (error) {
      throw new RegistryError(
        "WORKSPACE_PROVISION_FAILED",
        error instanceof Error ? error.message : String(error),
      );
    }
    // Everything past this point has a worktree behind it, and throwing from here would return no
    // `ProvisionedWorktree` for the caller's discard path to act on: the start would fail leaving
    // the branch and the directory behind, and the deterministic naming means the retry that
    // follows is refused with WORKSPACE_BRANCH_EXISTS. So this failure gives the worktree back
    // itself — still non-forced, so anything that somehow landed in it survives.
    try {
      await this.appendEvent("workspace.provisioned", sessionId, {
        worktreePath: provisioned.workspace.worktreePath ?? null,
        repositoryPath: provisioned.workspace.repositoryPath ?? null,
        branch: provisioned.workspace.branch,
        baseRef: provisioned.workspace.baseRef,
        baseCommit: provisioned.baseCommit,
        warnings: provisioned.warnings,
      });
    } catch (error) {
      await provisioner.discard(provisioned.workspace).catch(() => undefined);
      throw new RegistryError(
        "WORKSPACE_PROVISION_FAILED",
        `Worktree ${provisioned.workspace.worktreePath ?? "(unnamed)"} was created and then given `
        + `back because its provisioning could not be journaled: `
        + `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return provisioned;
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
    const sessionRuntime = runtime.sessionRuntime;
    if (sessionRuntime === undefined) return;
    // The raw replay is read lazily, and by the two readers that genuinely need every byte: a
    // scout's drop-box capture and a preview refresh. Materializing it here cost a 128 KiB copy and
    // decode on every chunk of provider output, for readers that were about to look at one screen.
    const rawReplay = (): string => sessionRuntime.snapshot().toString("utf8");
    if (runtime.record.scout?.transport === "headless-stream-json") {
      runtime.turns.appendOutput(chunk, rawReplay, false);
      this.appendScoutTrace(runtime, chunk);
      this.captureScoutReport(runtime, rawReplay);
      runtime.controller?.output(chunk);
      for (const watcher of runtime.watchers.values()) watcher.output(chunk);
      this.scheduleSessionUpdate(runtime.record.id);
      return;
    }
    const turnObservation = runtime.turns.appendOutput(chunk, rawReplay);
    this.captureScoutReport(runtime, rawReplay);
    if (turnObservation.fatal) {
      this.handleFatalObservation(runtime, chunk, turnObservation);
      return;
    }
    runtime.controller?.output(chunk);
    for (const watcher of runtime.watchers.values()) {
      watcher.output(chunk);
    }
  }

  private handleFatalObservation(
    runtime: RuntimeSession,
    chunk: Buffer,
    observation: WorkerTurnAppendResult,
  ): void {
    const firstObservation = runtime.record.executionState !== "errored";
    const termination = observation.termination ?? runtime.record.termination;
    if (termination !== undefined) runtime.record.termination = termination;
    runtime.record.executionState = "errored";
    if (firstObservation && termination !== undefined) {
      // Preserve the original fatal boundary: durable bookkeeping is started, and setAttention's
      // synchronous record mutation happens, before an attached client observes the failure bytes.
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
    }
    const controller = runtime.controller;
    const watchers = [...runtime.watchers.values()];
    controller?.output(chunk);
    for (const watcher of watchers) watcher.output(chunk);
    delete runtime.controller;
    runtime.watchers.clear();
    this.updateAttachmentState(runtime);
    const failure = {
      code: "SESSION_ERRORED",
      message: runtime.turns.latestResult ?? "Provider session failed",
    };
    controller?.failed(failure);
    for (const watcher of watchers) watcher.failed(failure);
    void this.persist(runtime).catch(() => undefined);
    this.notifySessionUpdate(runtime.record.id);
  }

  private handleExit(
    runtime: RuntimeSession,
    sessionRuntime: SessionRuntime,
    exitCode: number,
    signal?: number,
  ): void {
    if (
      runtime.sessionRuntime !== sessionRuntime
      || runtime.terminalFinalizing === true
      || runtime.record.exitCode !== null
    ) return;
    // Every process exit ends the Scout's wall-clock ownership synchronously, including legacy
    // interactive-PTY Scouts that take the non-semantic branch below. A surviving timer could
    // otherwise rewrite an already-published exit as budget exhaustion and kill a dead handle.
    if (runtime.scoutBudgetTimer !== undefined) clearTimeout(runtime.scoutBudgetTimer);
    delete runtime.scoutBudgetTimer;
    runtime.scoutBudgetActive = false;
    const settlesNormalSemanticTurn = runtime.record.executionState === "active"
      && !runtime.stopRequested
      && runtime.record.profile !== "scout"
      && runtime.record.termination === undefined;
    if (!settlesNormalSemanticTurn) {
      // Fatal/provider-limit, explicit-stop, and Scout authority already chose their terminal
      // semantics. They must not reinterpret a previously frozen screen as a normal turn. A bare
      // non-zero process exit has no such semantic authority: it still settles an exact receipt
      // before the process outcome is published as failed.
      runtime.turns.releaseTimers();
      this.publishTerminalExit(runtime, sessionRuntime, exitCode, signal);
      return;
    }
    // Input closes synchronously with the exact process handle. Terminal execution/attention truth
    // stays unpublished until every turn that process could already own has a durable outcome.
    runtime.terminalFinalizing = true;
    let settlement: Promise<void> | undefined;
    try {
      settlement = runtime.turns.startTerminalFinalization(
        () => sessionRuntime.snapshot().toString("utf8"),
      );
    } catch {
      this.publishTerminalExit(runtime, sessionRuntime, exitCode, signal);
      return;
    }
    if (settlement === undefined) {
      this.publishTerminalExit(runtime, sessionRuntime, exitCode, signal);
      return;
    }
    void settlement.then(
      () => this.publishTerminalExit(runtime, sessionRuntime, exitCode, signal),
      () => this.publishTerminalExit(runtime, sessionRuntime, exitCode, signal),
    );
  }

  private publishTerminalExit(
    runtime: RuntimeSession,
    sessionRuntime: SessionRuntime,
    exitCode: number,
    signal?: number,
  ): void {
    // The identity check before handleExit's await is not enough: a stale finalizer must never tear
    // down a replacement generation or clear its input fence.
    if (runtime.sessionRuntime !== sessionRuntime) return;
    // A valid final receipt has already completed every matching instruction. Only work still left
    // in the dead process's composer becomes undelivered now.
    runtime.turns.stopPendingInstructions();
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
    // The record is terminal before either fence opens, so no input path can observe an active gap.
    runtime.turns.finishTerminalFinalization();
    delete runtime.terminalFinalizing;
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
    sessionRuntime: SessionRuntime,
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
      this.handleExit(runtime, sessionRuntime, exitCode, signal);
      return;
    }

    this.captureScoutReport(
      runtime,
      () => sessionRuntime.snapshot().toString("utf8"),
    );
    await runtime.scoutCaptureTail?.catch(() => undefined);
    await runtime.scoutTraceTail?.catch(() => undefined);

    if (runtime.scoutTraceFailure !== undefined) {
      await this.markFinalScoutFailure(
        runtime,
        "verify",
        `Durable Scout trace could not be persisted: ${runtime.scoutTraceFailure}`,
        true,
      );
      this.handleExit(runtime, sessionRuntime, exitCode, signal);
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
      this.handleExit(runtime, sessionRuntime, exitCode, signal);
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
      this.handleExit(runtime, sessionRuntime, exitCode, signal);
      return;
    }
    if (after !== baseline) {
      await this.markFinalScoutFailure(
        runtime,
        "verify",
        "Scout changed observable repository state despite its read-only profile",
        true,
      );
      this.handleExit(runtime, sessionRuntime, exitCode, signal);
      return;
    }

    // A launch/setup failure already carries its more precise reason. Workspace immutability still
    // ran above, but it must not rewrite that failure into a successful canary.
    if (scout.terminalState === "failed") {
      this.handleExit(runtime, sessionRuntime, exitCode, signal);
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
      this.handleExit(runtime, sessionRuntime, exitCode, signal);
      return;
    }
    if (scout.terminalState === "budget_exhausted") {
      await this.persist(runtime).catch(() => undefined);
      this.handleExit(runtime, sessionRuntime, exitCode, signal);
      return;
    }
    if (exitCode !== 0 && runtime.scoutExpectedSuccessfulStop !== true) {
      await this.markFinalScoutFailure(
        runtime,
        "execute",
        `Cursor Scout exited with code ${exitCode}`,
        false,
      );
      this.handleExit(runtime, sessionRuntime, exitCode, signal);
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
      this.handleExit(runtime, sessionRuntime, exitCode, signal);
      return;
    }

    scout.terminalState = "complete";
    runtime.scoutCard = captured.card;
    runtime.turns.setLatestResult(captured.text);
    runtime.record.latestPreview = captured.card.finding.slice(0, PREVIEW_STORAGE_LIMIT);
    runtime.turns.recordCompletion(1, captured.text);
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
    this.handleExit(runtime, sessionRuntime, exitCode, signal);
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
    const latestResult = `Scout failed during ${phase}: ${message}`;
    runtime.turns.setLatestResult(latestResult);
    runtime.record.latestPreview = latestResult.slice(0, PREVIEW_STORAGE_LIMIT);
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
   * Bind a runtime's callbacks to that runtime, not merely to the session it currently drives.
   *
   * A session outlives its processes: a resume replaces the handle, and the outgoing one keeps
   * reporting output and its exit long after it has stopped representing the session. Every
   * callback therefore checks that it is still the adopted handle before it is allowed to touch
   * shared state.
   */
  private adoptSessionRuntime(runtime: RuntimeSession, sessionRuntime: SessionRuntime): void {
    runtime.sessionRuntime = sessionRuntime;
    // A resumed session inherits whatever the new handle already replayed, and starts its reading
    // over: the old process's markers describe a process that is gone.
    runtime.turns.resetReplay(sessionRuntime.snapshot().toString("utf8"));
    sessionRuntime.onOutput((chunk) => {
      if (runtime.sessionRuntime !== sessionRuntime) return;
      this.broadcast(runtime, chunk);
    });
    sessionRuntime.onExit((exitCode, signal) => {
      if (runtime.sessionRuntime !== sessionRuntime) return;
      if (runtime.record.scout?.transport === "headless-stream-json") {
        void this.finalizeHeadlessScout(runtime, sessionRuntime, exitCode, signal);
      } else {
        this.handleExit(runtime, sessionRuntime, exitCode, signal);
      }
    });
  }

  /**
   * Spawn the replacement runtime for a resume, restoring the outgoing handle if the spawn fails.
   *
   * `resume` releases the old handle up front so its exit cannot land on the new session. When no
   * new handle arrives, the session is left exactly as the resume found it, so an operator can
   * still stop the process the failed resume did not replace.
   */
  private async resumeSessionRuntime(
    runtime: RuntimeSession,
    adapter: ProviderAdapter,
    record: SessionRecord,
    spec: ProviderLaunchSpec,
    previousRuntime: SessionRuntime | undefined,
  ): Promise<SessionRuntime> {
    try {
      return await this.spawnPreparedLaunch(adapter, record, spec);
    } catch (error) {
      if (runtime.sessionRuntime === undefined && previousRuntime !== undefined) {
        runtime.sessionRuntime = previousRuntime;
      }
      throw error;
    }
  }

  /**
   * Provider launch artifacts belong to the prepared launch until a live runtime takes them over, so
   * any failure before that hand-off has to remove them itself — nothing downstream will.
   */
  /**
   * The replay window this session runtime keeps.
   *
   * Read twice: the handle is bounded by it, and the digest ages its window title against it. Those
   * two have to be the same number — a title the replay has already forgotten must stop deciding the
   * session's activity, and a title the replay still holds must keep deciding it.
   */
  private replayBytesFor(record: SessionRecord): number {
    return record.profile === "scout"
      ? Math.max(this.options.config.replayBytes, MIN_SCOUT_REPLAY_BYTES)
      : this.options.config.replayBytes;
  }

  private async spawnPreparedLaunch(
    adapter: ProviderAdapter,
    record: SessionRecord,
    spec: ProviderLaunchSpec,
    beforeSpawn?: () => Promise<void>,
    onPhase?: (phase: "prepare" | "spawn") => void,
  ): Promise<SessionRuntime> {
    try {
      onPhase?.("prepare");
      if (adapter.prepareLaunch !== undefined) await adapter.prepareLaunch(record, spec);
      await beforeSpawn?.();
      const replayBytes = this.replayBytesFor(record);
      onPhase?.("spawn");
      return this.options.sessionRuntimeFactory(spec, replayBytes);
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
    // Deletion is the last moment anything knows this thread existed: once its record is gone from
    // the session store, no later broker startup can discover the binding it left behind. Both
    // runtime deletion paths — an operator's `session.delete` and `sweepRetention` — reach here, so
    // this is where the binding is dropped rather than accumulating a file per deleted thread.
    const transcripts = this.options.transcripts;
    if (reason === "session-deleted" && transcripts?.dropClaudeBinding !== undefined) {
      try {
        await transcripts.dropClaudeBinding.call(transcripts, record.id);
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
    const runtime = this.createRuntimeSession(record, {
      watchers: new Map(),
      stopRequested: false,
      launchTail: Promise.resolve(),
    });
    runtime.turns.setLatestResult(record.latestPreview);
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
    const latestResult = `Scout failed during ${phase}: ${message}`;
    runtime.turns.setLatestResult(latestResult);
    runtime.record.latestPreview = latestResult.slice(0, PREVIEW_STORAGE_LIMIT);
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
    runtime.sessionRuntime?.kill("SIGTERM");
  }

  private scoutLaunchError(sessionId: string, error: unknown): RegistryError {
    return new RegistryError(
      "SCOUT_LAUNCH_FAILED",
      `Scout ${sessionId} failed to launch: ${errorMessage(error)}`,
      sessionId,
    );
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
      if (target === undefined) return result;
      const runtime = this.sessions.get(target.sessionId);
      if (runtime === undefined) return result;
      return runtime.turns.deliverResult(target.completionTarget, result);
    });
  }

  private notifySessionUpdate(sessionId: string): void {
    this.pendingSessionUpdates.delete(sessionId);
    for (const listener of this.sessionUpdateListeners) listener(sessionId);
  }

  /**
   * Announce an output-driven update, at most once per flush interval per session.
   *
   * Every listener of this — waits, the MCP event stream, Fleet's projection — asks the same
   * question about the same state, and a provider streaming a response drives it thousands of times
   * a second. Answering each one inline put all of that work between an operator's keystroke and
   * the broker reading it. Coalescing bounds it to a fixed rate without changing the answer: a
   * pending flush is a session whose latest state is already recorded and merely unannounced.
   *
   * Only the ingest path uses this. Every state transition the broker decides for itself — a turn
   * completing, a fault, an exit, an attention change — still calls {@link notifySessionUpdate}
   * directly, which also flushes anything pending for that session, so nothing material waits on a
   * timer. Bytes are never delayed: the controller and every watcher are written to inline.
   */
  private scheduleSessionUpdate(sessionId: string): void {
    this.pendingSessionUpdates.add(sessionId);
    if (this.sessionUpdateFlush !== undefined) return;
    this.sessionUpdateFlush = setTimeout(() => {
      delete this.sessionUpdateFlush;
      this.flushSessionUpdates();
    }, SESSION_UPDATE_FLUSH_MS);
    // A flush must never be the reason a broker stays alive; it has nothing to say about a process
    // that is on its way out.
    this.sessionUpdateFlush.unref?.();
  }

  private flushSessionUpdates(): void {
    const pending = [...this.pendingSessionUpdates];
    this.pendingSessionUpdates.clear();
    for (const sessionId of pending) {
      for (const listener of this.sessionUpdateListeners) listener(sessionId);
    }
  }

  /**
   * Refresh what the provider's input surface is holding.
   *
   * Called from the broadcast path and from anything that is about to make a claim about the
   * worker, because a claim made from a composer reading taken minutes ago is the class of lie this
   * whole change exists to stop.
   */
  private requireSessionRuntime(runtime: RuntimeSession): SessionRuntime {
    if (runtime.sessionRuntime === undefined) {
      throw new RegistryError("SESSION_NOT_ACTIVE", "Session runtime is not active; resume it before use");
    }
    return runtime.sessionRuntime;
  }

  private requireTerminalFinalizationComplete(runtime: RuntimeSession): void {
    if (runtime.terminalFinalizing !== true) return;
    throw new RegistryError(
      "SESSION_NOT_ACTIVE",
      "Session is finalizing its last durable turn",
    );
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
        runtime.turns.setLatestResultIfAbsent(
          `Scout trace persistence failed: ${runtime.scoutTraceFailure}`,
        );
        await this.persist(runtime).catch(() => undefined);
      });
  }

  /**
   * `replay` is a thunk because this is called from the broadcast path for every session, and only
   * a scout ever gets past the guard below. Materializing the replay for the check was a copy and a
   * decode of the whole buffer that every non-scout session paid on every chunk.
   */
  private captureScoutReport(runtime: RuntimeSession, replay: () => string): void {
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
    const text = replay();
    runtime.scoutCaptureTail = (runtime.scoutCaptureTail ?? Promise.resolve())
      .then(async () => {
        const result = await capture(scout, text);
        await this.applyScoutCapture(runtime, result);
      })
      .catch(async (error) => {
        if (runtime.record.scout === undefined) return;
        if (runtime.record.scout.reportState === "complete") return;
        runtime.record.scout.reportState = "invalid";
        runtime.turns.setLatestResult(error instanceof Error ? error.message : String(error));
        await this.persist(runtime).catch(() => undefined);
        this.notifySessionUpdate(runtime.record.id);
      });
  }

  private async applyScoutCapture(runtime: RuntimeSession, result: ScoutReportCapture): Promise<void> {
    const scout = runtime.record.scout;
    if (scout === undefined || scout.terminalState === "complete" || result.state === "missing") return;
    const changed = scout.reportState !== result.state;
    scout.reportState = result.state;
    if ("text" in result && result.text !== "") runtime.turns.setLatestResult(result.text);
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
      runtime.sessionRuntime?.kill("SIGTERM");
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
        runtime.sessionRuntime?.kill("SIGTERM");
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
      runtime.sessionRuntime?.kill("SIGTERM");
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
      runtime.sessionRuntime?.kill("SIGTERM");
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
      if ("text" in captured) runtime.turns.setLatestResult(captured.text);
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
          runtime.turns.recordCompletion(1, captured.text);
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
   * The broker cannot inherit a runtime it did not spawn, so nothing that was live before the restart
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
