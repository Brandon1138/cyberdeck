import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkerCoordinationRuntime } from "../../src/persistence/worker-coordination-runtime.js";
import type { SessionRecord } from "../../src/domain/session.js";
import type {
  MutationReceipt,
  OwnershipAuditRecord,
  OwnershipSubject,
} from "../../src/domain/worker-coordination.js";
import { OrchestratorStore } from "../../src/persistence/orchestrator-store.js";
import {
  WorkerCoordinationService,
  type WorkerCoordinationOptions,
} from "../../src/broker/worker-coordination.js";
import {
  WorkerCoordinationStore,
  WorkerCoordinationStoreError,
} from "../../src/persistence/worker-coordination-store.js";

const directories: string[] = [];
const NOW = "2026-07-27T10:00:00.000Z";

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "cyberdeck-worker-coordination-store-"));
  directories.push(path);
  return path;
}

function coordinationRuntime(options: {
  stateDirectory: string;
  recoveredSessions?: readonly SessionRecord[];
  orchestrators?: OrchestratorStore;
  service?: Omit<WorkerCoordinationOptions, "store">;
}) {
  const { service, ...runtimeOptions } = options;
  return new WorkerCoordinationRuntime({
    ...runtimeOptions,
    createService: (store) => new WorkerCoordinationService({ store, ...service }),
  });
}

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  const id = crypto.randomUUID();
  return {
    provider: "codex",
    cwd: "/tmp/repo",
    detached: true,
    sandbox: "read-only",
    kind: "worker",
    id,
    generation: 1,
    createdAt: NOW,
    updatedAt: NOW,
    executionState: "active",
    attachmentState: "detached",
    pid: 123,
    exitCode: null,
    childIds: [],
    attentionState: "working",
    ...overrides,
  };
}

describe("WorkerCoordinationStore and migration", () => {
  it("migrates stable primary binding, orphans unresolved parent, and replays idempotently", async () => {
    const stateDirectory = await directory();
    const orchestrators = new OrchestratorStore(stateDirectory);
    const parentSessionId = crypto.randomUUID();
    await orchestrators.put({
      key: "workspace:/tmp/repo",
      kind: "primary",
      sessionId: parentSessionId,
      provider: "codex",
      model: "gpt-5.6-sol",
      cwd: "/tmp/repo",
      sandbox: "read-only",
      scope: { kind: "workspace", cwd: "/tmp/repo" },
      grant: {
        subjectSessionId: parentSessionId,
        capabilities: ["worker.start"],
        scope: { kind: "workspace", cwd: "/tmp/repo" },
      },
      createdAt: NOW,
      updatedAt: NOW,
    });
    const controlled = session({ parentSessionId });
    const unresolved = session({ parentSessionId: crypto.randomUUID() });
    const first = coordinationRuntime({
      stateDirectory,
      recoveredSessions: [controlled, unresolved],
      orchestrators,
      service: { now: () => NOW },
    });
    await expect(first.start()).resolves.toEqual({ migrated: 2, alreadyMigrated: 0, orphaned: 1 });
    expect(first.service.getSubject(controlled.id)).toMatchObject({
      origin: {
        creatorSessionId: parentSessionId,
        creatorControllerId: "orchestrator:workspace:/tmp/repo",
      },
      lease: {
        state: "active",
        controller: { controllerId: "orchestrator:workspace:/tmp/repo" },
      },
    });
    expect(first.service.getSubject(unresolved.id)?.lease.state).toBe("orphaned");
    const stableIdentity = first.service.getSubject(controlled.id)!.lease.controller!;
    await expect(first.service.acquire({
      mutationId: "replacement-process-reacquire",
      actor: stableIdentity,
      selector: { scope: "single", subjectId: controlled.id },
      controller: stableIdentity,
      reason: "conversation cleared; stable controller family returned",
    })).resolves.toMatchObject({
      outcomes: [{
        code: "ALREADY_CONTROLLED",
        leaseVersion: 2,
        leaseToken: expect.any(String),
      }],
    });

    const restarted = coordinationRuntime({
      stateDirectory,
      recoveredSessions: [controlled, unresolved],
      orchestrators,
      service: { now: () => NOW },
    });
    await expect(restarted.start()).resolves.toEqual({ migrated: 0, alreadyMigrated: 2, orphaned: 1 });
  });

  it("does not overwrite immutable origin for a worker already registered by the coordination path", async () => {
    const stateDirectory = await directory();
    const worker = session({ parentSessionId: crypto.randomUUID() });
    const initial = coordinationRuntime({
      stateDirectory,
      service: { now: () => NOW },
    });
    await initial.start();
    const controller = {
      controllerId: "orchestrator:fleet:peer",
      familyId: "orchestrator:fleet:peer",
      scope: { kind: "fleet" as const, scopeId: "fleet:peer" },
    };
    await initial.service.registerSubject({
      mutationId: `worker-reporting:register:${worker.id}`,
      actor: controller,
      subjectId: worker.id,
      origin: {
        creatorControllerId: "orchestrator:fleet:peer",
        creatorSessionId: worker.parentSessionId,
        taskId: worker.id,
        threadId: worker.id,
        createdAt: worker.createdAt,
      },
      lifecycle: "working",
      resources: {
        sessionId: worker.id,
        worktreePath: worker.cwd,
        eventStreamId: `worker:${worker.id}`,
      },
      controller,
      reason: "register worker reporting channel",
    });

    const restarted = coordinationRuntime({
      stateDirectory,
      recoveredSessions: [worker],
      service: { now: () => NOW },
    });
    await expect(restarted.start()).resolves.toEqual({
      migrated: 0,
      alreadyMigrated: 1,
      orphaned: 0,
    });
    expect(restarted.service.getSubject(worker.id)?.origin.creatorControllerId)
      .toBe("orchestrator:fleet:peer");
  });

  it("ignores only an unterminated crash tail", async () => {
    const stateDirectory = await directory();
    const runtime = coordinationRuntime({ stateDirectory, service: { now: () => NOW } });
    await runtime.start();
    await runtime.service.registerSubject({
      mutationId: "crash-tail-fixture",
      actor: {
        controllerId: "migration",
        familyId: "migration",
        scope: { kind: "fleet", scopeId: "test" },
      },
      subjectId: crypto.randomUUID(),
      origin: {
        creatorControllerId: "migration",
        taskId: "task",
        threadId: "thread",
        createdAt: NOW,
      },
      lifecycle: "queued",
      resources: { eventStreamId: "stream" },
      reason: "fixture",
    });
    await appendFile(runtime.store.path, '{"schemaVersion":1', "utf8");

    await expect(new WorkerCoordinationStore(stateDirectory).load()).resolves.toMatchObject({
      subjects: expect.arrayContaining([expect.objectContaining({ lifecycle: "queued" })]),
    });
  });

  it("fails closed on unsupported versions and duplicate transaction ids", async () => {
    const stateDirectory = await directory();
    const runtime = coordinationRuntime({ stateDirectory, service: { now: () => NOW } });
    await runtime.start();
    await runtime.service.registerSubject({
      mutationId: "version-fixture",
      actor: {
        controllerId: "migration",
        familyId: "migration",
        scope: { kind: "fleet", scopeId: "test" },
      },
      subjectId: crypto.randomUUID(),
      origin: {
        creatorControllerId: "migration",
        taskId: "task",
        threadId: "thread",
        createdAt: NOW,
      },
      lifecycle: "queued",
      resources: { eventStreamId: "stream" },
      reason: "fixture",
    });
    const original = await readFile(runtime.store.path, "utf8");
    await writeFile(runtime.store.path, original.replace('"schemaVersion":1', '"schemaVersion":2'));
    await expect(new WorkerCoordinationStore(stateDirectory).load()).rejects.toEqual(
      expect.objectContaining<Partial<WorkerCoordinationStoreError>>({
        code: "SCHEMA_VERSION_UNSUPPORTED",
      }),
    );

    await writeFile(runtime.store.path, original + original);
    await expect(new WorkerCoordinationStore(stateDirectory).load()).rejects.toEqual(
      expect.objectContaining<Partial<WorkerCoordinationStoreError>>({
        code: "DUPLICATE_TRANSACTION_ID",
      }),
    );
  });
});

function subjectRecord(overrides: Partial<OwnershipSubject> = {}): OwnershipSubject {
  const subjectId = crypto.randomUUID();
  return {
    schemaVersion: 1,
    subjectId,
    subjectKind: "worker",
    origin: {
      creatorControllerId: "orchestrator:fleet",
      taskId: "task-1",
      threadId: "thread-1",
      createdAt: NOW,
    },
    lifecycle: "working",
    resources: { eventStreamId: subjectId },
    lease: {
      leaseId: crypto.randomUUID(),
      version: 1,
      state: "active",
      controller: {
        controllerId: "orchestrator:fleet",
        familyId: "orchestrator:fleet",
        scope: { kind: "fleet", scopeId: "fleet" },
      },
      issuedAt: NOW,
      renewedAt: NOW,
      expiresAt: NOW,
    },
    decisionGate: { state: "none" },
    updatedAt: NOW,
    ...overrides,
  };
}

function auditRecord(subjectId: string, index: number): OwnershipAuditRecord {
  return {
    auditId: crypto.randomUUID(),
    mutationId: `mutation-${index}`,
    operation: "acquire",
    subjectId,
    actor: {
      controllerId: "orchestrator:fleet",
      familyId: "orchestrator:fleet",
      scope: { kind: "fleet", scopeId: "fleet" },
    },
    occurredAt: NOW,
    reason: `audit ${index}`,
    outcome: "ACQUIRED",
  };
}

function receiptRecord(index: number): MutationReceipt {
  return {
    mutationId: `mutation-${index}`,
    operation: "acquire",
    recordedAt: new Date(Date.parse(NOW) + index * 1000).toISOString(),
    result: { index },
  };
}

describe("WorkerCoordinationStore compaction", () => {
  it("folds the log to one record, bounds receipts, and archives audits", async () => {
    const stateDirectory = await directory();
    const store = new WorkerCoordinationStore(stateDirectory, {
      compactionThresholdBytes: 1,
      retainedReceipts: 3,
    });
    const subject = subjectRecord();
    // The same subject rewritten each round: the fold must keep only the last version of it.
    for (let index = 0; index < 10; index += 1) {
      await store.append({
        subjects: [{ ...subject, lifecycle: index === 9 ? "done" : "working", updatedAt: NOW }],
        audits: [auditRecord(subject.subjectId, index)],
        receipts: [receiptRecord(index)],
      });
    }
    const before = await store.load();
    expect(before.subjects).toHaveLength(1);
    expect(before.audits).toHaveLength(10);
    expect(before.receipts).toHaveLength(10);

    const result = await store.compactIfLarge();
    expect(result.compacted).toBe(true);
    expect(result.records).toBe(10);
    expect(result.archivedAudits).toBe(10);
    expect(result.afterBytes).toBeLessThan(result.beforeBytes);

    // One physical record now, and it replays to the same live state.
    const raw = await readFile(store.path, "utf8");
    expect(raw.trimEnd().split("\n")).toHaveLength(1);
    const after = await store.load();
    expect(after.subjects).toEqual(before.subjects);
    expect(after.subjects[0]!.lifecycle).toBe("done");
    expect(after.receipts.map((receipt) => receipt.mutationId))
      .toEqual(["mutation-7", "mutation-8", "mutation-9"]);
    expect(after.audits).toEqual([]);

    const archived = (await readFile(store.auditArchivePath, "utf8")).trimEnd().split("\n");
    expect(archived).toHaveLength(10);
    expect(JSON.parse(archived[0]!).reason).toBe("audit 0");

    // Appends after a compaction still fold onto the compacted base.
    await store.append({ subjects: [{ ...subject, lifecycle: "stopped", updatedAt: NOW }] });
    await expect(store.load().then((state) => state.subjects[0]!.lifecycle)).resolves.toBe("stopped");
  });

  it("leaves a log below the threshold untouched", async () => {
    const stateDirectory = await directory();
    const store = new WorkerCoordinationStore(stateDirectory, {
      compactionThresholdBytes: 64 * 1024 * 1024,
    });
    await store.append({ subjects: [subjectRecord()] });
    const original = await readFile(store.path, "utf8");
    const result = await store.compactIfLarge();
    expect(result.compacted).toBe(false);
    expect(result.archivedAudits).toBe(0);
    await expect(readFile(store.path, "utf8")).resolves.toBe(original);
  });

  it("reads a log whose final record was lost to a crash", async () => {
    const stateDirectory = await directory();
    const store = new WorkerCoordinationStore(stateDirectory);
    const subject = subjectRecord();
    await store.append({ subjects: [subject] });
    // A torn tail: bytes with no terminating newline are not a record yet.
    await appendFile(store.path, '{"schemaVersion":1,"recordType":"worker-coord');
    const state = await store.load();
    expect(state.subjects).toHaveLength(1);
    expect(state.subjects[0]!.subjectId).toBe(subject.subjectId);
  });
});
