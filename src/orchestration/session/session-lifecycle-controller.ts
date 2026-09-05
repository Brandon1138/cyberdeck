import type { SessionRecord } from "../../domain/session.js";
import { selectExpiredThreads } from "../../domain/thread-retention.js";
import { resolvedLaunchRecord } from "./launch-record.js";
import { SessionCatalog } from "./session-catalog.js";
import { cloneRecord, compareDisplayOrder } from "./session-record-projection.js";
import {
  RegistryError,
  type RuntimeSession,
  type SessionTreeProgress,
} from "./session-registry-ports.js";
import { requireSessionRuntime } from "./session-runtime-guards.js";
import { SessionRuntimeAssembly } from "./session-runtime-assembly.js";
import { SessionRuntimeObserver } from "./session-runtime-observer.js";
import { SessionUpdateBus } from "./session-update-bus.js";

export interface SessionLifecycleControllerOptions {
  catalog: SessionCatalog;
  bus: SessionUpdateBus;
  assembly: SessionRuntimeAssembly;
  observer: SessionRuntimeObserver;
}

/**
 * A session's whole life after it is running: stopping it, resuming it, and retiring it.
 *
 * These belong together because they are the transitions that contend with each other. A stop must
 * not be re-entered by a resume, a resume must settle every turn the outgoing process could still
 * own before a replacement generation becomes visible, and a delete must refuse a thread either of
 * them is still holding. Ordering them is the job; each one alone is not.
 */
export class SessionLifecycleController {
  private readonly catalog: SessionCatalog;
  private readonly bus: SessionUpdateBus;
  private readonly assembly: SessionRuntimeAssembly;
  private readonly observer: SessionRuntimeObserver;
  /** Set by `stopAll` so the shutdown kill is distinguishable from an operator stop. */
  private shuttingDown = false;

  constructor(options: SessionLifecycleControllerOptions) {
    this.catalog = options.catalog;
    this.bus = options.bus;
    this.assembly = options.assembly;
    this.observer = options.observer;
  }

  async stop(sessionId: string): Promise<void> {
    const runtime = this.catalog.requireRuntime(sessionId);
    if (runtime.terminalFinalizing === true) return;
    if (runtime.record.exitCode !== null) {
      if (runtime.record.attentionState === "stopped") return;
      await this.catalog.setAttention(runtime, "stopped", true);
      await this.catalog.appendEvent("session.stopped", sessionId, {});
      await this.catalog.appendTranscript(sessionId, "lifecycle", "broker", "session stopped", {});
      this.bus.notifySessionUpdate(sessionId);
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
    // Stop authority rejects any unbanked screen synchronously, before journaling or process kill
    // can yield long enough for the 200 ms bank to reinterpret it as a completed turn.
    runtime.turns.discardPendingScreenTurns();
    if (runtime.outcomePreserved !== true) await this.catalog.setAttention(runtime, "stopping", true);
    requireSessionRuntime(runtime).kill("SIGTERM");
    await this.catalog.appendEvent("session.stopped", sessionId, {});
    await this.catalog.appendTranscript(sessionId, "lifecycle", "broker", "session stopped", {});
  }

  /** Force only one already-stopping session. Child sessions are deliberately untouched. */
  forceStop(sessionId: string): void {
    const runtime = this.catalog.requireRuntime(sessionId);
    if (runtime.terminalFinalizing === true) return;
    if (runtime.record.exitCode !== null) return;
    if (!runtime.stopRequested) {
      throw new RegistryError("SESSION_NOT_ACTIVE", "Graceful stop must be requested before force");
    }
    requireSessionRuntime(runtime).kill("SIGKILL");
  }

  async stopTree(sessionId: string): Promise<SessionTreeProgress> {
    const tree = this.catalog.sessionTree(sessionId);
    await this.stop(sessionId);
    await Promise.all(tree.slice(1).map((runtime) => this.stop(runtime.record.id)));
    return this.catalog.treeProgress(sessionId);
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
    for (const [sessionId, runtime] of this.catalog.sessions) {
      if (runtime.record.exitCode !== null) continue;
      await this.stop(sessionId);
    }
  }

  async resume(sessionId: string): Promise<SessionRecord> {
    const runtime = this.catalog.requireRuntime(sessionId);
    this.catalog.assertMayConsume(sessionId);
    if (runtime.terminalFinalizing === true) {
      throw new RegistryError(
        "SESSION_ALREADY_ACTIVE",
        "Session exit is still finalizing its last durable turn",
      );
    }
    if (runtime.resuming === true) {
      throw new RegistryError("SESSION_ALREADY_ACTIVE", "Session resume is already in progress");
    }
    if (runtime.record.executionState === "active" || runtime.record.executionState === "starting") {
      throw new RegistryError("SESSION_ALREADY_ACTIVE", "Session is already active");
    }
    runtime.resuming = true;
    try {
      return await this.resumeRuntime(runtime);
    } finally {
      runtime.resuming = false;
    }
  }

  async resumeRuntime(runtime: RuntimeSession): Promise<SessionRecord> {
    const sessionId = runtime.record.id;

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

    const adapter = this.catalog.requireAdapter(runtime.record.provider);
    const record = cloneRecord(runtime.record);
    const resumeSpec = adapter.buildResumeSpec(record);
    // A resume spec can name provider-owned artifacts (Claude's payload files) that the previous
    // exit removed, so wait for any in-flight cleanup and then rebuild them before the spawn.
    await runtime.launchTail;
    const sessionRuntime = await this.assembly.resumeSessionRuntime(
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
    this.observer.adoptSessionRuntime(runtime, sessionRuntime);
    // Replacing the runtime also replaces its replay. Advance every derived cursor now so a
    // silent resumed process cannot leave clients displaying the previous generation forever.
    this.bus.notifySessionUpdate(sessionId);
    await this.catalog.appendEvent("session.resumed", sessionId, {
      provider: runtime.record.provider,
      model: runtime.record.model ?? null,
      pid: runtime.record.pid,
    });
    await this.catalog.appendTranscript(sessionId, "lifecycle", "broker", "session resumed", {
      pid: runtime.record.pid,
    });
    await this.catalog.persist(runtime);
    return cloneRecord(runtime.record);
  }

  async delete(sessionId: string, beforeDelete?: () => Promise<void>): Promise<void> {
    const runtime = this.catalog.requireRuntime(sessionId);
    if (
      runtime.record.executionState === "active"
      || runtime.record.executionState === "starting"
      || runtime.record.exitCode === null
    ) {
      throw new RegistryError("SESSION_STILL_ACTIVE", "Stop the agent before deleting its thread");
    }
    // Keep the thread visible when its isolated evidence cannot be collected. Retirement
    // uses the same execution identity as resume and never deletes the private clone.
    await this.catalog.options.executions?.retire?.(sessionId);
    await beforeDelete?.();

    // Workers outlive an orchestrator. Detach their live parent reference before
    // removing the parent record, leaving each worker's own durable state intact.
    const children = runtime.record.childIds
      .map((childId) => this.catalog.sessions.get(childId))
      .filter((child): child is RuntimeSession => child !== undefined);
    await Promise.all(children.map(async (child) => {
      if (child.record.parentSessionId !== sessionId) return;
      delete child.record.parentSessionId;
      child.record.updatedAt = new Date().toISOString();
      await this.catalog.persist(child);
    }));

    await this.catalog.appendEvent("session.deleted", sessionId, {
      executionState: runtime.record.executionState,
    });
    await this.catalog.appendTranscript(sessionId, "lifecycle", "broker", "session deleted", {});
    if (runtime.record.parentSessionId !== undefined) {
      const parent = this.catalog.sessions.get(runtime.record.parentSessionId);
      if (parent !== undefined) {
        parent.record.childIds = parent.record.childIds.filter((childId) => childId !== sessionId);
        parent.record.updatedAt = new Date().toISOString();
        await this.catalog.persist(parent);
      }
    }
    await runtime.launchTail;
    await this.assembly.cleanupLaunchArtifacts(runtime.record, "session-deleted");
    await this.catalog.options.store?.delete(sessionId);
    this.catalog.sessions.delete(sessionId);
  }

  async rename(sessionId: string, name: string): Promise<SessionRecord> {
    const normalized = name.replace(/\s+/gu, " ").trim();
    if (normalized === "") throw new Error("Thread name cannot be empty");
    const runtime = this.catalog.requireRuntime(sessionId);
    runtime.record.name = normalized.slice(0, 120);
    runtime.record.updatedAt = new Date().toISOString();
    await this.catalog.persist(runtime);
    return cloneRecord(runtime.record);
  }

  async togglePin(sessionId: string): Promise<SessionRecord> {
    const runtime = this.catalog.requireRuntime(sessionId);
    runtime.record.pinned = runtime.record.pinned !== true;
    runtime.record.updatedAt = new Date().toISOString();
    await this.catalog.persist(runtime);
    return cloneRecord(runtime.record);
  }

  async reorder(sessionId: string, direction: "up" | "down"): Promise<SessionRecord[]> {
    const runtime = this.catalog.requireRuntime(sessionId);
    const group = [...this.catalog.sessions.values()]
      .filter((candidate) => candidate.record.cwd === runtime.record.cwd && candidate.record.kind === runtime.record.kind)
      .sort((left, right) => compareDisplayOrder(left.record, right.record));
    const index = group.findIndex((candidate) => candidate.record.id === sessionId);
    const target = direction === "up" ? index - 1 : index + 1;
    if (index < 0 || target < 0 || target >= group.length) return group.map(({ record }) => cloneRecord(record));
    [group[index], group[target]] = [group[target]!, group[index]!];
    await Promise.all(group.map(async (candidate, displayOrder) => {
      candidate.record.displayOrder = displayOrder;
      candidate.record.updatedAt = new Date().toISOString();
      await this.catalog.persist(candidate);
    }));
    return group.map(({ record }) => cloneRecord(record));
  }

  /**
   * Retire finished threads that have fallen outside the retention policy.
   *
   * Only threads whose process is gone are candidates, so this frees history, never capacity. A
   * failure to retire one thread is not allowed to abort the sweep — retention is housekeeping, and
   * the next sweep will retry.
   */
  async sweepRetention(now: number = Date.now()): Promise<string[]> {
    const expired = selectExpiredThreads(this.catalog.list(), this.catalog.options.config.threadRetention, now);
    const retired: string[] = [];
    for (const sessionId of expired) {
      if (!this.catalog.sessions.has(sessionId)) continue;
      try {
        await this.delete(sessionId);
        retired.push(sessionId);
      } catch {
        // Left in place on purpose; a thread that cannot be retired now stays visible.
      }
    }
    return retired;
  }
}
