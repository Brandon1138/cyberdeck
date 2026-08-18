import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkerCoordinationService } from "../../src/broker/worker-coordination.js";
import type { OrchestratorBinding } from "../../src/domain/orchestrator.js";
import type { WorkerLifecycle } from "../../src/domain/worker-coordination.js";
import { WorkerControlService } from "../../src/orchestration/worker-control-service.js";
import { WorkerCoordinationStore } from "../../src/persistence/worker-coordination-store.js";

const baseMs = Date.parse("2026-07-27T10:00:00.000Z");
const ORC = "11111111-1111-4111-8111-111111111111";
const OTHER_ORC = "33333333-3333-4333-8333-333333333333";
const PEER = "44444444-4444-4444-8444-444444444444";
const PEER_KEY = "fleet:peer:99999999-9999-4999-8999-999999999999";
const PEER_CONTROLLER_ID = `orchestrator:${PEER_KEY}`;
const UNBOUND = "66666666-6666-4666-8666-666666666666";
const ELSEWHERE = "55555555-5555-4555-8555-555555555555";
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function binding(sessionId: string, key: string, workspaceCwd?: string): OrchestratorBinding {
  const scope = workspaceCwd === undefined
    ? { kind: "workspace" as const, cwd: "/repo" }
    : { kind: "workspace" as const, cwd: workspaceCwd };
  return {
    key,
    kind: key.includes(":peer:") ? "peer" : "primary",
    sessionId,
    provider: "codex",
    cwd: "/repo",
    sandbox: "read-only",
    scope: workspaceCwd === undefined ? { kind: "fleet" } : scope,
    grant: {
      subjectSessionId: sessionId,
      capabilities: ["thread.read", "thread.enqueue", "worker.start"],
      scope: workspaceCwd === undefined ? { kind: "fleet" } : scope,
    },
    createdAt: new Date(baseMs).toISOString(),
    updatedAt: new Date(baseMs).toISOString(),
  };
}

interface FakeSession {
  id: string;
  cwd: string;
  createdAt: string;
  executionState: string;
  attentionState?: string;
  exitCode: number | null;
  parentSessionId?: string;
}

async function harness(options: {
  leaseDurationMs?: number;
  enqueueStatus?: "queued" | "rendered";
  eventRateLimit?: number;
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "cyberdeck-worker-control-"));
  directories.push(directory);
  let nowMs = baseMs;
  const coordination = new WorkerCoordinationService({
    store: new WorkerCoordinationStore(directory),
    now: () => new Date(nowMs).toISOString(),
    leaseDurationMs: options.leaseDurationMs ?? 30_000,
    gracePeriodMs: 5_000,
    ...(options.eventRateLimit === undefined ? {} : { eventRateLimit: options.eventRateLimit }),
  });
  await coordination.initialize();

  const sessions = new Map<string, FakeSession>();
  const bindings = new Map<string, OrchestratorBinding>([
    [ORC, binding(ORC, "fleet")],
    [OTHER_ORC, binding(OTHER_ORC, "workspace:/other")],
    [PEER, binding(PEER, PEER_KEY)],
    [ELSEWHERE, binding(ELSEWHERE, "workspace:/elsewhere", "/elsewhere")],
  ]);
  const stopped: string[] = [];
  const forced: string[] = [];
  const stopRequests = new Map<string, string>();
  const sessionUpdateListeners = new Set<(sessionId: string) => void>();
  const enqueued: Array<{ targetSessionId: string; message: string }> = [];

  const registry = {
    get(sessionId: string): FakeSession {
      const record = sessions.get(sessionId);
      if (record === undefined) {
        throw Object.assign(new Error(`No session ${sessionId}`), { code: "SESSION_NOT_FOUND" });
      }
      return record;
    },
    ownsProcess: () => true,
    isStopRequested: (sessionId: string) => stopRequests.has(sessionId),
    stopRequestedAt: (sessionId: string) => stopRequests.get(sessionId),
    onSessionUpdate(listener: (sessionId: string) => void) {
      sessionUpdateListeners.add(listener);
      return () => sessionUpdateListeners.delete(listener);
    },
    async stop(sessionId: string) {
      stopped.push(sessionId);
      stopRequests.set(sessionId, new Date(nowMs).toISOString());
      const record = sessions.get(sessionId);
      if (record !== undefined) record.executionState = "cancelled";
      for (const listener of sessionUpdateListeners) listener(sessionId);
    },
    forceStop(sessionId: string) {
      forced.push(sessionId);
    },
  };

  const instructions = {
    enqueue: vi.fn(async (input: { targetSessionId: string; message: string }) => {
      enqueued.push({ targetSessionId: input.targetSessionId, message: input.message });
      return { id: randomUUID(), status: options.enqueueStatus ?? "queued" };
    }),
  };

  const build = () => new WorkerControlService({
    coordination,
    registry: registry as never,
    orchestrators: { findBySessionId: async (id: string) => bindings.get(id) } as never,
    instructions: instructions as never,
    now: () => nowMs,
    forceStopGraceMs: 5_000,
  });

  return {
    coordination,
    control: build(),
    /** A fresh control service over the same substrate: the broker-restart case. */
    rebuild: build,
    sessions,
    stopped,
    forced,
    forced_count: () => forced.length,
    enqueued,
    instructions,
    advance: (ms: number) => { nowMs += ms; },
    now: () => nowMs,
    exit(sessionId: string, exitCode: number) {
      const record = sessions.get(sessionId);
      if (record === undefined) throw new Error(`No session ${sessionId}`);
      record.exitCode = exitCode;
      record.executionState = exitCode === 0 ? "exited" : "cancelled";
      record.attentionState = exitCode === 0 ? "done" : "stopped";
      for (const listener of sessionUpdateListeners) listener(sessionId);
    },
    addSession(input: Partial<FakeSession> = {}): string {
      const id = input.id ?? randomUUID();
      sessions.set(id, {
        id,
        cwd: "/repo/worktrees/w",
        createdAt: new Date(baseMs).toISOString(),
        executionState: "active",
        attentionState: "working",
        exitCode: null,
        ...input,
      });
      return id;
    },
    async register(input: {
      workerId?: string;
      controllerId?: string;
      waveId?: string;
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
          ...(input.waveId === undefined ? {} : { waveId: input.waveId }),
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

describe("WorkerControlService leases", () => {
  it("acquires a released worker and replays the same mutation idempotently", async () => {
    const bench = await harness();
    const workerId = bench.addSession();
    await bench.register({ workerId });

    const first = await bench.control.lease({
      actorSessionId: ORC,
      action: "adopt",
      scope: "worker",
      workerId,
      reason: "take over abandoned worker",
      mutationId: "m-1",
    });
    expect(first.results[0]).toMatchObject({ workerId, code: "ACQUIRED" });
    expect(first.idempotentReplay).toBe(false);
    expect(JSON.stringify(first)).not.toContain("leaseToken");

    const retry = await bench.control.lease({
      actorSessionId: ORC,
      action: "adopt",
      scope: "worker",
      workerId,
      reason: "take over abandoned worker",
      mutationId: "m-1",
    });
    expect(retry.idempotentReplay).toBe(true);
    expect(retry.results[0]?.code).toBe("ACQUIRED");
  });

  it("reports LEASE_CONFLICT with the live controller identity and lease expiry", async () => {
    const bench = await harness();
    const workerId = bench.addSession();
    await bench.register({ workerId, controllerId: "orchestrator:workspace:/other" });

    const result = await bench.control.lease({
      actorSessionId: ORC,
      action: "acquire",
      scope: "worker",
      workerId,
      reason: "attempt takeover",
    });
    expect(result.results[0]).toMatchObject({
      code: "LEASE_CONFLICT",
      currentController: "orchestrator:workspace:/other",
    });
    expect(result.results[0]?.leaseExpiresAt).toBeTypeOf("string");
  });

  it("returns WORKER_TERMINAL for a worker that already finished", async () => {
    const bench = await harness();
    const workerId = bench.addSession({
      executionState: "exited",
      attentionState: "done",
      exitCode: 0,
    });
    await bench.register({ workerId, lifecycle: "done" });

    const result = await bench.control.lease({
      actorSessionId: ORC,
      action: "adopt",
      scope: "worker",
      workerId,
      reason: "adopt",
    });
    expect(result.results[0]?.code).toBe("WORKER_TERMINAL");
  });

  it("returns NOT_ELIGIBLE when acquire is used on an orphaned worker", async () => {
    const bench = await harness();
    const workerId = bench.addSession();
    await bench.register({ workerId });

    const result = await bench.control.lease({
      actorSessionId: ORC,
      action: "acquire",
      scope: "worker",
      workerId,
      reason: "acquire orphan",
    });
    expect(result.results[0]?.code).toBe("NOT_ELIGIBLE");
  });

  it("renews, releases, and transfers a held lease", async () => {
    const bench = await harness();
    const workerId = bench.addSession();
    await bench.register({ workerId });
    await bench.control.lease({
      actorSessionId: ORC, action: "adopt", scope: "worker", workerId, reason: "adopt",
    });

    const renewed = await bench.control.lease({
      actorSessionId: ORC, action: "renew", scope: "worker", workerId, reason: "keep control",
    });
    expect(renewed.results[0]?.code).toBe("ALREADY_CONTROLLED");

    const transferred = await bench.control.lease({
      actorSessionId: ORC,
      action: "transfer",
      scope: "worker",
      workerId,
      newControllerSessionId: OTHER_ORC,
      reason: "hand off",
    });
    expect(transferred.results[0]?.code).toBe("TRANSFERRED");

    const released = await bench.control.lease({
      actorSessionId: OTHER_ORC, action: "release", scope: "worker", workerId, reason: "done",
    });
    expect(released.results[0]?.code).toBe("RELEASED");
  });

  it("gives a stale controller OWNERSHIP_LOST instead of silently reacquiring", async () => {
    const bench = await harness();
    const workerId = bench.addSession();
    await bench.register({ workerId });
    await bench.control.lease({
      actorSessionId: ORC, action: "adopt", scope: "worker", workerId, reason: "adopt",
    });

    // A restarted broker holds the durable subject but none of the lease tokens.
    const successor = bench.rebuild();
    const result = await successor.lease({
      actorSessionId: ORC, action: "renew", scope: "worker", workerId, reason: "renew after restart",
    });
    expect(result.results[0]).toMatchObject({ workerId, code: "OWNERSHIP_LOST" });
    expect(bench.coordination.getSubject(workerId)?.lease.state).toBe("active");
  });

  it("binds a lease to a peer under its own id inside its scope's controller family", async () => {
    const bench = await harness();
    const workerId = bench.addSession();
    await bench.register({ workerId });

    const adopted = await bench.control.lease({
      actorSessionId: PEER, action: "adopt", scope: "worker", workerId, reason: "adopt",
    });
    expect(adopted.results[0]).toMatchObject({ workerId, code: "ACQUIRED" });
    expect(adopted.controllerId).toBe(PEER_CONTROLLER_ID);

    const controller = bench.coordination.getSubject(workerId)?.lease.controller;
    // Its own controller id, so two peers of one scope can never take each other's leases; its
    // scope's family id, so the workers belong to the orchestrator family, not to a conversation.
    expect(controller).toMatchObject({
      controllerId: PEER_CONTROLLER_ID,
      familyId: "orchestrator:fleet",
    });
  });

  it("hands a lease to a peer through the same transfer path as a primary", async () => {
    const bench = await harness();
    const workerId = bench.addSession();
    await bench.register({ workerId });
    await bench.control.lease({
      actorSessionId: ORC, action: "adopt", scope: "worker", workerId, reason: "adopt",
    });

    const transferred = await bench.control.lease({
      actorSessionId: ORC,
      action: "transfer",
      scope: "worker",
      workerId,
      newControllerSessionId: PEER,
      reason: "hand off",
    });
    expect(transferred.results[0]).toMatchObject({
      code: "TRANSFERRED",
      currentController: PEER_CONTROLLER_ID,
    });

    const renewed = await bench.control.lease({
      actorSessionId: PEER, action: "renew", scope: "worker", workerId, reason: "keep control",
    });
    expect(renewed.results[0]?.code).toBe("ALREADY_CONTROLLED");
  });

  it("rejects a transfer to a session holding no binding at all", async () => {
    const bench = await harness();
    const workerId = bench.addSession();
    await bench.register({ workerId });
    await bench.control.lease({
      actorSessionId: ORC, action: "adopt", scope: "worker", workerId, reason: "adopt",
    });

    await expect(bench.control.lease({
      actorSessionId: ORC,
      action: "transfer",
      scope: "worker",
      workerId,
      newControllerSessionId: UNBOUND,
      reason: "hand off",
    })).rejects.toMatchObject({ code: "TRANSFER_TARGET_UNBOUND" });
  });
});

/**
 * MIK-98: one binding, one authority. A peer was once granted `thread.enqueue` and refused the
 * lease that `worker_ctl` and `worker_events` prove authority with, so it could instruct a worker
 * it could neither control nor observe. These exercise all three against the same worker.
 */
describe("WorkerControlService peer bindings", () => {
  async function peerControlled() {
    const bench = await harness();
    const workerId = bench.addSession({ parentSessionId: PEER });
    await bench.register({ workerId });
    const adopted = await bench.control.lease({
      actorSessionId: PEER, action: "adopt", scope: "worker", workerId, reason: "adopt",
    });
    expect(adopted.results[0]?.code).toBe("ACQUIRED");
    return { bench, workerId };
  }

  it("enqueues an instruction to the worker it controls", async () => {
    const { bench, workerId } = await peerControlled();

    const result = await bench.control.control({
      actorSessionId: PEER,
      action: "redirect",
      workerId,
      instruction: "Stop refactoring; land the failing test fix only.",
      reason: "priority change",
    });

    expect(result).toMatchObject({ code: "QUEUED", delivery: "queued" });
    expect(bench.enqueued[0]?.targetSessionId).toBe(workerId);
  });

  it("controls that same worker", async () => {
    const { bench, workerId } = await peerControlled();

    const stopped = await bench.control.control({
      actorSessionId: PEER, action: "stop", workerId, reason: "wrong branch",
    });

    expect(stopped.code).toBe("STOP_REQUESTED");
    expect(bench.stopped).toContain(workerId);
  });

  it("observes that same worker", async () => {
    const { bench, workerId } = await peerControlled();

    const page = await bench.control.events({ actorSessionId: PEER });

    expect(page.state[0]).toMatchObject({
      workerId,
      leaseState: "active",
      controllerId: PEER_CONTROLLER_ID,
    });
  });
});

describe("WorkerControlService recovery", () => {
  it("previews the adoptable set and the blocked cases without mutating anything", async () => {
    const bench = await harness();
    const recoverable = bench.addSession();
    const live = bench.addSession();
    const finished = bench.addSession({
      executionState: "failed",
      attentionState: "failed",
      exitCode: 1,
    });
    await bench.register({ workerId: recoverable, waveId: "wave-1" });
    await bench.register({ workerId: live, controllerId: "orchestrator:workspace:/other" });
    await bench.register({ workerId: finished, lifecycle: "failed" });
    const ghost = await bench.register({});

    const plan = await bench.control.lease({
      actorSessionId: ORC,
      action: "adopt",
      scope: "all-eligible",
      reason: "survey before recovery",
      preview: true,
    });

    expect(plan.results).toEqual([]);
    expect(plan.plan?.eligible.map((entry) => entry.workerId)).toEqual([recoverable]);
    expect(plan.plan?.eligible[0]).toMatchObject({ via: "adopt", waveId: "wave-1", lifecycle: "working" });
    const blocked = new Map(plan.plan?.blocked.map((entry) => [entry.workerId, entry.code]));
    expect(blocked.get(live)).toBe("LEASE_CONFLICT");
    expect(blocked.get(finished)).toBe("WORKER_TERMINAL");
    expect(blocked.get(ghost)).toBe("SUBJECT_UNKNOWN_TO_BROKER");
    expect(bench.coordination.getSubject(recoverable)?.lease.state).toBe("orphaned");
  });

  it("adopts the eligible set atomically and leaves foreign leases untouched", async () => {
    const bench = await harness();
    const first = bench.addSession();
    const second = bench.addSession();
    const foreign = bench.addSession();
    await bench.register({ workerId: first, waveId: "wave-1" });
    await bench.register({ workerId: second, waveId: "wave-1" });
    await bench.register({ workerId: foreign, controllerId: "orchestrator:workspace:/other" });

    const result = await bench.control.lease({
      actorSessionId: ORC,
      action: "adopt",
      scope: "all-eligible",
      reason: "replacement orchestrator recovery",
    });

    expect(result.summary.ACQUIRED).toBe(2);
    expect(bench.coordination.getSubject(first)?.lease.controller?.controllerId).toBe("orchestrator:fleet");
    expect(bench.coordination.getSubject(second)?.lease.controller?.controllerId).toBe("orchestrator:fleet");
    expect(bench.coordination.getSubject(foreign)?.lease.controller?.controllerId)
      .toBe("orchestrator:workspace:/other");
  });

  it("aborts the whole adoption before mutation when one planned worker becomes unavailable", async () => {
    const bench = await harness();
    const first = bench.addSession();
    const second = bench.addSession();
    await bench.register({ workerId: first, waveId: "wave-1" });
    await bench.register({ workerId: second, waveId: "wave-1" });

    const rival = {
      controllerId: "orchestrator:rival",
      familyId: "orchestrator:rival",
      scope: { kind: "fleet" as const, scopeId: "rival" },
    };
    const original = bench.coordination.adoptBatch.bind(bench.coordination);
    vi.spyOn(bench.coordination, "adoptBatch").mockImplementation(async (input) => {
      await bench.coordination.adopt({
        mutationId: "rival-won-before-batch",
        actor: rival,
        newController: rival,
        selector: { scope: "single", subjectId: second },
        reason: "concurrent takeover",
      });
      return original(input);
    });

    const result = await bench.control.lease({
      actorSessionId: ORC,
      action: "adopt",
      scope: "wave",
      waveId: "wave-1",
      reason: "recovery that must not half-apply",
    });

    expect(result.aborted?.code).toBe("ADOPTION_ABORTED");
    expect(result.aborted).not.toHaveProperty("rolledBack");
    expect(bench.coordination.getSubject(first)?.lease.state).toBe("orphaned");
    expect(bench.coordination.getSubject(first)?.lease.tokenHash).toBeUndefined();
    expect(bench.coordination.getSubject(second)?.lease.controller).toEqual(rival);
    vi.restoreAllMocks();
  });

  it("treats a lease whose controller went silent past its TTL as recoverable", async () => {
    const bench = await harness({ leaseDurationMs: 10_000 });
    const workerId = bench.addSession();
    await bench.register({ workerId, controllerId: "orchestrator:workspace:/other" });

    bench.advance(60_000);
    const result = await bench.control.lease({
      actorSessionId: ORC,
      action: "adopt",
      scope: "all-eligible",
      reason: "controller went silent",
    });
    expect(result.results.find((entry) => entry.workerId === workerId)?.code).toBe("ACQUIRED");
  });
});

describe("WorkerControlService worker control", () => {
  async function controlled() {
    const bench = await harness();
    const workerId = bench.addSession();
    await bench.register({ workerId });
    await bench.control.lease({
      actorSessionId: ORC, action: "adopt", scope: "worker", workerId, reason: "adopt",
    });
    return { bench, workerId };
  }

  it("rejects control from a session that holds no lease with a structured code", async () => {
    const bench = await harness();
    const workerId = bench.addSession();
    await bench.register({ workerId, controllerId: "orchestrator:workspace:/other" });

    const result = await bench.control.control({
      actorSessionId: ORC, action: "stop", workerId, reason: "stop it",
    });
    expect(result).toMatchObject({ code: "NOT_CONTROLLER", currentController: "orchestrator:workspace:/other" });
  });

  it("reports SUBJECT_NOT_FOUND rather than a generic session error", async () => {
    const bench = await harness();
    const result = await bench.control.control({
      actorSessionId: ORC, action: "stop", workerId: randomUUID(), reason: "stop it",
    });
    expect(result.code).toBe("SUBJECT_NOT_FOUND");
  });

  it("reports LEASE_EXPIRED once the held lease has aged out", async () => {
    const bench = await harness({ leaseDurationMs: 10_000 });
    const workerId = bench.addSession();
    await bench.register({ workerId });
    await bench.control.lease({
      actorSessionId: ORC, action: "adopt", scope: "worker", workerId, reason: "adopt",
    });
    bench.advance(60_000);

    const result = await bench.control.control({
      actorSessionId: ORC, action: "redirect", workerId, instruction: "new plan", reason: "redirect",
    });
    expect(result.code).toBe("LEASE_EXPIRED");
  });

  it("keeps an ignored graceful stop live, recoverable, and force-stoppable until exit", async () => {
    const { bench, workerId } = await controlled();

    const result = await bench.control.control({
      actorSessionId: ORC, action: "stop", workerId, reason: "scope changed",
    });

    expect(bench.stopped).toEqual([workerId]);
    expect(bench.forced).toEqual([]);
    expect(result).toMatchObject({ code: "STOP_REQUESTED", lifecycle: "working", mode: "graceful" });
    expect(bench.coordination.getSubject(workerId)?.lifecycle).toBe("working");

    bench.advance(60_000);
    const replacement = bench.rebuild();
    const recovered = await replacement.lease({
      actorSessionId: ORC,
      action: "adopt",
      scope: "worker",
      workerId,
      reason: "replace controller after ignored SIGTERM",
    });
    expect(recovered.results[0]).toMatchObject({ workerId, code: "ACQUIRED" });

    const forced = await replacement.control({
      actorSessionId: ORC, action: "stop", workerId, mode: "force", reason: "grace expired",
    });
    expect(bench.forced).toEqual([workerId]);
    expect(forced).toMatchObject({
      code: "STOP_REQUESTED",
      exitCode: null,
      lifecycle: "working",
      mode: "force",
    });
    expect(bench.coordination.getSubject(workerId)?.lifecycle).toBe("working");

    bench.exit(workerId, 137);
    await vi.waitFor(() => {
      expect(bench.coordination.getSubject(workerId)?.lifecycle).toBe("stopped");
    });
  });

  it("requires an observed graceful stop plus a grace period before force", async () => {
    const { bench, workerId } = await controlled();

    const premature = await bench.control.control({
      actorSessionId: ORC, action: "stop", workerId, mode: "force", reason: "kill it",
    });
    expect(premature.code).toBe("APPROVAL_REQUIRED");
    expect(bench.forced).toEqual([]);

    await bench.control.control({ actorSessionId: ORC, action: "stop", workerId, reason: "graceful first" });
    const tooSoon = await bench.control.control({
      actorSessionId: ORC, action: "stop", workerId, mode: "force", reason: "kill it",
    });
    expect(tooSoon.code).toBe("APPROVAL_REQUIRED");

    bench.advance(10_000);
    const forced = await bench.control.control({
      actorSessionId: ORC, action: "stop", workerId, mode: "force", reason: "kill it",
    });
    expect(bench.forced).toEqual([workerId]);
    expect(forced).toMatchObject({ code: "STOP_REQUESTED", exitCode: null, lifecycle: "working" });

    bench.exit(workerId, 137);
    await vi.waitFor(() => {
      expect(bench.coordination.getSubject(workerId)?.lifecycle).toBe("stopped");
    });
  });

  it("enqueues a redirect instruction for a controlled worker", async () => {
    const { bench, workerId } = await controlled();

    const result = await bench.control.control({
      actorSessionId: ORC,
      action: "redirect",
      workerId,
      instruction: "Stop refactoring; land the failing test fix only.",
      reason: "priority change",
    });

    expect(result).toMatchObject({ code: "QUEUED", delivery: "queued" });
    expect(bench.enqueued[0]?.message).toContain("land the failing test fix only");
  });

  it("refuses to redirect a terminal worker", async () => {
    const { bench, workerId } = await controlled();
    await bench.control.control({ actorSessionId: ORC, action: "stop", workerId, reason: "done" });
    bench.exit(workerId, 137);
    await vi.waitFor(() => {
      expect(bench.coordination.getSubject(workerId)?.lifecycle).toBe("stopped");
    });

    const result = await bench.control.control({
      actorSessionId: ORC, action: "redirect", workerId, instruction: "more work", reason: "retry",
    });
    expect(result.code).toBe("WORKER_TERMINAL");
  });

  it("requests a non-blocking checkpoint and correlates a retry to the same request", async () => {
    const { bench, workerId } = await controlled();
    const correlationId = "checkpoint-7";

    const first = await bench.control.control({
      actorSessionId: ORC,
      action: "request_checkpoint",
      workerId,
      correlationId,
      focus: "migration risk",
      question: "Is the rollback path still valid?",
      reason: "pre-merge review",
    });

    expect(first).toMatchObject({
      code: "CHECKPOINT_REQUESTED",
      correlationId,
      checkpointMode: "non-blocking",
      delivery: "queued",
    });
    expect(bench.enqueued[0]?.message).toContain(correlationId);
    expect(bench.enqueued[0]?.message).toContain("Do not cancel or restart your current task");
    expect(bench.coordination.getSubject(workerId)?.decisionGate.state).toBe("none");

    const retry = await bench.control.control({
      actorSessionId: ORC,
      action: "request_checkpoint",
      workerId,
      correlationId,
      focus: "migration risk",
      question: "Is the rollback path still valid?",
      reason: "pre-merge review",
    });
    expect(retry).toMatchObject({ code: "CHECKPOINT_REPLAY", correlationId });
    expect(bench.instructions.enqueue).toHaveBeenCalledTimes(1);
    expect(bench.coordination.listCheckpoints(workerId)).toHaveLength(1);
  });

  it("raises a decision gate only when the caller asks for one", async () => {
    const { bench, workerId } = await controlled();

    const result = await bench.control.control({
      actorSessionId: ORC,
      action: "request_checkpoint",
      workerId,
      correlationId: "gate-1",
      question: "Ship or hold?",
      decisionGate: true,
      reason: "irreversible step ahead",
    });

    expect(result.checkpointMode).toBe("decision-gate");
    expect(bench.coordination.getSubject(workerId)?.decisionGate).toMatchObject({
      state: "decision-gate",
      correlationId: "gate-1",
    });
  });
});

describe("WorkerControlService events", () => {
  async function withEvents() {
    const bench = await harness();
    const workerId = bench.addSession();
    await bench.register({ workerId, waveId: "wave-1" });
    const lease = await bench.control.lease({
      actorSessionId: ORC, action: "adopt", scope: "worker", workerId, reason: "adopt",
    });
    const version = lease.results[0]!.leaseVersion!;
    const subject = bench.coordination.getSubject(workerId)!;
    void subject;
    return { bench, workerId, version };
  }

  it("reads events incrementally by cursor and reports current worker state", async () => {
    const { bench, workerId, version } = await withEvents();
    const token = await leaseToken(bench, workerId);
    await submit(bench, workerId, version, token, 1, { summary: "started" });
    await submit(bench, workerId, version, token, 2, {
      kind: "EXCEPTION",
      severity: "error",
      interventionRequired: true,
      summary: "build broke",
      recommendedAction: "pin the toolchain",
    });

    const first = await bench.control.events({ actorSessionId: ORC, limit: 1 });
    expect(first.returned).toBe(1);
    expect(first.hasMore).toBe(true);
    expect(first.events[0]).toMatchObject({ kind: "PROGRESS", summary: "started" });
    expect(first.state[0]).toMatchObject({
      workerId,
      lifecycle: "working",
      leaseState: "active",
      controllerId: "orchestrator:fleet",
      unresolvedEvents: 1,
    });

    const second = await bench.control.events({ actorSessionId: ORC, cursor: first.nextCursor });
    expect(second.events.map((event) => event.kind)).toEqual(["EXCEPTION"]);
    expect(second.hasMore).toBe(false);
  });

  it("filters by kind, severity, wave, and unresolved view", async () => {
    const { bench, workerId, version } = await withEvents();
    const token = await leaseToken(bench, workerId);
    await submit(bench, workerId, version, token, 1, { summary: "progress only" });
    await submit(bench, workerId, version, token, 2, {
      kind: "RISK",
      severity: "warning",
      interventionRequired: true,
      summary: "risk found",
    });

    const risks = await bench.control.events({ actorSessionId: ORC, kinds: ["RISK"] });
    expect(risks.events).toHaveLength(1);

    const unresolved = await bench.control.events({ actorSessionId: ORC, view: "unresolved" });
    expect(unresolved.events.map((event) => event.summary)).toEqual(["risk found"]);

    const wrongWave = await bench.control.events({ actorSessionId: ORC, waveId: "wave-2" });
    expect(wrongWave.events).toEqual([]);

    const critical = await bench.control.events({ actorSessionId: ORC, severities: ["critical"] });
    expect(critical.events).toEqual([]);
  });

  it("bounds event payloads instead of returning transcript-shaped text", async () => {
    const { bench, workerId, version } = await withEvents();
    const token = await leaseToken(bench, workerId);
    await submit(bench, workerId, version, token, 1, {
      summary: "x".repeat(1_024),
      evidenceRefs: Array.from({ length: 10 }, (_, index) => `ref-${index}`),
      changedAssumptions: Array.from({ length: 10 }, (_, index) => `assumption-${index}`),
    });

    const page = await bench.control.events({ actorSessionId: ORC });
    const event = page.events[0]!;
    expect((event.summary as string).length).toBeLessThanOrEqual(320);
    expect(event.evidenceRefs).toHaveLength(3);
    expect(event.changedAssumptions).toHaveLength(3);
    expect(event).not.toHaveProperty("submissionHash");
  });

  it("hides workers outside the caller's grant", async () => {
    const { bench, workerId, version } = await withEvents();
    const token = await leaseToken(bench, workerId);
    await submit(bench, workerId, version, token, 1, { summary: "visible only to the fleet grant" });

    const scoped = await bench.control.events({ actorSessionId: ELSEWHERE });
    expect(scoped.events).toEqual([]);
    expect(scoped.state).toEqual([]);
  });

  it("reports exact unresolved count and last ordinal beyond 50 matching events", async () => {
    const bench = await harness({ eventRateLimit: 100 });
    const workerId = bench.addSession();
    await bench.register({ workerId, waveId: "wave-1" });
    await bench.control.lease({
      actorSessionId: ORC, action: "adopt", scope: "worker", workerId, reason: "adopt",
    });
    const token = await leaseToken(bench, workerId);
    const version = bench.coordination.getSubject(workerId)!.lease.version;
    for (let sequence = 1; sequence <= 60; sequence += 1) {
      await submit(bench, workerId, version, token, sequence, {
        kind: "RISK",
        interventionRequired: true,
        summary: `risk ${sequence}`,
      });
    }

    const result = await bench.control.events({ actorSessionId: ORC, workerId, limit: 1 });
    expect(result.state[0]).toMatchObject({
      unresolvedEvents: 60,
      lastOrdinal: 60,
    });
  });
});

async function leaseToken(bench: Awaited<ReturnType<typeof harness>>, workerId: string): Promise<string> {
  // Events are worker-authored, so the test submits them with a controller-issued token of its own.
  const subject = bench.coordination.getSubject(workerId)!;
  void subject;
  const result = await bench.coordination.acquire({
    mutationId: `test-token:${workerId}:${randomUUID()}`,
    actor: { controllerId: "orchestrator:fleet", familyId: "orchestrator:fleet", scope: { kind: "fleet", scopeId: "fleet" } },
    controller: { controllerId: "orchestrator:fleet", familyId: "orchestrator:fleet", scope: { kind: "fleet", scopeId: "fleet" } },
    selector: { scope: "single", subjectId: workerId },
    reason: "test event submission",
  });
  return result.outcomes[0]!.leaseToken!;
}

async function submit(
  bench: Awaited<ReturnType<typeof harness>>,
  workerId: string,
  version: number,
  token: string,
  sequence: number,
  overrides: Record<string, unknown>,
): Promise<void> {
  void version;
  const subject = bench.coordination.getSubject(workerId)!;
  await bench.coordination.submitEvent({
    mutationId: `event:${workerId}:${sequence}`,
    controller: {
      controllerId: "orchestrator:fleet",
      familyId: "orchestrator:fleet",
      scope: { kind: "fleet", scopeId: "fleet" },
    },
    leaseToken: token,
    event: {
      schemaVersion: 1,
      eventId: `event:${workerId}:${sequence}`,
      sequence,
      workerId,
      taskId: `task:${workerId}`,
      waveId: "wave-1",
      controllerLeaseVersion: subject.lease.version,
      kind: "PROGRESS",
      severity: "info",
      interventionRequired: false,
      continuation: "continuing",
      evidenceRefs: [],
      changedAssumptions: [],
      timestamp: new Date(bench.now()).toISOString(),
      ...overrides,
    },
  });
}
