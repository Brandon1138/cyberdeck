import type { SessionRuntime } from "../../domain/session-runtime.js";
import type { SessionRecord } from "../../domain/session.js";
import type { ScoutRuntimeState } from "../../domain/worker-profile.js";
import type { ProviderAdapter, ProviderLaunchSpec } from "./provider-ports.js";
import type { ScoutSessionSupervisorFactory } from "./scout-session-supervisor.js";
import { SessionCatalog } from "./session-catalog.js";
import { cloneRecord, recoverRecord } from "./session-record-projection.js";
import { resolvedLaunchRecord } from "./launch-record.js";
import type { RuntimeSession } from "./session-registry-ports.js";
import { requireSessionRuntime } from "./session-runtime-guards.js";
import { SessionUpdateBus } from "./session-update-bus.js";
import { WorkerTurnEngineFactory } from "./worker-turn-engine.js";

export interface SessionRuntimeAssemblyOptions {
  catalog: SessionCatalog;
  bus: SessionUpdateBus;
  scoutSupervision: ScoutSessionSupervisorFactory;
}

/**
 * Everything that has to happen for a `SessionRecord` to become — or stop being — a live runtime.
 *
 * A session is assembled in more than one direction: a fresh launch, a resume that replaces the
 * handle underneath an existing session, a Scout that failed before it ever spawned, and a restart
 * that rehydrates records the broker did not spawn. All four build the same `RuntimeSession` with
 * the same turn engine, the same supervisor, and the same durable registration, which is why they
 * are assembled in one place rather than four.
 */
export class SessionRuntimeAssembly {
  private readonly catalog: SessionCatalog;
  private readonly bus: SessionUpdateBus;
  private readonly scoutSupervision: ScoutSessionSupervisorFactory;

  constructor(options: SessionRuntimeAssemblyOptions) {
    this.catalog = options.catalog;
    this.bus = options.bus;
    this.scoutSupervision = options.scoutSupervision;
  }

  /**
   * Rehydrate the records a previous broker left behind, before anything may read them.
   *
   * Recovery rewrites lifecycle fields, so the catalog is only authoritative once the rewrite is
   * written back. It persists whenever recovery actually changed the outcome, not just for the
   * interrupted case — a thread recovered as finished has to survive the *next* restart too.
   */
  async recover(stored: readonly SessionRecord[]): Promise<void> {
    const writes: Promise<void>[] = [];
    for (const original of stored) {
      const record = recoverRecord(original);
      // A provider limit is the one piece of runtime truth that survives the process that observed
      // it, because the cap belongs to the account rather than to the runtime. Recovery folds `errored`
      // into `failed`, so without rehydrating this the operator is told the worker crashed when it
      // was actually told to come back at 3:00pm.
      this.catalog.sessions.set(record.id, this.createRuntimeSession(record, {
        watchers: new Map(),
        stopRequested: false,
        launchTail: Promise.resolve(),
      }));
      const rewritten = record.executionState !== original.executionState
        || record.attentionState !== original.attentionState
        || record.exitCode !== original.exitCode;
      if (rewritten) {
        writes.push(this.catalog.options.store?.put(cloneRecord(record)) ?? Promise.resolve());
      }
    }
    await Promise.all(writes);
    await this.catalog.recoverScoutReports();
  }

  createRuntimeSession(
    record: SessionRecord,
    state: Omit<RuntimeSession, "record" | "turns">,
  ): RuntimeSession {
    let runtime!: RuntimeSession;
    const turns = new WorkerTurnEngineFactory({
      observations: this.catalog.options.workerTurnObservation,
      preview: this.catalog.options.workerTurnObservation,
      ...(this.catalog.options.transcripts === undefined ? {} : { transcripts: this.catalog.options.transcripts }),
      effects: {
        hasRuntime: () => runtime.sessionRuntime !== undefined,
        snapshot: () => runtime.sessionRuntime?.snapshot().toString("utf8"),
        write: (data) => requireSessionRuntime(runtime).write(data),
        appendEvent: (type, data) => this.catalog.appendEvent(type, record.id, data),
        persist: () => this.catalog.persist(runtime),
        setAttention: (attentionState, meaningful) =>
          this.catalog.setAttention(runtime, attentionState, meaningful),
        notifyInstructionState: (update) => this.bus.notifyInstructionState(update),
        notifyDeliveryBoundary: () => this.bus.notifyDeliveryBoundary(record.id),
        notifySessionUpdate: () => this.bus.notifySessionUpdate(record.id),
        scheduleSessionUpdate: () => this.bus.scheduleSessionUpdate(record.id),
        stopRequested: () => runtime.stopRequested,
        scoutBudgetExhausting: () => runtime.scout?.isBudgetExhausting() === true,
      },
      workerStallSeconds: this.catalog.options.config.workerStallSeconds,
      ...(this.catalog.options.now === undefined ? {} : { now: this.catalog.options.now }),
    }).create(record, this.catalog.replayBytesFor(record));
    // A Scout gets a supervisor; every other session gets `undefined` and carries no Scout state.
    const scout = this.scoutSupervision.create(record, {
      persist: () => this.catalog.persist(runtime),
      appendEvent: (type, data) => this.catalog.appendEvent(type, record.id, data),
      appendTranscript: (text, data) =>
        this.catalog.appendTranscript(record.id, "lifecycle", "broker", text, data),
      notifySessionUpdate: () => this.bus.notifySessionUpdate(record.id),
      setLatestResult: (text) => runtime.turns.setLatestResult(text),
      setLatestResultIfAbsent: (text) => runtime.turns.setLatestResultIfAbsent(text),
      recordCompletion: (turns_, text) => runtime.turns.recordCompletion(turns_, text),
      kill: (signal) => runtime.sessionRuntime?.kill(signal),
      stopRequested: () => runtime.stopRequested,
    });
    runtime = { record, turns, ...(scout === undefined ? {} : { scout }), ...state };
    return runtime;
  }

  async spawnPreparedLaunch(
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
      const replayBytes = this.catalog.replayBytesFor(record);
      onPhase?.("spawn");
      return this.catalog.options.sessionRuntimeFactory(spec, replayBytes);
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
  async cleanupLaunchArtifacts(record: SessionRecord, reason: string): Promise<void> {
    const cleanupFailures: string[] = [];
    const adapter = this.catalog.options.adapters[record.provider];
    if (adapter?.cleanupLaunch !== undefined) {
      try {
        await adapter.cleanupLaunch(record);
      } catch (error) {
        cleanupFailures.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (record.profile === "scout" && reason === "session-deleted") {
      try {
        await this.scoutSupervision.discardReports(record.id);
      } catch (error) {
        cleanupFailures.push(error instanceof Error ? error.message : String(error));
      }
    }
    // Deletion is the last moment anything knows this thread existed: once its record is gone from
    // the session store, no later broker startup can discover the binding it left behind. Both
    // runtime deletion paths — an operator's `session.delete` and `sweepRetention` — reach here, so
    // this is where the binding is dropped rather than accumulating a file per deleted thread.
    const transcripts = this.catalog.options.transcripts;
    if (reason === "session-deleted" && transcripts?.dropClaudeBinding !== undefined) {
      try {
        await transcripts.dropClaudeBinding.call(transcripts, record.id);
      } catch (error) {
        cleanupFailures.push(error instanceof Error ? error.message : String(error));
      }
    }
    for (const message of cleanupFailures) {
      await this.catalog.appendTranscript(
        record.id,
        "lifecycle",
        "broker",
        "provider launch artifact cleanup failed",
        { reason, message },
      ).catch(() => undefined);
    }
  }

  async registerSession(runtime: RuntimeSession): Promise<void> {
    const record = runtime.record;
    await this.catalog.persist(runtime);
    if (record.parentSessionId !== undefined) {
      const parent = this.catalog.requireRuntime(record.parentSessionId);
      if (!parent.record.childIds.includes(record.id)) {
        parent.record.childIds.push(record.id);
        parent.record.updatedAt = new Date().toISOString();
        await this.catalog.persist(parent);
      }
    }
    await this.catalog.appendEvent("session.created", record.id, {
      provider: record.provider,
      model: record.model ?? null,
      role: record.role ?? null,
      parentSessionId: record.parentSessionId ?? null,
      pid: record.pid,
      executionState: record.executionState,
    });
    await this.catalog.appendTranscript(record.id, "lifecycle", "broker", "session created", {
      provider: record.provider,
      model: record.model ?? null,
      executionState: record.executionState,
    });
  }

  /**
   * Turn a Scout that never launched into a durable Fleet row.
   *
   * Registration is handed to the supervisor as a callback so the record is already failed when it
   * is first persisted: a Scout that reached the catalog as `starting` and was rewritten afterwards
   * would be adoptable for the width of that window.
   */
  async preserveFailedScoutLaunch(
    record: SessionRecord,
    phase: NonNullable<ScoutRuntimeState["launchFailure"]>["phase"],
    error: unknown,
    launchSpec?: ProviderLaunchSpec,
  ): Promise<void> {
    if (record.scout === undefined) return;
    if (launchSpec !== undefined) {
      record.launchRecord = resolvedLaunchRecord(launchSpec, "launch");
    }
    const runtime = this.createRuntimeSession(record, {
      watchers: new Map(),
      stopRequested: false,
      launchTail: Promise.resolve(),
    });
    this.catalog.sessions.set(record.id, runtime);
    await runtime.scout?.preserveLaunchFailure(phase, error, () =>
      this.registerSession(runtime).catch(() => this.catalog.persist(runtime).catch(() => undefined)));
  }

  /**
   * Spawn the replacement runtime for a resume, restoring the outgoing handle if the spawn fails.
   *
   * `resume` releases the old handle up front so its exit cannot land on the new session. When no
   * new handle arrives, the session is left exactly as the resume found it, so an operator can
   * still stop the process the failed resume did not replace.
   */
  async resumeSessionRuntime(
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
}
