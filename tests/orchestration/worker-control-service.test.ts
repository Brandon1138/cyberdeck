import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkerCoordinationService } from "../../src/broker/worker-coordination.js";
import type { OrchestratorBinding } from "../../src/domain/orchestrator.js";
import type { WorkerLifecycle } from "../../src/domain/worker-coordination.js";
import { WorkerControlService, WorkerControlError } from "../../src/orchestration/worker-control-service.js";
import { WorkerCoordinationStore } from "../../src/persistence/worker-coordination-store.js";

const baseMs = Date.parse("2026-07-27T10:00:00.000Z");
const ORC = "11111111-1111-4111-8111-111111111111";
const OTHER_ORC = "33333333-3333-4333-8333-333333333333";
const PEER = "44444444-4444-4444-8444-444444444444";
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

async function harness(options: { leaseDurationMs?: number; enqueueStatus?: "queued" | "delivered" } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "cyberdeck-worker-control-"));
  directories.push(directory);
  let nowMs = baseMs;
  const coordination = new WorkerCoordinationService({
    store: new WorkerCoordinationStore(directory),
    now: () => new Date(nowMs).toISOString(),
    leaseDurationMs: options.leaseDurationMs ?? 30_000,
    gracePeriodMs: 5_000,
  });
  await coordination.initialize();

  const sessions = new Map<string, FakeSession>();
  const bindings = new Map<string, OrchestratorBinding>([
    [ORC, binding(ORC, "fleet")],
    [OTHER_ORC, binding(OTHER_ORC, "workspace:/other")],
    [PEER, binding(PEER, "fleet:peer:99999999-9999-4999-8999-999999999999")],
    [ELSEWHERE, binding(ELSEWHERE, "workspace:/elsewhere", "/elsewhere")],
  ]);
  const stopped: string[] = [];
  const forced: string[] = [];
  const stopRequests = new Map<string, string>();
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
    async stop(sessionId: string) {
      stopped.push(sessionId);
      stopRequests.set(sessionId, new Date(nowMs).toISOString());
      const record = sessions.get(sessionId);
      if (record !== undefined) record.executionState = "cancelled";
    },
    forceStop(sessionId: string) {
      forced.push(sessionId);
      const record = sessions.get(sessionId);
      if (record !== undefined) record.exitCode = 137;
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
    const workerId = bench.addSession();
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

  it("refuses to bind a lease to a peer binding", async () => {
    const bench = await harness();
    const workerId = bench.addSession();
    await bench.register({ workerId });

    await expect(bench.control.lease({
      actorSessionId: PEER, action: "adopt", scope: "worker", workerId, reason: "adopt",
    })).rejects.toMatchObject({ code: "NO_STABLE_CONTROLLER_IDENTITY" });
  });

  it("rejects a transfer to a session with no stable binding", async () => {
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
      newControllerSessionId: PEER,
      reason: "hand off",
    })).rejects.toBeInstanceOf(WorkerControlError);
  });
});

describe("WorkerControlService recovery", () => {
  it("previews the adoptable set and the blocked cases without mutating anything", async () => {
    const bench = await harness();
    const recoverable = bench.addSession();
    const live = bench.addSession();
    const finished = bench.addSession();
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

  it("rolls the whole adoption back when one planned worker cannot be taken", async () => {
    const bench = await harness();
    const first = bench.addSession();
    const second = bench.addSession();
    await bench.register({ workerId: first, waveId: "wave-1" });
    await bench.register({ workerId: second, waveId: "wave-1" });

    const original = bench.coordination.adopt.bind(bench.coordination);
    let calls = 0;
    vi.spyOn(bench.coordination, "adopt").mockImplementation(async (input) => {
      calls += 1;
      if (calls === 1) return original(input);
      return {
        mutationId: input.mutationId,
        operation: "adopt" as const,
        idempotentReplay: false,
        outcomes: [{
          subjectId: input.selector.scope === "single" ? input.selector.subjectId : second,
          code: "NOT_ELIGIBLE",
          message: "injected failure",
        }],
      };
    });

    const result = await bench.control.lease({
      actorSessionId: ORC,
      action: "adopt",
      scope: "wave",
      waveId: "wave-1",
      reason: "recovery that must not half-apply",
    });

    expect(result.aborted?.code).toBe("ADOPTION_ABORTED");
    expect(result.aborted?.rolledBack).toEqual([first]);
    // Net ownership is unchanged: the compensated worker holds no live lease and no valid token.
    expect(bench.coordination.getSubject(first)?.lease.state).toBe("released");
    expect(bench.coordination.getSubject(first)?.lease.tokenHash).toBeUndefined();
    expect(bench.coordination.getSubject(second)?.lease.state).toBe("orphaned");
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

  it("stops a worker gracefully and drives the lease subject to a terminal lifecycle", async () => {
    const { bench, workerId } = await controlled();

    const result = await bench.control.control({
      actorSessionId: ORC, action: "stop", workerId, reason: "scope changed",
    });

    expect(bench.stopped).toEqual([workerId]);
    expect(bench.forced).toEqual([]);
    expect(result).toMatchObject({ code: "STOP_REQUESTED", lifecycle: "stopped", mode: "graceful" });
    expect(bench.coordination.getSubject(workerId)?.lifecycle).toBe("stopped");
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
    expect(forced).toMatchObject({ code: "STOPPED", exitCode: 137, lifecycle: "stopped" });
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
