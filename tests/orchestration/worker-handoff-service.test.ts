import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkerCoordinationService } from "../../src/broker/worker-coordination.js";
import { BrokerWorkerLeaseCredentialCustodian } from "../../src/broker/worker-lease-credential-custodian.js";
import type { OrchestratorBinding } from "../../src/domain/orchestrator.js";
import { orchestratorController } from "../../src/domain/orchestrator.js";
import type { WorkerLifecycle } from "../../src/domain/worker-coordination.js";
import {
  WorkerHandoffError,
  WorkerHandoffService,
} from "../../src/orchestration/worker-handoff-service.js";
import { WorkerCoordinationStore } from "../../src/persistence/worker-coordination-store.js";

const baseMs = Date.parse("2026-08-18T10:00:00.000Z");
const ORC = "11111111-1111-4111-8111-111111111111";
const PEER = "44444444-4444-4444-8444-444444444444";
const PEER_KEY = "fleet:peer:99999999-9999-4999-8999-999999999999";
const WORKSPACE_ORC = "77777777-7777-4777-8777-777777777777";
const STOPPED_ORC = "22222222-2222-4222-8222-222222222222";
const UNBOUND_ORC = "66666666-6666-4666-8666-666666666666";
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function binding(sessionId: string, key: string, workspaceCwd?: string): OrchestratorBinding {
  const scope = workspaceCwd === undefined
    ? { kind: "fleet" as const }
    : { kind: "workspace" as const, cwd: workspaceCwd };
  return {
    key,
    kind: key.includes(":peer:") ? "peer" : "primary",
    sessionId,
    provider: "codex",
    cwd: "/repo",
    sandbox: "read-only",
    scope,
    grant: {
      subjectSessionId: sessionId,
      capabilities: ["thread.read", "thread.enqueue", "worker.start"],
      scope,
    },
    createdAt: new Date(baseMs).toISOString(),
    updatedAt: new Date(baseMs).toISOString(),
  };
}

interface FakeSession {
  id: string;
  kind: "worker" | "orchestrator";
  name?: string;
  cwd: string;
  createdAt: string;
  executionState: string;
  attentionState?: string;
  exitCode: number | null;
  parentSessionId?: string;
}

async function harness(options: { enqueue?: () => Promise<unknown> } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "cyberdeck-worker-handoff-"));
  directories.push(directory);
  const nowMs = baseMs;
  const coordination = new WorkerCoordinationService({
    store: new WorkerCoordinationStore(directory),
    now: () => new Date(nowMs).toISOString(),
    leaseDurationMs: 30_000,
    gracePeriodMs: 5_000,
  });
  await coordination.initialize();

  const sessions = new Map<string, FakeSession>();
  const bindings = new Map<string, OrchestratorBinding>([
    [ORC, binding(ORC, "fleet")],
    [PEER, binding(PEER, PEER_KEY)],
    [WORKSPACE_ORC, binding(WORKSPACE_ORC, "workspace:/repo/in-scope", "/repo/in-scope")],
    [STOPPED_ORC, binding(STOPPED_ORC, "workspace:/stopped")],
  ]);
  const enqueued: Array<{ targetSessionId: string; message: string }> = [];
  const instructions = {
    enqueue: vi.fn(async (input: { targetSessionId: string; message: string }) => {
      if (options.enqueue !== undefined) return options.enqueue() as never;
      enqueued.push({ targetSessionId: input.targetSessionId, message: input.message });
      return { id: randomUUID(), status: "queued" };
    }),
  };
  const credentials = new BrokerWorkerLeaseCredentialCustodian();

  const addSession = (input: Partial<FakeSession> = {}): string => {
    const id = input.id ?? randomUUID();
    sessions.set(id, {
      id,
      kind: "worker",
      cwd: "/repo/worktrees/w",
      createdAt: new Date(baseMs).toISOString(),
      executionState: "active",
      attentionState: "working",
      exitCode: null,
      ...input,
    });
    return id;
  };
  addSession({ id: ORC, kind: "orchestrator", name: "primary orc" });
  addSession({ id: PEER, kind: "orchestrator", name: "peer orc" });
  addSession({
    id: WORKSPACE_ORC,
    kind: "orchestrator",
    name: "workspace orc",
    cwd: "/repo/in-scope",
  });
  addSession({ id: STOPPED_ORC, kind: "orchestrator", executionState: "exited", exitCode: 0 });

  const registry = {
    get(sessionId: string): FakeSession {
      const record = sessions.get(sessionId);
      if (record === undefined) {
        throw Object.assign(new Error(`No session ${sessionId}`), { code: "SESSION_NOT_FOUND" });
      }
      return record;
    },
  };

  return {
    coordination,
    credentials,
    instructions,
    enqueued,
    sessions,
    addSession,
    handoff: new WorkerHandoffService({
      coordination,
      registry: registry as never,
      orchestrators: { findBySessionId: async (id: string) => bindings.get(id) } as never,
      instructions: instructions as never,
      credentials,
    }),
    async register(input: {
      workerId?: string;
      controllerId?: string;
      lifecycle?: WorkerLifecycle;
    } = {}) {
      const workerId = input.workerId ?? randomUUID();
      await coordination.registerSubject({
        mutationId: `register:${workerId}`,
        actor: { controllerId: "test", familyId: "test", scope: { kind: "fleet", scopeId: "test" } },
        subjectId: workerId,
        origin: {
          creatorControllerId: input.controllerId ?? "test",
          taskId: `task:${workerId}`,
          threadId: `thread:${workerId}`,
          createdAt: new Date(baseMs).toISOString(),
        },
        lifecycle: input.lifecycle ?? "working",
        resources: {
          sessionId: workerId,
          worktreePath: "/repo/worktrees/w",
          transcriptRef: `thread:${workerId}`,
          resultStateRef: `session:${workerId}`,
          eventStreamId: `worker:${workerId}`,
        },
        ...(input.controllerId === undefined
          ? {}
          : {
            controller: {
              controllerId: input.controllerId,
              familyId: input.controllerId,
              scope: { kind: "fleet" as const, scopeId: "other" },
            },
          }),
        reason: "test registration",
      });
      return workerId;
    },
  };
}

describe("WorkerHandoffService", () => {
  it("moves a batch onto a live orchestrator and briefs it with the directive", async () => {
    const bench = await harness();
    const first = bench.addSession({ name: "docs sweep" });
    const second = bench.addSession({ name: "test sweep" });
    await bench.register({ workerId: first, controllerId: "orchestrator:workspace:/other" });
    await bench.register({ workerId: second, controllerId: "orchestrator:workspace:/other" });

    const result = await bench.handoff.handoff({
      recipientSessionId: ORC,
      workerIds: [first, second],
      directive: "Rebase both onto main, then report",
    });

    expect(result.committed).toBe(true);
    expect(result.blocked).toEqual([]);
    expect(result.transferred.map((entry) => entry.code)).toEqual(["TRANSFERRED", "TRANSFERRED"]);
    expect(result.recipientControllerId).toBe("orchestrator:fleet");
    expect(result.delivery).toBe("pending");
    const expected = orchestratorController(binding(ORC, "fleet"));
    for (const workerId of [first, second]) {
      expect(bench.coordination.getSubject(workerId)?.lease.controller).toEqual(expected);
      // Without custody of the fenced token the recipient's next worker_ctl call would report
      // OWNERSHIP_LOST on a lease it does hold.
      expect(bench.credentials.get("orchestrator:fleet", workerId)).toBeDefined();
    }
    expect(bench.enqueued).toHaveLength(1);
    expect(bench.enqueued[0]!.targetSessionId).toBe(ORC);
    expect(bench.enqueued[0]!.message).toContain("Rebase both onto main, then report");
    expect(bench.enqueued[0]!.message).toContain("docs sweep");
  });

  it("hands a peer binding a batch on the same terms as a primary", async () => {
    const bench = await harness();
    const workerId = bench.addSession();
    await bench.register({ workerId });

    const result = await bench.handoff.handoff({
      recipientSessionId: PEER,
      workerIds: [workerId],
      directive: "You own this one now",
    });

    expect(result.committed).toBe(true);
    // A peer is a controller in its own right, inside its primary's family.
    expect(result.recipientControllerId).toBe(`orchestrator:${PEER_KEY}`);
    expect(bench.coordination.getSubject(workerId)?.lease.controller).toEqual({
      controllerId: `orchestrator:${PEER_KEY}`,
      familyId: "orchestrator:fleet",
      scope: { kind: "fleet", scopeId: PEER_KEY },
    });
  });

  it("rejects an out-of-scope member atomically before any lease is transferred", async () => {
    const bench = await harness();
    const inScope = bench.addSession({ cwd: "/repo/in-scope" });
    const outOfScope = bench.addSession({ cwd: "/repo/out-of-scope" });
    const priorControllerId = "orchestrator:workspace:/prior";
    await bench.register({ workerId: inScope, controllerId: priorControllerId });
    await bench.register({ workerId: outOfScope, controllerId: priorControllerId });

    await expect(bench.handoff.handoff({
      recipientSessionId: WORKSPACE_ORC,
      workerIds: [inScope, outOfScope],
      directive: "Take both or neither",
    })).rejects.toMatchObject({
      name: "WorkerHandoffError",
      code: "RECIPIENT_SCOPE_VIOLATION",
      offendingWorkerIds: [outOfScope],
      recipientScope: { kind: "workspace", cwd: "/repo/in-scope" },
    });

    for (const workerId of [inScope, outOfScope]) {
      const lease = bench.coordination.getSubject(workerId)?.lease;
      expect(lease?.controller?.controllerId).toBe(priorControllerId);
      expect(lease?.version).toBe(1);
    }
    expect(bench.coordination.listHandoffs()).toEqual([]);
    expect(bench.instructions.enqueue).not.toHaveBeenCalled();
  });

  it("hands a workspace-scoped recipient an all-in-scope batch", async () => {
    const bench = await harness();
    const first = bench.addSession({ cwd: "/repo/in-scope" });
    const second = bench.addSession({ cwd: "/repo/in-scope" });
    await bench.register({ workerId: first, controllerId: "orchestrator:workspace:/prior" });
    await bench.register({ workerId: second, controllerId: "orchestrator:workspace:/prior" });

    const result = await bench.handoff.handoff({
      recipientSessionId: WORKSPACE_ORC,
      workerIds: [first, second],
      directive: "Take both",
    });

    expect(result.committed).toBe(true);
    expect(result.transferred.map((entry) => entry.workerId)).toEqual([first, second]);
    for (const workerId of [first, second]) {
      expect(bench.coordination.getSubject(workerId)?.lease.controller?.controllerId)
        .toBe("orchestrator:workspace:/repo/in-scope");
    }
  });

  it("lets a fleet-scoped recipient accept workers from any workspace", async () => {
    const bench = await harness();
    const first = bench.addSession({ cwd: "/repo/one" });
    const second = bench.addSession({ cwd: "/repo/two" });
    await bench.register({ workerId: first });
    await bench.register({ workerId: second });

    const result = await bench.handoff.handoff({
      recipientSessionId: ORC,
      workerIds: [first, second],
      directive: "Take cross-workspace batch",
    });

    expect(result.committed).toBe(true);
    expect(result.transferred.map((entry) => entry.workerId)).toEqual([first, second]);
  });

  it("hands off a worker the operator started by hand, registering it in the same transaction", async () => {
    const bench = await harness();
    const manual = bench.addSession({ name: "hand-started", cwd: "/repo" });

    const result = await bench.handoff.handoff({
      recipientSessionId: ORC,
      workerIds: [manual],
      directive: "Take my manual worker",
    });

    expect(result.committed).toBe(true);
    expect(result.transferred[0]!.code).toBe("ACQUIRED");
    expect(result.transferred[0]!.priorControllerId).toBeUndefined();
    const subject = bench.coordination.getSubject(manual)!;
    expect(subject.lease.controller?.controllerId).toBe("orchestrator:fleet");
    expect(subject.origin.creatorControllerId).toBe("legacy-unresolved");
    expect(subject.resources.worktreePath).toBe("/repo");
    expect(bench.enqueued[0]!.message).toContain("previously operator-held");
  });

  it("refuses a recipient session that holds no orchestrator binding", async () => {
    const bench = await harness();
    const workerId = bench.addSession();
    await bench.register({ workerId });
    bench.addSession({ id: UNBOUND_ORC, kind: "orchestrator" });

    await expect(bench.handoff.handoff({
      recipientSessionId: UNBOUND_ORC,
      workerIds: [workerId],
      directive: "nobody home",
    })).rejects.toMatchObject({ code: "RECIPIENT_UNBOUND" });
    expect(bench.coordination.getSubject(workerId)?.lease.version).toBe(1);
  });

  it("refuses a recipient that has stopped rather than stranding the workers on it", async () => {
    const bench = await harness();
    const workerId = bench.addSession();
    await bench.register({ workerId });

    await expect(bench.handoff.handoff({
      recipientSessionId: STOPPED_ORC,
      workerIds: [workerId],
      directive: "take it",
    })).rejects.toBeInstanceOf(WorkerHandoffError);
    expect(bench.coordination.getSubject(workerId)?.lease.controller).toBeUndefined();
  });

  it("refuses to hand an orchestrator to itself", async () => {
    const bench = await harness();
    await expect(bench.handoff.handoff({
      recipientSessionId: ORC,
      workerIds: [ORC],
      directive: "eat yourself",
    })).rejects.toMatchObject({ code: "RECIPIENT_IS_TARGET" });
  });

  it("blocks the whole batch on an unknown worker without touching the rest", async () => {
    const bench = await harness();
    const known = bench.addSession();
    await bench.register({ workerId: known });
    const ghost = randomUUID();

    const result = await bench.handoff.handoff({
      recipientSessionId: ORC,
      workerIds: [known, ghost],
      directive: "take both",
    });

    expect(result.committed).toBe(false);
    expect(result.delivery).toBe("not-attempted");
    expect(result.transferred).toEqual([]);
    expect(result.blocked).toEqual([{
      workerId: ghost,
      code: "WORKER_UNKNOWN",
      detail: "The broker holds neither a session nor a lease record for this worker",
    }]);
    expect(bench.coordination.getSubject(known)?.lease.version).toBe(1);
    expect(bench.instructions.enqueue).not.toHaveBeenCalled();
  });

  it("blocks a batch naming another orchestrator as a worker", async () => {
    const bench = await harness();
    const worker = bench.addSession();
    await bench.register({ workerId: worker });

    const result = await bench.handoff.handoff({
      recipientSessionId: ORC,
      workerIds: [worker, PEER],
      directive: "take both",
    });

    expect(result.committed).toBe(false);
    expect(result.blocked).toEqual([{
      workerId: PEER,
      code: "NOT_A_WORKER",
      detail: "An orchestrator is a controller, not a worker to be handed off",
    }]);
    expect(bench.coordination.getSubject(worker)?.lease.version).toBe(1);
  });

  it("aborts atomically when the substrate refuses one member as terminal", async () => {
    const bench = await harness();
    const healthy = bench.addSession();
    const finished = bench.addSession();
    await bench.register({ workerId: healthy, controllerId: "orchestrator:workspace:/other" });
    await bench.register({ workerId: finished, lifecycle: "done" });

    const result = await bench.handoff.handoff({
      recipientSessionId: ORC,
      workerIds: [healthy, finished],
      directive: "take the wave",
    });

    expect(result.committed).toBe(false);
    expect(result.transferred).toEqual([]);
    expect(result.blocked.find((entry) => entry.workerId === finished)?.code).toBe("WORKER_TERMINAL");
    expect(bench.coordination.getSubject(healthy)?.lease.controller?.controllerId)
      .toBe("orchestrator:workspace:/other");
    expect(bench.coordination.listHandoffs()).toEqual([]);
    expect(bench.instructions.enqueue).not.toHaveBeenCalled();
  });

  it("blocks a batch that names one worker twice before any lease moves", async () => {
    const bench = await harness();
    const workerId = bench.addSession();
    await bench.register({ workerId });

    const result = await bench.handoff.handoff({
      recipientSessionId: ORC,
      workerIds: [workerId, workerId],
      directive: "twice",
    });

    expect(result.committed).toBe(false);
    expect(result.blocked).toEqual([{
      workerId,
      code: "DUPLICATE",
      detail: "Worker named twice in one handoff",
    }]);
    expect(bench.coordination.getSubject(workerId)?.lease.version).toBe(1);
  });

  it("reports a committed transfer whose nudge failed rather than losing the transfer", async () => {
    const bench = await harness({
      enqueue: async () => {
        throw new Error("composer is not accepting instructions");
      },
    });
    const workerId = bench.addSession();
    await bench.register({ workerId });

    const result = await bench.handoff.handoff({
      recipientSessionId: ORC,
      workerIds: [workerId],
      directive: "take it",
    });

    expect(result.committed).toBe(true);
    expect(result.delivery).toBe("failed");
    expect(result.deliveryDetail).toBe("composer is not accepting instructions");
    // The lease still moved, and the durable record is still there to be collected.
    expect(bench.coordination.getSubject(workerId)?.lease.controller?.controllerId)
      .toBe("orchestrator:fleet");
    expect(bench.coordination.listHandoffs({ state: "pending" })).toHaveLength(1);
  });

  it("replays a repeated mutation id instead of transferring twice", async () => {
    const bench = await harness();
    const workerId = bench.addSession();
    await bench.register({ workerId, controllerId: "orchestrator:workspace:/other" });
    const request = {
      recipientSessionId: ORC,
      workerIds: [workerId],
      directive: "take it once",
      mutationId: "operator-handoff-1",
    };

    const first = await bench.handoff.handoff(request);
    const second = await bench.handoff.handoff(request);

    expect(second.handoffId).toBe(first.handoffId);
    expect(bench.coordination.getSubject(workerId)?.lease.version).toBe(2);
  });
});
