import type { ResolvedLaunchRecord, SessionRecord } from "../../domain/session.js";
import type { ScoutDecisionCard } from "../../domain/scout-output.js";
import type { ScoutArtifactKind } from "../../domain/worker-profile.js";
import type { WorkerTruth } from "../../domain/worker-truth.js";
import { SessionCatalog } from "./session-catalog.js";
import { cloneLaunchRecord, cloneRecord, registryError } from "./session-record-projection.js";
import type { ScoutArtifactRead } from "./session-ports.js";
import {
  RegistryError,
  type ReattachTarget,
  type WorkerBudgetObservation,
} from "./session-registry-ports.js";

/**
 * What may be asked about a session without changing it.
 *
 * Every read here hands back a clone, because a caller holding a live record would be reading the
 * registry's own mutable state and would see a lifecycle transition land in the middle of whatever
 * it was rendering.
 */
export class SessionReadModel {
  constructor(private readonly catalog: SessionCatalog) {}

  list(): SessionRecord[] {
    return this.catalog.list();
  }

  workerCapacity(): { activeWorkers: number; maxConcurrentWorkers: number | null } {
    return {
      activeWorkers: this.catalog.activeWorkerCount(),
      maxConcurrentWorkers: this.catalog.options.config.maxConcurrentWorkers,
    };
  }

  get(sessionId: string): SessionRecord {
    return cloneRecord(this.catalog.requireRuntime(sessionId).record);
  }

  async readScoutArtifact(
    sessionId: string,
    artifact: ScoutArtifactKind,
    afterByte = 0,
    maxBytes = 16 * 1024,
  ): Promise<ScoutArtifactRead> {
    const runtime = this.catalog.requireRuntime(sessionId);
    const supervisor = runtime.scout;
    if (supervisor === undefined || runtime.record.scout === undefined) {
      throw new RegistryError(
        "INVALID_WORKER_PROFILE",
        `Session ${sessionId} is not a Scout`,
      );
    }
    try {
      return await supervisor.readArtifact(artifact, afterByte, maxBytes);
    } catch (error) {
      throw registryError(error);
    }
  }

  scoutDecisionCard(sessionId: string): ScoutDecisionCard | undefined {
    return this.catalog.requireRuntime(sessionId).scout?.decisionCard();
  }

  /**
   * The sanitized record of the launch or resume the broker actually performed. Purely a read of
   * state captured at spawn time: inspection never rebuilds a spec and never touches the filesystem.
   */
  launchRecord(sessionId: string): ResolvedLaunchRecord | undefined {
    return cloneLaunchRecord(this.catalog.requireRuntime(sessionId).record.launchRecord);
  }

  resolveReattachTarget(sessionId: string): ReattachTarget {
    const runtime = this.catalog.sessions.get(sessionId);
    if (runtime === undefined) return { status: "stale" };
    if (runtime.record.executionState === "active") {
      const record = cloneRecord(runtime.record);
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
        record: cloneRecord(runtime.record),
        requiresResume: true,
      };
    }
    return { status: "stale" };
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
    return this.catalog.requireRuntime(sessionId).turns.projectTruth();
  }

  workerBudgetObservation(sessionId: string): WorkerBudgetObservation {
    const runtime = this.catalog.requireRuntime(sessionId);
    return {
      generation: runtime.record.generation ?? 1,
      canonicalTurns: runtime.turns.canonicalTurns,
      ...(runtime.turns.tokenCount === undefined ? {} : { tokenCount: runtime.turns.tokenCount }),
    };
  }
}
