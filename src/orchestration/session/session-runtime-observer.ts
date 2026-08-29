import type { SessionRuntime } from "../../domain/session-runtime.js";
import { SessionCatalog } from "./session-catalog.js";
import type { RuntimeSession } from "./session-registry-ports.js";
import { updateAttachmentState } from "./session-runtime-guards.js";
import { SessionRuntimeAssembly } from "./session-runtime-assembly.js";
import { SessionUpdateBus } from "./session-update-bus.js";
import type { WorkerTurnAppendResult } from "./worker-turn-engine.js";

export interface SessionRuntimeObserverOptions {
  catalog: SessionCatalog;
  bus: SessionUpdateBus;
  assembly: SessionRuntimeAssembly;
  /**
   * A thread reaching a terminal state is the moment the retained set can grow, so the observer has
   * to be able to ask for a retention sweep. Retirement itself is lifecycle authority and stays
   * there; this is the trigger, not a second implementation of it.
   */
  sweepRetention: () => Promise<unknown>;
}

/**
 * Everything a live provider handle says, and what the session it drives makes of it.
 *
 * Output, a fatal observation, and an exit all arrive on callbacks owned by one `SessionRuntime`,
 * and a session outlives its handles — a resume replaces the handle while the outgoing one is still
 * talking. Binding those callbacks and deciding the terminal record they produce are therefore the
 * same job: every one of them first checks that it is still the adopted handle, and only the exit
 * that wins that check is allowed to publish.
 */
export class SessionRuntimeObserver {
  private readonly catalog: SessionCatalog;
  private readonly bus: SessionUpdateBus;
  private readonly assembly: SessionRuntimeAssembly;
  private readonly sweepRetention: () => Promise<unknown>;

  constructor(options: SessionRuntimeObserverOptions) {
    this.catalog = options.catalog;
    this.bus = options.bus;
    this.assembly = options.assembly;
    this.sweepRetention = options.sweepRetention;
  }

  /**
   * Bind a runtime's callbacks to that runtime, not merely to the session it currently drives.
   *
   * A session outlives its processes: a resume replaces the handle, and the outgoing one keeps
   * reporting output and its exit long after it has stopped representing the session. Every
   * callback therefore checks that it is still the adopted handle before it is allowed to touch
   * shared state.
   */
  adoptSessionRuntime(runtime: RuntimeSession, sessionRuntime: SessionRuntime): void {
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

  broadcast(runtime: RuntimeSession, chunk: Buffer): void {
    runtime.record.updatedAt = new Date().toISOString();
    const sessionRuntime = runtime.sessionRuntime;
    if (sessionRuntime === undefined) return;
    // The raw replay is read lazily, and by the two readers that genuinely need every byte: a
    // scout's drop-box capture and a preview refresh. Materializing it here cost a 128 KiB copy and
    // decode on every chunk of provider output, for readers that were about to look at one screen.
    const rawReplay = (): string => sessionRuntime.snapshot().toString("utf8");
    if (runtime.record.scout?.transport === "headless-stream-json") {
      runtime.turns.appendOutput(chunk, rawReplay, false);
      runtime.scout?.observeOutput(chunk, rawReplay);
      runtime.controller?.output(chunk);
      for (const watcher of runtime.watchers.values()) watcher.output(chunk);
      this.bus.scheduleSessionUpdate(runtime.record.id);
      return;
    }
    const turnObservation = runtime.turns.appendOutput(chunk, rawReplay);
    runtime.scout?.observeOutput(chunk, rawReplay);
    if (turnObservation.fatal) {
      this.handleFatalObservation(runtime, chunk, turnObservation);
      return;
    }
    runtime.controller?.output(chunk);
    for (const watcher of runtime.watchers.values()) {
      watcher.output(chunk);
    }
  }

  handleFatalObservation(
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
      void this.catalog.appendEvent("session.errored", runtime.record.id, {
        reason: termination.reason,
        detail: termination.detail,
        kind: termination.kind,
        pid: runtime.record.pid,
      }).catch(() => undefined);
      void this.catalog.appendTranscript(runtime.record.id, "lifecycle", "broker", "session errored", {
        reason: termination.reason,
        detail: termination.detail,
        kind: termination.kind,
      }).catch(() => undefined);
      void this.catalog.setAttention(runtime, "failed", true).catch(() => undefined);
    }
    const controller = runtime.controller;
    const watchers = [...runtime.watchers.values()];
    controller?.output(chunk);
    for (const watcher of watchers) watcher.output(chunk);
    delete runtime.controller;
    runtime.watchers.clear();
    updateAttachmentState(runtime);
    const failure = {
      code: "SESSION_ERRORED",
      message: runtime.turns.latestResult ?? "Provider session failed",
    };
    controller?.failed(failure);
    for (const watcher of watchers) watcher.failed(failure);
    void this.catalog.persist(runtime).catch(() => undefined);
    this.bus.notifySessionUpdate(runtime.record.id);
  }

  handleExit(
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
    runtime.scout?.releaseBudget();
    const settlesNormalSemanticTurn = runtime.record.executionState === "active"
      && !runtime.stopRequested
      && runtime.record.profile !== "scout"
      && runtime.record.termination === undefined;
    if (!settlesNormalSemanticTurn) {
      // Fatal/provider-limit, explicit-stop, and Scout authority already chose their terminal
      // semantics. They must not reinterpret a previously frozen screen as a normal turn. A bare
      // non-zero process exit has no such semantic authority: it still settles an exact receipt
      // before the process outcome is published as failed.
      runtime.turns.discardPendingScreenTurns();
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

  publishTerminalExit(
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
    void this.catalog.appendEvent("session.exited", runtime.record.id, {
      exitCode,
      signal: signal ?? null,
    });
    void this.catalog.appendTranscript(runtime.record.id, "lifecycle", "broker", "session exited", {
      exitCode,
      signal: signal ?? null,
    }).catch(() => undefined);
    // A thread reaching a terminal state is the moment the retained set can grow, so it is also
    // the moment to check whether the oldest history has fallen out of the retention policy.
    void this.catalog.persist(runtime).then(() => this.sweepRetention()).catch(() => undefined);
    // The provider process is gone, so its launch artifacts are no longer referenced by anything.
    // A resume rebuilds them from the record; keeping them alive here would only widen the window
    // in which a private payload file sits on disk.
    runtime.launchTail = runtime.launchTail
      .then(() => this.assembly.cleanupLaunchArtifacts(runtime.record, "session-exited"))
      .catch(() => undefined);
    this.bus.notifySessionUpdate(runtime.record.id);
  }

  /**
   * Settle a headless Scout's own truth, then publish the one canonical exit.
   *
   * The supervisor decides the Scout's terminal state; the registry still owns the lifecycle exit
   * that every session shares. A duplicate close path is reported as such and publishes nothing —
   * the call that owns the exit already did.
   */
  async finalizeHeadlessScout(
    runtime: RuntimeSession,
    sessionRuntime: SessionRuntime,
    exitCode: number,
    signal?: number,
  ): Promise<void> {
    const supervisor = runtime.scout;
    if (supervisor === undefined) {
      this.handleExit(runtime, sessionRuntime, exitCode, signal);
      return;
    }
    // The replay thunk is bound to the exact handle that exited, so a replacement generation's
    // screen can never be read as this process's final report.
    const outcome = await supervisor.finalizeExit(
      exitCode,
      () => sessionRuntime.snapshot().toString("utf8"),
    );
    if (outcome.status === "duplicate") return;
    this.handleExit(runtime, sessionRuntime, exitCode, signal);
  }
}
