import type {
  ControllerIdentity,
  OwnershipMutationResult,
  OwnershipSubject,
  WorkerLifecycle,
} from "../../domain/worker-coordination.js";
import type { SessionRecord } from "../../domain/session.js";

export const WORKER_COORDINATION_MIGRATION_ID = "0001-worker-coordination";

export interface LegacyWorkerMigrationResult {
  migrated: number;
  alreadyMigrated: number;
  orphaned: number;
}

export interface LegacyWorkerCoordinationPort {
  getSubject(subjectId: string): OwnershipSubject | undefined;
  registerSubject(input: {
    mutationId: string;
    actor: ControllerIdentity;
    subjectId: string;
    subjectKind?: "worker" | "orchestrator";
    origin: OwnershipSubject["origin"];
    lifecycle: WorkerLifecycle;
    resources: OwnershipSubject["resources"];
    controller?: ControllerIdentity;
    reason: string;
  }): Promise<OwnershipMutationResult>;
}

/**
 * One-time bridge from permanent `parentSessionId` provenance to lease ownership.
 *
 * Caller must resolve a parent session through durable orchestrator binding/scope data. This
 * migration never promotes a conversation UUID into a controller identity. Unresolved parents
 * become orphaned, preserving provenance without granting authority to stale sessions.
 */
export async function migrateLegacyWorkerSessions(input: {
  sessions: readonly SessionRecord[];
  coordination: LegacyWorkerCoordinationPort;
  resolveStableController: (
    parentSessionId: string,
    worker: SessionRecord,
  ) => Promise<ControllerIdentity | undefined>;
  now?: () => string;
}): Promise<LegacyWorkerMigrationResult> {
  const actor: ControllerIdentity = {
    controllerId: "cyberdeck-migration",
    familyId: "cyberdeck-migration",
    scope: { kind: "fleet", scopeId: "local-broker" },
  };
  let migrated = 0;
  let alreadyMigrated = 0;
  let orphaned = 0;
  for (const session of input.sessions) {
    if ((session.kind ?? "worker") !== "worker") continue;
    const existing = input.coordination.getSubject(session.id);
    if (existing !== undefined) {
      alreadyMigrated += 1;
      if (existing.lease.state === "orphaned") orphaned += 1;
      continue;
    }
    const controller = session.parentSessionId === undefined
      ? undefined
      : await input.resolveStableController(session.parentSessionId, session);
    const result = await input.coordination.registerSubject({
      mutationId: `${WORKER_COORDINATION_MIGRATION_ID}:${session.id}`,
      actor,
      subjectId: session.id,
      subjectKind: "worker",
      origin: {
        creatorControllerId: controller?.controllerId ?? "legacy-unresolved",
        ...(session.parentSessionId === undefined
          ? {}
          : { creatorSessionId: session.parentSessionId }),
        taskId: session.id,
        threadId: session.id,
        createdAt: session.createdAt,
      },
      lifecycle: legacyLifecycle(session),
      resources: {
        sessionId: session.id,
        worktreePath: session.cwd,
        transcriptRef: `thread:${session.id}`,
        resultStateRef: `session:${session.id}`,
        eventStreamId: `worker:${session.id}`,
      },
      ...(controller === undefined ? {} : { controller }),
      reason: controller === undefined
        ? "legacy permanent binding unresolved; migrate as orphaned"
        : "legacy permanent binding replaced by stable controller lease",
    });
    if (result.idempotentReplay) alreadyMigrated += 1;
    else migrated += 1;
    if (result.outcomes[0]?.code === "ORPHANED") orphaned += 1;
  }
  return { migrated, alreadyMigrated, orphaned };
}

function legacyLifecycle(session: SessionRecord): WorkerLifecycle {
  if (session.executionState === "starting") return "launching";
  if (session.executionState === "errored" || session.executionState === "failed") return "failed";
  if (session.executionState === "cancelled" || session.executionState === "exited") {
    return session.exitCode === 0 ? "done" : "stopped";
  }
  if (session.attentionState === "working") return "working";
  if (session.attentionState === "needs-input") return "waiting";
  if (session.attentionState === "done") return "done";
  if (session.attentionState === "failed") return "failed";
  if (session.attentionState === "stopped") return "stopped";
  return "queued";
}
