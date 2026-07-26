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
import type { ProviderAdapter, ProviderLaunchSpec } from "../providers/provider.js";
import type {
  AppendThreadEvent,
  CaptureProviderTurns,
  ThreadTranscriptStore,
} from "../persistence/thread-transcript-store.js";
import { applyWorkerMode } from "../providers/worker-mode.js";
import {
  conversationPreview,
  PREVIEW_STORAGE_LIMIT,
  type TranscriptMessage,
} from "../runtime/conversation-preview.js";
import {
  compactTerminalResult,
  providerTerminalActivity,
  terminalTokenCount,
  terminalFallbackResult,
  truncateResult,
  type ProviderTerminalActivity,
} from "../runtime/terminal-replay.js";
import { detectSessionFatalError } from "../runtime/session-liveness.js";
import { selectExpiredThreads } from "../domain/thread-retention.js";

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
}

const MAX_COMPLETION_LEDGER_ENTRIES = 64;

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
    | "exited";
  completedTurns: number;
  text: string;
  /** Only on a completed target: whether this delivery is the first one for that completion. */
  retrieval?: "fresh" | "replay";
  completedAt?: string;
  stalledForSeconds?: number;
  stallReason?: "transcript-and-token-count-unchanged-while-idle";
  tokenCount?: number;
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
      | "INVALID_SESSION_CWD",
    message: string,
  ) {
    super(message);
    this.name = "RegistryError";
  }
}

export class SessionRegistry {
  private readonly sessions = new Map<string, RuntimeSession>();
  private readonly controllerReleasedListeners = new Set<(sessionId: string) => void>();
  private readonly sessionUpdateListeners = new Set<(sessionId: string) => void>();
  private readonly recovery: Promise<void>;
  /** Set by `stopAll` so the shutdown kill is distinguishable from an operator stop. */
  private shuttingDown = false;

  constructor(private readonly options: SessionRegistryOptions) {
    const writes: Promise<void>[] = [];
    for (const stored of options.recoveredSessions ?? []) {
      const record = this.recoverRecord(stored);
      this.sessions.set(record.id, {
        record,
        watchers: new Map(),
        stopRequested: false,
        activity: "unknown",
        observedWorking: false,
        completedTurns: 0,
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
    this.recovery = Promise.all(writes).then(() => undefined);
  }

  async ready(): Promise<void> {
    await this.recovery;
  }

  onControllerReleased(listener: (sessionId: string) => void): () => void {
    this.controllerReleasedListeners.add(listener);
    return () => this.controllerReleasedListeners.delete(listener);
  }

  async start(request: StartSessionRequest, initialPrompt?: string): Promise<SessionRecord> {
    const validated = StartSessionRequestSchema.parse(request);
    await (this.options.validateCwd ?? validateSessionCwd)(validated.cwd);
    const parsed = validated;
    this.requireActiveParent(parsed.parentSessionId);
    const ancestry = this.resolveAncestry(parsed.parentSessionId);
    const decision = evaluateStart(parsed, ancestry, {
      activeWorkerCount: this.activeWorkerCount(),
      maxConcurrentWorkers: this.options.config.maxConcurrentWorkers,
      maxDelegationDepth: this.options.config.maxDelegationDepth,
    });
    if (!decision.allowed) {
      const message = decision.code === "MAX_CONCURRENT_WORKERS"
        ? `Worker limit reached: ${decision.activeWorkers ?? 0} active / ${decision.maxConcurrentWorkers ?? "unknown"} allowed`
        : decision.code;
      throw new RegistryError(decision.code, message);
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    const provisional: SessionRecord = {
      ...parsed,
      kind: parsed.kind ?? "worker",
      id,
      generation: 1,
      createdAt: now,
      updatedAt: now,
      executionState: "starting",
      attachmentState: "detached",
      pid: 1,
      exitCode: null,
      childIds: [],
      attentionState: initialPrompt === undefined ? "done" : "working",
      meaningfulUpdatedAt: now,
    };
    const adapter = this.requireAdapter(parsed.provider);
    const preparedInitialPrompt = initialPrompt === undefined
      ? undefined
      : applyWorkerMode(initialPrompt, provisional.workerMode);
    const deferredInitialPrompt = initialPrompt !== undefined
      && adapter.deferInitialPrompt?.(provisional) === true;
    const launchSpec = adapter.buildLaunchSpec(
      provisional,
      initialPrompt === undefined || deferredInitialPrompt
        ? undefined
        : preparedInitialPrompt,
    );
    const pty = await this.spawnPreparedLaunch(adapter, provisional, launchSpec, async () => {
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
    });
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
      completedTurns: 0,
      fatalReported: false,
      completions: new Map(),
      suppressSemanticTurns: true,
      launchTail: Promise.resolve(),
    };
    this.sessions.set(id, runtime);
    this.adoptPty(runtime, pty);

    try {
      await adapter.initializeSession?.(record, {
        snapshot: () => pty.snapshot(),
        write: (data) => pty.write(data),
        wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
      });
      if (runtime.record.executionState !== "active") {
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
        const data = adapter.submitInput?.(preparedInitialPrompt)
          ?? Buffer.from(`${preparedInitialPrompt}\n`);
        pty.write(data);
      }
    } catch (error) {
      if (runtime.idleTimer !== undefined) clearTimeout(runtime.idleTimer);
      delete runtime.idleTimer;
      if (runtime.pty === pty) delete runtime.pty;
      pty.kill();
      this.sessions.delete(id);
      await this.cleanupLaunchArtifacts(record, "initialization-failed");
      throw error;
    }

    if (parsed.parentSessionId !== undefined) {
      const parent = this.requireRuntime(parsed.parentSessionId);
      parent.record.childIds.push(id);
      parent.record.updatedAt = new Date().toISOString();
      await this.persist(parent);
    }

    try {
      await this.appendEvent("session.created", id, {
        provider: record.provider,
        model: record.model ?? null,
        role: record.role ?? null,
        parentSessionId: record.parentSessionId ?? null,
        pid: record.pid,
      });
      await this.appendTranscript(id, "lifecycle", "broker", "session created", {
        provider: record.provider,
        model: record.model ?? null,
      });
      await this.persist(runtime);
    } catch (error) {
      pty.kill();
      this.sessions.delete(id);
      await this.cleanupLaunchArtifacts(record, "launch-failed");
      throw error;
    }

    return this.cloneRecord(record);
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
    if (runtime.controller !== undefined && runtime.controller.clientId !== clientId) {
      throw new RegistryError("NOT_SESSION_CONTROLLER", "Another client controls this session");
    }
    this.requirePty(runtime).write(data);
    await this.appendEvent("session.input", sessionId, { bytes: data.length });
  }

  async submit(sessionId: string, clientId: string | undefined, message: string): Promise<void> {
    const runtime = this.requireRuntime(sessionId);
    const adapter = this.requireAdapter(runtime.record.provider);
    const data = adapter.submitInput?.(message) ?? Buffer.from(`${message}\n`);
    delete runtime.stallObservation;
    await this.appendTranscript(sessionId, "prompt", "human", message, {});
    await this.setAttention(runtime, "working", true);
    await this.write(sessionId, clientId, data);
  }

  async submitInstruction(
    sessionId: string,
    message: string,
    source: "orchestrator" | "worker" = "orchestrator",
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    const runtime = this.requireRuntime(sessionId);
    if (runtime.record.executionState !== "active") {
      throw new RegistryError("SESSION_NOT_ACTIVE", "Session is not active");
    }
    if (runtime.controller !== undefined) {
      throw new RegistryError("SESSION_BUSY", "A human controller currently owns this thread");
    }
    const adapter = this.requireAdapter(runtime.record.provider);
    const encoded = adapter.submitInput?.(message) ?? Buffer.from(`${message}\n`);
    delete runtime.stallObservation;
    await this.appendTranscript(sessionId, "instruction", source, message, metadata);
    if (runtime.controller !== undefined) {
      throw new RegistryError("SESSION_BUSY", "A human controller claimed this thread before delivery");
    }
    await this.setAttention(runtime, "working", true);
    this.requirePty(runtime).write(encoded);
    await this.appendEvent("session.input", sessionId, { bytes: encoded.length, source });
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
    // An errored session still owns a running OS process, so stop must be able to reach it even
    // though the broker no longer treats it as active.
    if (runtime.record.executionState !== "active" && runtime.record.executionState !== "errored") return;
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
        runtime.completedTurns += 1;
        runtime.observedWorking = false;
        const completedReplay = runtime.pty?.snapshot().toString("utf8") ?? replay;
        void this.completeSemanticTurn(runtime, completedReplay);
      }, 200);
    } else if (activity === "needs-input") {
      runtime.latestResult = compactTerminalResult(replay);
      if (runtime.record.attentionState !== "needs-input") {
        void this.setAttention(runtime, "needs-input", true);
        // A blocked session has no completed turn, so the transcript is the only place the last
        // real reply exists. Read it off the broadcast path, once per transition into the state.
        void this.refreshPreview(runtime, replay, []).catch(() => undefined);
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
    const fatal = detectSessionFatalError(replay);
    if (fatal === undefined) return false;

    runtime.fatalReported = true;
    if (runtime.idleTimer !== undefined) clearTimeout(runtime.idleTimer);
    delete runtime.idleTimer;
    runtime.activity = "unknown";
    runtime.observedWorking = false;
    runtime.latestResult = fatal.detail;
    // exitCode stays null on purpose: the process is still there, and deleting the thread must
    // still require stopping it. Only the slot and the "can accept input" claim are released.
    runtime.record.executionState = "errored";
    void this.appendEvent("session.errored", runtime.record.id, {
      reason: fatal.reason,
      detail: fatal.detail,
      pid: runtime.record.pid,
    }).catch(() => undefined);
    void this.appendTranscript(runtime.record.id, "lifecycle", "broker", "session errored", {
      reason: fatal.reason,
      detail: fatal.detail,
    }).catch(() => undefined);
    void this.setAttention(runtime, "failed", true).catch(() => undefined);
    return true;
  }

  private handleExit(runtime: RuntimeSession, exitCode: number, signal?: number): void {
    if (runtime.idleTimer !== undefined) clearTimeout(runtime.idleTimer);
    delete runtime.idleTimer;
    runtime.record.executionState = runtime.stopRequested
      ? "cancelled"
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
    runtime.record.attentionState = runtime.stopRequested
      ? (runtime.outcomePreserved === true ? "done" : "stopped")
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
      this.handleExit(runtime, exitCode, signal);
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
  ): Promise<PtyHandle> {
    try {
      if (adapter.prepareLaunch !== undefined) await adapter.prepareLaunch(record, spec);
      await beforeSpawn?.();
      return this.options.ptyFactory(spec, this.options.config.replayBytes);
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
    const adapter = this.options.adapters[record.provider];
    if (adapter?.cleanupLaunch === undefined) return;
    try {
      await adapter.cleanupLaunch(record);
    } catch (error) {
      await this.appendTranscript(
        record.id,
        "lifecycle",
        "broker",
        "provider launch artifact cleanup failed",
        { reason, message: error instanceof Error ? error.message : String(error) },
      ).catch(() => undefined);
    }
  }

  private workerResultSnapshot(target: WorkerWaitTarget, maxResultChars: number): WorkerResultSnapshot {
    const runtime = this.requireRuntime(target.sessionId);
    const replay = runtime.pty?.snapshot().toString("utf8") ?? runtime.record.latestPreview ?? "";
    // A recorded completion wins over live runtime state: once the target turn is in the ledger its
    // text is fixed, so a later turn cannot overwrite the answer this wait was asked for.
    const recorded = runtime.completions.get(target.completionTarget);
    const result = recorded?.text
      ?? (runtime.latestResult === undefined
        ? compactTerminalResult(replay, maxResultChars)
        : runtime.latestResult);
    const text = truncateResult(result, maxResultChars);
    const base = {
      sessionId: runtime.record.id,
      ...(runtime.record.name === undefined ? {} : { name: runtime.record.name }),
      provider: runtime.record.provider,
      ...(runtime.record.model === undefined ? {} : { model: runtime.record.model }),
      ...(runtime.record.effort === undefined ? {} : { effort: runtime.record.effort }),
      completedTurns: runtime.completedTurns,
      text,
    };
    if (runtime.completedTurns >= target.completionTarget) {
      return {
        ...base,
        status: "completed",
        ...(recorded === undefined ? {} : { completedAt: recorded.completedAt }),
      };
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
  ): CompletionLedgerEntry {
    const existing = runtime.completions.get(completionTarget);
    if (existing !== undefined) return existing;
    const entry: CompletionLedgerEntry = {
      text,
      completedAt: new Date().toISOString(),
      deliveries: 0,
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

  private async completeSemanticTurn(runtime: RuntimeSession, replay: string): Promise<void> {
    const fallback = terminalFallbackResult(replay);
    let nativeTurns: Array<{ text?: string | undefined }> = [];
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
    texts.forEach((text, index) => this.recordCompletion(runtime, firstTurn + index, text));
    runtime.latestResult = latest;
    await this.refreshPreview(
      runtime,
      replay,
      nativeTurns.map((turn): TranscriptMessage => ({ role: "assistant", text: turn.text ?? "" })),
    );
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
      ...(launchRecord === undefined ? {} : { launchRecord }),
    };
  }
}

function cloneLaunchRecord(record: ResolvedLaunchRecord | undefined): ResolvedLaunchRecord | undefined {
  if (record === undefined) return undefined;
  return { ...record, args: [...record.args], cyberdeckEnv: { ...record.cyberdeckEnv } };
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
