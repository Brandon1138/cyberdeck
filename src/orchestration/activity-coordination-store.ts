import { createHash } from "node:crypto";
import type { WorkerCoordinationRepository } from "../broker/worker-coordination-ports.js";
import type { CoordinationTransaction } from "../domain/worker-coordination-state.js";
import type { OwnershipSubject } from "../domain/worker-coordination.js";
import type { ActivityInput } from "../domain/agent-activity.js";
import type { AgentActivityPort } from "./agent-activity-port.js";

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function eventId(key: string): string {
  const hash = digest(key);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
/** Post-commit projection only. The repository retains the sole atomic authority transaction.
 * Replay repairs the commit-to-activity crash window using stable source keys, without resubmitting
 * any mutation or deriving a controller. Reports remain worker claims, never verified outcomes.
 */
export function activityCoordinationStore(store: WorkerCoordinationRepository, activity: AgentActivityPort): WorkerCoordinationRepository {
  const subjects = new Map<string, OwnershipSubject>();
  async function project(transaction: CoordinationTransaction): Promise<void> {
    for (const subject of transaction.subjects ?? []) subjects.set(subject.subjectId, subject);
    const emit = async (workerId: string, key: string, fields: Pick<ActivityInput, "kind" | "provenance" | "operation" | "occurredAt" | "coordination"> & Partial<ActivityInput>) => {
      const subject = subjects.get(workerId);
      if (subject?.subjectKind === "orchestrator") return;
      const sessionId = subject?.resources.sessionId;
      if (!sessionId) { await activity.noteGap?.().catch(() => undefined); return; }
      await activity.append({ schemaVersion: 1, eventId: eventId(key), sourceKey: key,
        runId: workerId, workerId, sessionId, observedAt: new Date().toISOString(),
        coverage: "complete-for-source", outcome: "observed", ...fields,
      }).catch(() => undefined);
    };
    for (const audit of transaction.audits ?? []) {
      const key = `coordination:audit:${audit.auditId}`;
      await emit(audit.subjectId, key, { kind: audit.operation === "lifecycle" ? "worker.lifecycle" : "worker.control",
        operation: audit.operation === "lifecycle" ? "lifecycle" : "control", provenance: "broker", occurredAt: audit.occurredAt,
        payloadRef: `orchestration/worker-coordination-v1.jsonl#audit=${audit.auditId}`,
        coordination: { auditId: audit.auditId, actor: audit.actor, operation: audit.operation },
      });
    }
    for (const report of transaction.events ?? []) {
      const key = `coordination:report:${report.workerId}:${digest(report.eventId)}:received`;
      await emit(report.workerId, key, { kind: "worker.report", operation: "control", provenance: "worker-report",
        causationId: eventId(key),
        occurredAt: report.timestamp, sourceHash: report.submissionHash,
        payloadRef: `orchestration/worker-coordination-v1.jsonl#report=${encodeURIComponent(report.eventId)}`,
        coordination: { reportId: report.eventId, leaseVersion: report.controllerLeaseVersion, state: "received" },
      });
      if (report.state !== "active") await emit(report.workerId, `${key}:${report.state}`, {
        kind: "worker.control", operation: "control", provenance: "broker", parentEventId: eventId(key),
        causationId: eventId(key),
        ...(report.resolvedAt ? { occurredAt: report.resolvedAt } : {}),
        coordination: { reportId: report.eventId, state: report.state, ...(report.resolvedBy ? { actor: report.resolvedBy } : {}) },
      });
    }
    for (const handoff of transaction.handoffs ?? []) {
      for (const worker of handoff.manifest) {
        const key = `coordination:handoff:${handoff.handoffId}:${worker.workerId}:pending`;
        await emit(worker.workerId, key, { kind: "worker.handoff", operation: "control", provenance: "broker", occurredAt: handoff.issuedAt,
          causationId: handoff.handoffId,
          payloadRef: `orchestration/worker-coordination-v1.jsonl#handoff=${handoff.handoffId}`,
          coordination: { handoffId: handoff.handoffId, state: "pending", actor: handoff.issuedBy, recipient: handoff.recipient },
        });
        if (handoff.state !== "pending") await emit(worker.workerId, `${key}:${handoff.state}`, {
          kind: "worker.handoff", operation: "control", provenance: "broker", parentEventId: eventId(key),
          causationId: handoff.handoffId,
          ...(handoff.acknowledgedAt ?? handoff.consumedAt ? { occurredAt: handoff.acknowledgedAt ?? handoff.consumedAt } : {}),
          coordination: { handoffId: handoff.handoffId, state: handoff.state, recipient: handoff.recipient },
        });
      }
    }
  }
  return {
    append: async (transaction) => {
      await store.append(transaction);
      try { await project(transaction); } catch { await activity.noteGap?.().catch(() => undefined); }
    },
    load: async () => {
      const state = await store.load();
      try { await project(state); } catch { await activity.noteGap?.().catch(() => undefined); }
      return state;
    },
  };
}
