import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
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

it("waits for another process's open append before checkpointing, retaining its acknowledged mutation", async () => {
  const { root, store, subject } = await fixture();
  const originalInode = (await stat(store.path)).ino;
  const module = new URL("../../src/persistence/journal-exclusivity.ts", import.meta.url).href;
  const envelope = JSON.stringify({ schemaVersion: 1, recordType: "worker-coordination.transaction",
    transactionId: randomUUID(), persistedAt: new Date().toISOString(),
    subjects: [{ ...subject, lease: { ...subject.lease, version: 99 } }] }) + "\n";
  const code = `import {withJournalExclusivity} from ${JSON.stringify(module)};
    import {open} from 'node:fs/promises';
    await withJournalExclusivity(${JSON.stringify(store.path)}, async () => {
      const file = await open(${JSON.stringify(store.path)}, 'a');
      process.send('opened');
      await new Promise(resolve => process.once('message', resolve));
      try { await file.writeFile(${JSON.stringify(envelope)}); await file.sync(); }
      finally { await file.close(); }
      process.send('acknowledged');
    }); process.disconnect();`;
  const child = spawn(process.execPath, ["--no-warnings", "--import", import.meta.resolve("tsx"), "--input-type=module", "-e", code],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let error = "";
  child.stderr!.on("data", (data) => { error += data; });
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("message", (message) => message === "opened" ? resolve() : reject(new Error(String(message))));
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`Writer exited ${code}: ${error}`)));
    });
    const checkpointed = new WorkerCoordinationStore(root, { checkpointBytes: 1 });
    let settled = false;
    const pending = checkpointed.load().finally(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);
    expect((await stat(store.path)).ino).toBe(originalInode);
    child.send("release");
    expect((await pending).subjects[0]?.lease.version).toBe(99);
    expect(await exited, error).toBe(0);
    expect((await store.load()).subjects[0]?.lease.version).toBe(99);
    const archive = (await readdir(join(root, "orchestration"))).find((name) => name.endsWith(".archive"));
    expect(await readFile(join(root, "orchestration", archive!), "utf8")).toContain(envelope);
  } finally { if (child.exitCode === null) { child.kill(); await exited; } }
});

it("blocks an append behind another process and recovers its lock after SIGKILL", async () => {
  const { root, store, subject } = await fixture();
  const module = new URL("../../src/persistence/journal-exclusivity.ts", import.meta.url).href;
  const code = `import {withJournalExclusivity} from ${JSON.stringify(module)};
    await withJournalExclusivity(${JSON.stringify(store.path)}, async () => {
      process.send('locked'); await new Promise(resolve => process.once('message', resolve));
    });`;
  const child = spawn(process.execPath, ["--no-warnings", "--import", import.meta.resolve("tsx"), "--input-type=module", "-e", code],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("message", () => resolve());
      child.once("error", reject);
      child.once("exit", () => reject(new Error("Lock holder exited before acquisition")));
    });
    let settled = false;
    const writer = new WorkerCoordinationStore(root);
    const pending = writer.append({ subjects: [{ ...subject, lease: { ...subject.lease, version: 99 } }] })
      .finally(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);
    child.kill("SIGKILL");
    await exited;
    await pending;
    expect((await store.load()).subjects[0]?.lease.version).toBe(99);
    expect((await stat(`${store.path}.lock.sqlite`)).mode & 0o777).toBe(0o600);
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; } }
});
