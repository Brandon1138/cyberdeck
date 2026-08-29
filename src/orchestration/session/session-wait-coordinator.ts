import { MAX_WAIT_SECONDS } from "../../limits.js";
import { SessionCatalog } from "./session-catalog.js";
import type {
  WorkerResultSnapshot,
  WorkerWaitResult,
  WorkerWaitTarget,
} from "./session-ports.js";
import { SessionUpdateBus } from "./session-update-bus.js";

export interface SessionWaitCoordinatorOptions {
  catalog: SessionCatalog;
  bus: SessionUpdateBus;
}

/**
 * The one place a caller may block on other people's workers.
 *
 * A wait is a subscription with a deadline, and the two halves have to agree: what settles the wait
 * is read from the same turn engine that answers `workerTruth`, and the batch that actually reaches
 * the caller is the batch that counts as delivered. Anything else lets a worker be reported
 * finished to a wait and still working to the surface that reads it next.
 */
export class SessionWaitCoordinator {
  private readonly catalog: SessionCatalog;
  private readonly bus: SessionUpdateBus;

  constructor(options: SessionWaitCoordinatorOptions) {
    this.catalog = options.catalog;
    this.bus = options.bus;
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
      this.catalog.requireRuntime(target.sessionId).turns.waitResult(target.completionTarget, maxResultChars)
    );
    const isSettled = (status: WorkerResultSnapshot["status"]): boolean =>
      status !== "working" && status !== "waiting";
    // Settling is decided from statuses, not from full snapshots. Rebuilding every target's
    // snapshot on every update meant one chunk from one worker re-scanned all N workers' replays,
    // which is the fan-out MIK-87 profiled as `ArrayMap` over an accumulated structure. A snapshot
    // is built when the wait actually answers.
    const statuses = targets.map((target) =>
      this.catalog.requireRuntime(target.sessionId).turns.waitStatus(target.completionTarget));

    if (statuses.every(isSettled)) {
      return { timedOut: false, results: this.deliver(targets, snapshot()) };
    }

    return new Promise<WorkerWaitResult>((resolve) => {
      let settled = false;
      const finish = (timedOut: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.bus.sessionUpdateListeners.delete(onUpdate);
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
          statuses[index] = this.catalog.requireRuntime(target.sessionId).turns.waitStatus(
            target.completionTarget,
          );
          touched = true;
        });
        if (!touched) return;
        if (statuses.every(isSettled)) finish(false);
      };
      const timer = setTimeout(() => finish(true), boundedTimeout);
      this.bus.sessionUpdateListeners.add(onUpdate);
      // A target can settle between the reading above and the listener being attached, and nothing
      // more would arrive to notice it.
      for (const [index, target] of targets.entries()) {
        statuses[index] = this.catalog.requireRuntime(target.sessionId).turns.waitStatus(
          target.completionTarget,
        );
      }
      if (statuses.every(isSettled)) finish(false);
    });
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
      const runtime = this.catalog.sessions.get(target.sessionId);
      if (runtime === undefined) return result;
      return runtime.turns.deliverResult(target.completionTarget, result);
    });
  }
}
