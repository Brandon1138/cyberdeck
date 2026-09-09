import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { activityCoordinationStore } from "../../src/orchestration/activity-coordination-store.js";
import { AgentActivityStore } from "../../src/persistence/agent-activity-store.js";
import { WorkerCoordinationStore } from "../../src/persistence/worker-coordination-store.js";
import { OwnershipSubjectSchema, StoredWorkerEventSchema } from "../../src/domain/worker-coordination.js";
import { WorkerHandoffSchema } from "../../src/domain/worker-handoff.js";
import type { CoordinationTransaction } from "../../src/domain/worker-coordination-state.js";
import { correlationIds, projectActivity } from "../../src/observability/activity-projection.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "cyberdeck-coordination-activity-")); roots.push(root);
  const activity = await AgentActivityStore.open(join(root, "activity"));
  const durable = new WorkerCoordinationStore(root);
  return { root, activity, durable, projected: activityCoordinationStore(durable, activity) };
}
function fixture() {
  const workerId = randomUUID(), sessionId = randomUUID(), now = new Date().toISOString();
  const actor = { controllerId: "controller:primary", familyId: "family:primary", scope: { kind: "fleet" as const, scopeId: "fleet" } };
  const recipient = { ...actor, controllerId: "controller:peer" };
  const subject = OwnershipSubjectSchema.parse({ schemaVersion: 1, subjectId: workerId, subjectKind: "worker",
    origin: { creatorControllerId: actor.controllerId, taskId: "fixture", threadId: "fixture", createdAt: now }, lifecycle: "working",
    resources: { sessionId, eventStreamId: workerId }, updatedAt: now,
    lease: { leaseId: randomUUID(), version: 2, state: "active", controller: recipient, issuedAt: now, renewedAt: now, expiresAt: now } });
  const report = StoredWorkerEventSchema.parse({ schemaVersion: 1, eventId: "worker-report:1", sequence: 1, workerId, taskId: "fixture",
    controllerLeaseVersion: 2, kind: "PROGRESS", severity: "info", interventionRequired: false,
    summary: "SYNTHETIC_COMPLETION_CLAIM", continuation: "continuing", timestamp: now, ordinal: 1, receivedAt: now,
    submissionHash: "a".repeat(64), state: "active" });
  const handoff = WorkerHandoffSchema.parse({ schemaVersion: 1, handoffId: randomUUID(), recipient, issuedBy: actor,
    recipientSessionId: randomUUID(), directive: "SYNTHETIC_DIRECTIVE", manifest: [{ workerId, taskId: "fixture", lifecycle: "working" }], issuedAt: now, state: "pending" });
  const audit = { auditId: randomUUID(), mutationId: "handoff-mutation", operation: "handoff" as const, subjectId: workerId,
    actor, occurredAt: now, reason: "SYNTHETIC_REASON", outcome: "TRANSFERRED" };
  const transaction: CoordinationTransaction = { subjects: [subject], audits: [audit], events: [report], handoffs: [handoff] };
  return { workerId, sessionId, now, subject, report, handoff, audit, transaction };
}

it("projects acknowledged reports and handoffs, with canonical actors and replay deduplication", async () => {
  const { root, activity, durable, projected } = await setup(), f = fixture();
  try {
    await projected.append(f.transaction);
    const first = await activity.readSession(f.sessionId, 0, 100);
    expect(first.map((event) => event.kind)).toEqual(["worker.control", "worker.report", "worker.handoff"]);
    expect(first[0]?.coordination?.actor).toEqual(f.audit.actor);
    expect(first[1]).toMatchObject({ provenance: "worker-report", outcome: "observed", sourceHash: f.report.submissionHash });
    expect(first.every((event) => event.workerId === f.workerId && event.sessionId === f.sessionId && event.generation === undefined)).toBe(true);
    expect(JSON.stringify(first)).not.toContain("SYNTHETIC_");
    await projected.append({ handoffs: [{ ...f.handoff, state: "acknowledged", acknowledgedAt: f.now }] });
    const before = await activity.readSession(f.sessionId, 0, 100);
    expect(before).toHaveLength(4);
    expect(before[3]).toMatchObject({ parentEventId: first[2]!.eventId, coordination: { state: "acknowledged" } });
    expect(correlationIds(projectActivity(before[3]!)).traceId).toBe(correlationIds(projectActivity(first[2]!)).traceId);
    expect((await durable.load()).handoffs[0]?.state).toBe("acknowledged");
    await activity.close();
    const reopened = await AgentActivityStore.open(join(root, "activity"));
    try {
      await activityCoordinationStore(new WorkerCoordinationStore(root), reopened).load();
      expect(await reopened.readSession(f.sessionId, 0, 100)).toEqual(before);
    } finally { await reopened.close(); }
  } catch (error) { await activity.close().catch(() => {}); throw error; }
});

it("repairs a crash after coordination commit, and recorder failure never rolls back authority", async () => {
  const { activity, durable } = await setup(), f = fixture();
  try {
    const append = vi.fn(async () => { throw new Error("DISK_FAILURE"); });
    const projected = activityCoordinationStore(durable, { append, read: async () => [], health: () => ({ degraded: true, dropped: 1, retained: 0 }) });
    await expect(projected.append(f.transaction)).resolves.toBeUndefined();
    expect((await durable.load()).subjects[0]?.lease.controller).toEqual(f.subject.lease.controller);
    expect(await activity.readSession(f.sessionId, 0, 100)).toEqual([]);
    await activityCoordinationStore(durable, activity).load();
    expect(await activity.readSession(f.sessionId, 0, 100)).toHaveLength(3);
    const never = vi.fn(activity.append.bind(activity));
    const refused = activityCoordinationStore({ load: () => durable.load(), append: async () => { throw new Error("COMMIT_FAILED"); } }, { ...activity, append: never, read: activity.read.bind(activity), health: activity.health.bind(activity) });
    await expect(refused.append(f.transaction)).rejects.toThrow("COMMIT_FAILED");
    expect(never).not.toHaveBeenCalled();
  } finally { await activity.close(); }
});

it("records a durable coverage gap instead of inventing a missing session mapping", async () => {
  const { activity, projected } = await setup(), f = fixture();
  try {
    await projected.append({ ...f.transaction, subjects: [{ ...f.subject, resources: { eventStreamId: f.workerId } }] });
    expect(await activity.read(f.workerId, 0, 100)).toEqual([]);
    expect(activity.health()).toMatchObject({ degraded: true, dropped: 3 });
  } finally { await activity.close(); }
});
