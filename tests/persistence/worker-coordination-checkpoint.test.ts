import { randomUUID } from "node:crypto";
import { appendFile, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { WorkerCoordinationStore } from "../../src/persistence/worker-coordination-store.js";
import { OwnershipSubjectSchema, StoredWorkerEventSchema } from "../../src/domain/worker-coordination.js";
import { WorkerHandoffSchema } from "../../src/domain/worker-handoff.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, rename: vi.fn(original.rename), link: vi.fn(original.link) };
});

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cyberdeck-coordination-checkpoint-"));
  roots.push(root);
  const store = new WorkerCoordinationStore(root);
  const workerId = randomUUID(), now = new Date().toISOString();
  const controller = { controllerId: "controller", familyId: "family", scope: { kind: "fleet" as const, scopeId: "fleet" } };
  const subject = OwnershipSubjectSchema.parse({ schemaVersion: 1, subjectId: workerId, subjectKind: "worker",
    origin: { creatorControllerId: controller.controllerId, taskId: "task", threadId: "thread", createdAt: now },
    lifecycle: "working", resources: { sessionId: workerId, eventStreamId: workerId, worktreePath: "/tmp/" + "x".repeat(4096) },
    lease: { leaseId: randomUUID(), version: 1, state: "active", controller, issuedAt: now, renewedAt: now, expiresAt: now }, updatedAt: now });
  const event = StoredWorkerEventSchema.parse({ schemaVersion: 1, eventId: "report:1", sequence: 1, workerId, taskId: "task",
    controllerLeaseVersion: 1, kind: "PROGRESS", severity: "info", interventionRequired: false, summary: "progress",
    continuation: "continuing", timestamp: now, ordinal: 1, receivedAt: now, submissionHash: "a".repeat(64), state: "active" });
  const handoff = WorkerHandoffSchema.parse({ schemaVersion: 1, handoffId: randomUUID(), recipient: controller, issuedBy: controller,
    recipientSessionId: randomUUID(), directive: "continue", manifest: [{ workerId, taskId: "task", lifecycle: "working" }], issuedAt: now, state: "pending" });
  for (let i = 0; i < 16; i++) {
    await store.append({ subjects: [{ ...subject, lease: { ...subject.lease, version: i + 1 } }], events: [event], handoffs: [handoff],
      audits: [{ auditId: randomUUID(), mutationId: `mutation:${i}`, operation: "register", subjectId: workerId, actor: controller,
        occurredAt: now, reason: "fixture", outcome: "REGISTERED" }],
      receipts: [{ mutationId: `mutation:${i}`, operation: "register", recordedAt: now,
        result: { marker: i } }] });
  }
  return { root, store, subject };
}

it("checkpoints automatically without changing replay, audit history, receipts or pending handoffs", async () => {
  const { root, store } = await fixture();
  const original = await readFile(store.path, "utf8");
  const before = await store.load();
  const checkpointed = new WorkerCoordinationStore(root, { checkpointBytes: 1 });
  expect(await checkpointed.load()).toEqual(before);
  expect(await new WorkerCoordinationStore(root).load()).toEqual(before);
  const compacted = await readFile(store.path, "utf8");
  expect(compacted.length).toBeLessThan(original.length * 0.75);
  const ids = (body: string) => body.trim().split("\n").map((line) => JSON.parse(line).transactionId);
  expect(ids(compacted)).toEqual(ids(original));
  const archives = (await readdir(join(root, "orchestration"))).filter((name) => name.endsWith(".archive"));
  expect(archives).toHaveLength(1);
  const archive = join(root, "orchestration", archives[0]!);
  expect(await readFile(archive, "utf8")).toBe(original);
  expect((await stat(archive)).mode & 0o777).toBe(0o600);
  expect((await stat(store.path)).mode & 0o777).toBe(0o600);
  // Checkpointing does not erase the identity used to detect a historical duplicate.
  await appendFile(store.path, original.split("\n")[0]! + "\n");
  await expect(new WorkerCoordinationStore(root).load()).rejects.toMatchObject({ code: "DUPLICATE_TRANSACTION_ID" });
});

it("serializes a checkpoint with appends so the next lease state cannot be lost", async () => {
  const { root, store, subject } = await fixture();
  const checkpointed = new WorkerCoordinationStore(root, { checkpointBytes: 1 });
  const before = await store.load();
  await Promise.all([checkpointed.load(), checkpointed.append({ subjects: [{ ...subject, lease: { ...subject.lease, version: 99 } }] })]);
  const after = await new WorkerCoordinationStore(root).load();
  expect(after.subjects[0]?.lease.version).toBe(99);
  expect(after.receipts).toEqual(before.receipts);
  expect(after.audits).toEqual(before.audits);
});

it("keeps the original authority and reports maintenance failure when checkpoint rename fails", async () => {
  const { root, store } = await fixture();
  const original = await readFile(store.path, "utf8");
  const error = new Error("simulated rename failure");
  vi.spyOn(fs, "rename").mockRejectedValueOnce(error);
  const onCheckpointError = vi.fn();
  const checkpointed = new WorkerCoordinationStore(root, { checkpointBytes: 1, onCheckpointError });
  await expect(checkpointed.load()).resolves.toEqual(await store.load());
  expect(onCheckpointError).toHaveBeenCalledWith(error);
  expect(await readFile(store.path, "utf8")).toBe(original);
  expect((await readdir(join(root, "orchestration"))).some((name) => name.endsWith(".checkpoint"))).toBe(false);
});

it("an acknowledged append remains successful when maintenance fails", async () => {
  const { root, store, subject } = await fixture();
  vi.spyOn(fs, "link").mockRejectedValueOnce(new Error("simulated archive failure"));
  const onCheckpointError = vi.fn();
  const checkpointed = new WorkerCoordinationStore(root, { checkpointBytes: 1, onCheckpointError });
  await expect(checkpointed.append({ subjects: [{ ...subject, lease: { ...subject.lease, version: 99 } }] })).resolves.toBeUndefined();
  expect(onCheckpointError).toHaveBeenCalledOnce();
  expect((await store.load()).subjects[0]?.lease.version).toBe(99);
});
