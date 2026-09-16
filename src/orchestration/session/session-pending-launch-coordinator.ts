import { setTimeout as delay } from "node:timers/promises";
import type { SessionRecord } from "../../domain/session.js";
import type { SessionLaunchIntent } from "../../domain/session-launch-intent.js";
import type { SessionCatalog } from "./session-catalog.js";
import type { SessionRuntimeAssembly } from "./session-runtime-assembly.js";
import { cloneRecord } from "./session-record-projection.js";

type WaitingState = "waiting-capacity" | "waiting-authority";
interface PendingLaunchOptions {
  catalog: SessionCatalog;
  assembly: SessionRuntimeAssembly;
  requireActiveParent(id: string | undefined): void;
  launch(record: SessionRecord, input: string | undefined, fence: () => Promise<void>,
    assert: () => void, onWaiting: (state: WaitingState) => Promise<void>): Promise<SessionRecord>;
}

/** Durable prelaunch ownership and recovery; actual provider assembly stays on the one launch path. */
export class SessionPendingLaunchCoordinator {
  private readonly pending = new Map<string, AbortController>();
  private readonly catalog: SessionCatalog;
  private readonly assembly: SessionRuntimeAssembly;
  constructor(private readonly options: PendingLaunchOptions) {
    this.catalog = options.catalog; this.assembly = options.assembly;
  }

  /** Rehydrate receipts without awaiting capacity or invoking activation callbacks again. */
  async recover(): Promise<void> {
    const intents = this.catalog.options.launchIntents?.list() ?? [];
    const ready = intents.filter(intent => intent.phase === "ready"
      && this.catalog.options.resourceExecution?.recoverable?.(intent.record) !== false);
    this.catalog.options.resourceExecution?.retainPending?.(ready.map(intent => intent.record));
    for (const intent of intents) {
      if (intent.phase === "terminal") {
        // A crash between cancellation and catalog persistence must not resurrect the receipt.
        const existing = this.catalog.sessions.get(intent.record.id);
        if ((!intent.terminalProjectionCommitted || existing?.record.pendingLaunch) && intent.outcome !== "launched")
          await this.finish(intent, intent.outcome ?? "interrupted", false);
        continue;
      }
      if (intent.phase !== "ready" || !ready.includes(intent)) {
        await this.finish(intent, "interrupted");
        continue;
      }
      await this.publish(intent.record);
      this.arm(intent);
    }
  }

  async cancel(sessionId: string): Promise<boolean> {
    const intent = this.catalog.options.launchIntents?.get(sessionId);
    if (!intent || intent.phase === "terminal") return false;
    if (intent.phase === "launching") {
      // Preparation may already own helpers. Stop the continuation, but do not claim that the
      // launch never happened or free its reservation without whole-runtime termination proof.
      await this.catalog.options.launchIntents!.put({ ...intent, phase: "terminal", outcome: "interrupted",
        terminalAt: new Date().toISOString(), terminalFromPhase: "launching" }, "launching");
      this.pending.get(sessionId)?.abort();
      this.catalog.options.resourceExecution?.cancelStart(sessionId);
      const ownsRuntime = this.catalog.sessions.get(sessionId)?.sessionRuntime !== undefined;
      await this.finish(intent, "interrupted", false);
      return !ownsRuntime;
    }
    // Durable terminal wins the race with the launch fence before any cancellation is acknowledged.
    try { await this.finish(intent, "cancelled"); }
    catch (error) {
      if (error instanceof Error && error.message === "SESSION_LAUNCH_INTENT_PHASE_CHANGED") return this.cancel(sessionId);
      throw error;
    }
    this.pending.get(sessionId)?.abort();
    await this.catalog.options.resourceExecution?.cancelPending?.(intent.record);
    this.catalog.options.resourceExecution?.cancelStart(sessionId);
    return true;
  }

  async publish(record: SessionRecord, published?: () => void): Promise<void> {
    const current = this.catalog.options.launchIntents?.get(record.id);
    if (current?.phase === "terminal" && record.executionState === "starting") throw new Error("SESSION_LAUNCH_INTENT_TERMINAL");
    await this.catalog.options.store?.put(cloneRecord(record));
    const existing = this.catalog.sessions.get(record.id);
    if (existing) Object.assign(existing.record, record);
    else this.catalog.sessions.set(record.id, this.assembly.createRuntimeSession(record, {
      watchers: new Map(), stopRequested: false, launchTail: Promise.resolve(),
    }));
    published?.();
    if (record.parentSessionId) {
      const parent = this.catalog.sessions.get(record.parentSessionId);
      if (parent && !parent.record.childIds.includes(record.id)) {
        parent.record.childIds.push(record.id);
        await this.catalog.persist(parent);
      }
    }
  }

  arm(intent: SessionLaunchIntent): void {
    const controller = new AbortController();
    this.pending.set(intent.record.id, controller);
    void this.runPending(intent, controller.signal).catch(async () => {
      const current = this.catalog.options.launchIntents?.get(intent.record.id);
      if (current && current.phase !== "terminal") await this.finish(current,
        current.phase === "launching" ? "interrupted" : "failed");
    }).catch(() => {
      // Persistence failure fails closed: never re-run a side effect or claim durable completion.
    }).finally(() => this.pending.delete(intent.record.id));
  }

  private async runPending(intent: SessionLaunchIntent, signal: AbortSignal): Promise<void> {
    const record = intent.record;
    // A retained binding is accounting, not permission. Parent and canonical authority must both
    // be available. Polling is bounded in rate and lifetime; stopped parents remain explicit waits.
    for (;;) {
      signal.throwIfAborted();
      if (Date.now() - Date.parse(record.createdAt) > 7 * 24 * 60 * 60 * 1000)
        throw new Error("SESSION_LAUNCH_INTENT_EXPIRED");
      try {
        this.options.requireActiveParent(record.parentSessionId);
        await this.catalog.options.resourceExecution?.assertAuthority?.(record);
        break;
      } catch {
        await this.catalog.options.resourceExecution?.suspendPending?.(record);
        if (record.pendingLaunch?.state !== "waiting-authority") {
          record.pendingLaunch = { requestId: intent.requestId, state: "waiting-authority" };
          await this.publish(record);
        }
        await delay(250, undefined, { signal });
      }
    }
    signal.throwIfAborted();
    record.pendingLaunch = { requestId: intent.requestId, state: "waiting-capacity" };
    await this.publish(record);
    await this.options.launch(record, intent.initialPrompt, async () => {
      signal.throwIfAborted();
      this.options.requireActiveParent(record.parentSessionId);
      this.catalog.assertMayConsume(record.id);
      await this.catalog.options.resourceExecution?.assertAuthority?.(record);
      await this.catalog.options.launchIntents!.put({ ...intent, phase: "launching" }, "ready");
      record.pendingLaunch = { requestId: intent.requestId, state: "launching" };
      await this.publish(record);
      signal.throwIfAborted();
    }, () => signal.throwIfAborted(), async state => {
      if (record.pendingLaunch?.state !== state) {
        record.pendingLaunch = { requestId: intent.requestId, state };
        await this.publish(record);
      }
    });
    await this.catalog.options.launchIntents!.put({ ...intent, phase: "terminal", outcome: "launched", terminalAt: new Date().toISOString(), terminalFromPhase: "launching", terminalProjectionCommitted: true }, "launching");
  }

  async finish(intent: SessionLaunchIntent, outcome: "cancelled" | "interrupted" | "failed", persist = true): Promise<void> {
    if (persist) await this.catalog.options.launchIntents!.put({ ...intent, phase: "terminal", outcome, terminalAt: new Date().toISOString(),
      terminalFromPhase: intent.phase === "terminal" ? intent.terminalFromPhase! : intent.phase }, intent.phase);
    const runtime = this.catalog.sessions.get(intent.record.id);
    const record = cloneRecord(runtime?.sessionRuntime ? runtime.record : intent.record);
    record.pendingLaunch = { requestId: intent.requestId, state: outcome };
    record.executionState = outcome === "failed" ? "failed" : "cancelled";
    record.attentionState = outcome === "cancelled" ? "stopped" : outcome;
    record.exitCode = 0;
    if (runtime?.sessionRuntime) {
      // A failed post-launch write is not process termination. Keep the handle and PID reachable
      // until the observer/whole-runtime accounting can confirm cleanup.
      record.executionState = "errored";
      record.exitCode = null;
      runtime.sessionRuntime.kill("SIGTERM");
    }
    await this.publish(record);
    const terminal = this.catalog.options.launchIntents!.get(record.id);
    if (terminal?.phase === "terminal")
      await this.catalog.options.launchIntents!.markTerminalProjected(record.id, terminal.requestId, terminal.terminalAt!);
  }

}
