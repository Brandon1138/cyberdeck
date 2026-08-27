import type { ResolvedLaunchRecord, SessionRecord } from "../../domain/session.js";
import { RegistryError, type RuntimeSession, type SessionTreeProgress } from "./session-registry-ports.js";
import { ScoutSupervisionError } from "./scout-session-supervisor.js";
import { SessionWorkspaceError } from "./session-workspace-coordinator.js";

/**
 * Reading a session record out, and reading one back in.
 *
 * Nothing here touches registry state: a projection is a function of the record it is handed, which
 * is what makes it safe to hand the same record to a caller, a durable store, and a recovery pass
 * without any of them observing another's edits.
 */

export function cloneRecord(record: SessionRecord): SessionRecord {
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

export function cloneLaunchRecord(record: ResolvedLaunchRecord | undefined): ResolvedLaunchRecord | undefined {
  if (record === undefined) return undefined;
  return { ...record, args: [...record.args], cyberdeckEnv: { ...record.cyberdeckEnv } };
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
export function recoverRecord(stored: SessionRecord): SessionRecord {
  const record = cloneRecord(stored);
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

export function compareDisplayOrder(left: SessionRecord, right: SessionRecord): number {
  if (left.pinned !== right.pinned) return left.pinned === true ? -1 : 1;
  const leftOrder = left.displayOrder ?? Number.MAX_SAFE_INTEGER;
  const rightOrder = right.displayOrder ?? Number.MAX_SAFE_INTEGER;
  if (leftOrder !== rightOrder) return leftOrder - rightOrder;
  return (right.meaningfulUpdatedAt ?? right.updatedAt).localeCompare(left.meaningfulUpdatedAt ?? left.updatedAt);
}

export function progressForTree(tree: readonly RuntimeSession[]): SessionTreeProgress {
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

export function scoutLaunchError(sessionId: string, error: unknown): RegistryError {
  return new RegistryError(
    "SCOUT_LAUNCH_FAILED",
    `Scout ${sessionId} failed to launch: ${errorMessage(error)}`,
    sessionId,
  );
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Re-words a workspace refusal as the registry's own error, keeping the code and the message the
 * coordinator chose. The coordinator names what is wrong with a workspace; only `RegistryError`
 * carries a code the broker's RPC boundary knows how to report, so anything else is rethrown as-is.
 */
export function registryError(error: unknown): unknown {
  return error instanceof SessionWorkspaceError || error instanceof ScoutSupervisionError
    ? new RegistryError(error.code, error.message)
    : error;
}
