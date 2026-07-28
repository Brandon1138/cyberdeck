import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkerCoordinationRuntime } from "../../src/broker/worker-coordination-runtime.js";
import type { SessionRecord } from "../../src/domain/session.js";
import { OrchestratorStore } from "../../src/persistence/orchestrator-store.js";
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
    const first = new WorkerCoordinationRuntime({
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

    const restarted = new WorkerCoordinationRuntime({
      stateDirectory,
      recoveredSessions: [controlled, unresolved],
      orchestrators,
      service: { now: () => NOW },
    });
    await expect(restarted.start()).resolves.toEqual({ migrated: 0, alreadyMigrated: 2, orphaned: 1 });
  });

  it("ignores only an unterminated crash tail", async () => {
    const stateDirectory = await directory();
    const runtime = new WorkerCoordinationRuntime({ stateDirectory, service: { now: () => NOW } });
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
    const runtime = new WorkerCoordinationRuntime({ stateDirectory, service: { now: () => NOW } });
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
