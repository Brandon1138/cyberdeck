import { describe, expect, it, vi } from "vitest";
import {
  AgentControlService,
  AgentStartWorkersParamsSchema,
  AgentWaitWorkersParamsSchema,
} from "../../src/orchestration/agent-control-service.js";
import type { OrchestratorBinding } from "../../src/domain/orchestrator.js";
import type { SessionRecord } from "../../src/domain/session.js";

const ACTOR = "11111111-1111-4111-8111-111111111111";
const WORKER = "22222222-2222-4222-8222-222222222222";
const now = "2026-07-22T12:00:00.000Z";
const worker: SessionRecord = {
  id: WORKER,
  provider: "codex",
  cwd: "/repo/one",
  detached: true,
  sandbox: "read-only",
  createdAt: now,
  updatedAt: now,
  executionState: "active",
  attachmentState: "detached",
  pid: 12,
  exitCode: null,
  childIds: [],
};
const binding: OrchestratorBinding = {
  key: "workspace:/repo/one",
  sessionId: ACTOR,
  provider: "codex",
  cwd: "/repo/one",
  sandbox: "read-only",
  scope: { kind: "workspace", cwd: "/repo/one" },
  grant: {
    subjectSessionId: ACTOR,
    capabilities: ["thread.list", "thread.read", "worker.start"],
    scope: { kind: "workspace", cwd: "/repo/one" },
  },
  createdAt: now,
  updatedAt: now,
};

describe("AgentControlService", () => {
  it("accepts 64-worker start and wait batches from one orchestrator turn", () => {
    const workers = Array.from({ length: 64 }, (_, index) => ({
      provider: "codex" as const,
      cwd: "/repo/one",
      prompt: `Worker ${index}`,
    }));
    const targets = Array.from({ length: 64 }, () => ({
      sessionId: crypto.randomUUID(),
      completionTarget: 1,
    }));

    expect(AgentStartWorkersParamsSchema.parse({ actorSessionId: ACTOR, workers }).workers).toHaveLength(64);
    expect(AgentWaitWorkersParamsSchema.parse({ actorSessionId: ACTOR, targets }).targets).toHaveLength(64);
  });

  it("lists and reads only threads inside the bound workspace", async () => {
    const outside = { ...worker, id: crypto.randomUUID(), cwd: "/repo/two" };
    const service = new AgentControlService(
      { list: () => [worker, outside], get: () => worker } as never,
      { findBySessionId: vi.fn(async () => binding) } as never,
      { read: vi.fn(async () => ({ events: [], nextCursor: 0 })) } as never,
    );

    await expect(service.listThreads({ actorSessionId: ACTOR, view: "full" })).resolves.toMatchObject({
      view: "full",
      threads: [worker],
      total: 1,
      returned: 1,
    });
    await expect(service.readThread(ACTOR, WORKER)).resolves.toEqual({ events: [], nextCursor: 0 });
  });

  it("refuses a worker start outside the capability scope", async () => {
    const service = new AgentControlService(
      {} as never,
      { findBySessionId: vi.fn(async () => binding) } as never,
      {} as never,
    );
    await expect(service.startWorker({
      actorSessionId: ACTOR,
      provider: "codex",
      cwd: "/repo/two",
      prompt: "Inspect",
    })).rejects.toMatchObject({ code: "CAPABILITY_DENIED" });
  });

  it("allows a fleet orchestrator to start workers across repositories", async () => {
    const fleetBinding: OrchestratorBinding = {
      ...binding,
      key: "fleet",
      scope: { kind: "fleet" },
      grant: { ...binding.grant, scope: { kind: "fleet" } },
    };
    const start = vi.fn(async (request) => ({
      ...worker,
      ...request,
      id: WORKER,
      name: request.name,
    }));
    const service = new AgentControlService(
      { start } as never,
      { findBySessionId: vi.fn(async () => fleetBinding) } as never,
      {} as never,
    );

    await expect(service.startWorker({
      actorSessionId: ACTOR,
      provider: "codex",
      model: "gpt-5.6-sol",
      effort: "low",
      cwd: "/repo/two",
      prompt: "Inspect the sibling repository",
    })).resolves.toMatchObject({ sessionId: WORKER });
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/repo/two" }), expect.any(String));
  });

  it("starts an advertised worker with effort and returns only compact wait coordinates", async () => {
    const start = vi.fn(async (request) => ({
      ...worker,
      ...request,
      id: WORKER,
      name: request.name,
    }));
    const service = new AgentControlService(
      { start } as never,
      { findBySessionId: vi.fn(async () => binding) } as never,
      {} as never,
    );

    await expect(service.startWorker({
      actorSessionId: ACTOR,
      provider: "codex",
      model: "gpt-5.6-sol",
      effort: "low",
      cwd: "/repo/one",
      prompt: "Return 8 + 1000",
      name: "connectivity-sol",
    })).resolves.toEqual({
      sessionId: WORKER,
      name: "connectivity-sol",
      provider: "codex",
      model: "gpt-5.6-sol",
      effort: "low",
      completionTarget: 1,
    });
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ effort: "low" }), "Return 8 + 1000");
  });

  it("forwards an explicit auto approval request without changing the omitted default", async () => {
    const start = vi.fn(async (request) => ({ ...worker, ...request, id: WORKER }));
    const service = new AgentControlService(
      { start } as never,
      { findBySessionId: vi.fn(async () => binding) } as never,
      {} as never,
    );

    await service.startWorker({
      actorSessionId: ACTOR,
      provider: "claude",
      model: "opus",
      cwd: "/repo/one",
      approvalMode: "auto",
      prompt: "Implement the focused fix",
    });
    expect(start).toHaveBeenLastCalledWith(expect.objectContaining({ approvalMode: "auto" }), expect.any(String));

    await service.startWorker({
      actorSessionId: ACTOR,
      provider: "codex",
      model: "gpt-5.6-sol",
      cwd: "/repo/one",
      prompt: "Review the fix",
    });
    expect(start.mock.calls.at(-1)?.[0]).not.toHaveProperty("approvalMode");
  });

  it("snapshots an enabled Caveman preference into newly started workers", async () => {
    const start = vi.fn(async (request) => ({ ...worker, ...request, id: WORKER }));
    const service = new AgentControlService(
      { start } as never,
      { findBySessionId: vi.fn(async () => binding) } as never,
      {} as never,
      { get: vi.fn(async () => ({ caveman: true })) } as never,
    );

    await service.startWorker({
      actorSessionId: ACTOR,
      provider: "codex",
      model: "gpt-5.6-sol",
      cwd: "/repo/one",
      prompt: "Inspect",
    });

    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      kind: "worker",
      workerMode: "caveman",
    }), "Inspect");
  });

  it("denies Fable workers until the operator grant is enabled", async () => {
    const start = vi.fn();
    const service = new AgentControlService(
      { start } as never,
      { findBySessionId: vi.fn(async () => binding) } as never,
      {} as never,
    );

    await expect(service.startWorker({
      actorSessionId: ACTOR,
      provider: "claude",
      model: "fable",
      effort: "high",
      cwd: "/repo/one",
      prompt: "Review the architecture",
    })).rejects.toMatchObject({
      code: "CAPABILITY_DENIED",
      message: expect.stringContaining("/fable-workers on"),
    });
    expect(start).not.toHaveBeenCalled();
  });

  it("allows an explicitly selected Fable worker after the operator grant is enabled", async () => {
    const enabled: OrchestratorBinding = {
      ...binding,
      grant: {
        ...binding.grant,
        capabilities: [...binding.grant.capabilities, "worker.start.fable"],
      },
    };
    const start = vi.fn(async (request) => ({
      ...worker,
      ...request,
      provider: "claude",
      id: WORKER,
      name: request.name,
    }));
    const service = new AgentControlService(
      { start } as never,
      { findBySessionId: vi.fn(async () => enabled) } as never,
      {} as never,
    );

    await expect(service.startWorker({
      actorSessionId: ACTOR,
      provider: "claude",
      model: "fable",
      effort: "high",
      cwd: "/repo/one",
      prompt: "Review the architecture",
    })).resolves.toMatchObject({ provider: "claude", model: "fable" });
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      parentSessionId: ACTOR,
      model: "fable",
    }), "Review the architecture");
  });

  it("rejects guessed Codex aliases and unsupported effort before launch", async () => {
    const start = vi.fn();
    const service = new AgentControlService(
      { start } as never,
      { findBySessionId: vi.fn(async () => binding) } as never,
      {} as never,
    );

    await expect(service.startWorker({
      actorSessionId: ACTOR,
      provider: "codex",
      model: "sol",
      cwd: "/repo/one",
      prompt: "Ping",
    })).rejects.toMatchObject({
      code: "MODEL_ID_NOT_CANONICAL",
      message: expect.stringContaining("gpt-5.6-sol"),
    });
    await expect(service.startWorker({
      actorSessionId: ACTOR,
      provider: "cursor",
      model: "composer",
      effort: "low",
      cwd: "/repo/one",
      prompt: "Ping",
    })).rejects.toMatchObject({ code: "EFFORT_NOT_SUPPORTED" });
    expect(start).not.toHaveBeenCalled();
  });

  it("prevents an orchestrator from rereading a transcript behind its durable cursor", async () => {
    const read = vi.fn(async (_sessionId: string, afterCursor: number) => ({
      events: [],
      nextCursor: afterCursor === 0 ? 12 : afterCursor,
    }));
    const service = new AgentControlService(
      { get: () => worker } as never,
      { findBySessionId: vi.fn(async () => binding) } as never,
      { read } as never,
    );

    await expect(service.readThread(ACTOR, WORKER, 0)).resolves.toMatchObject({ nextCursor: 12 });
    await expect(service.readThread(ACTOR, WORKER, 0)).rejects.toMatchObject({
      code: "STALE_THREAD_CURSOR",
      message: expect.stringContaining("cursor 12"),
    });
    expect(read).toHaveBeenCalledOnce();
  });

  it("waits for several worker results through the broker instead of reading transcripts", async () => {
    const waitForWorkerResults = vi.fn(async () => ({ timedOut: false, results: [] }));
    const service = new AgentControlService(
      { get: () => worker, waitForWorkerResults } as never,
      { findBySessionId: vi.fn(async () => binding) } as never,
      { read: vi.fn() } as never,
    );

    await expect(service.waitForWorkers({
      actorSessionId: ACTOR,
      targets: [{ sessionId: WORKER, completionTarget: 1 }],
      timeoutSeconds: 30,
      maxResultChars: 800,
    })).resolves.toMatchObject({
      timedOut: false,
      results: [],
      wait: { state: "settled", timeoutSeconds: 30, resumed: false },
    });
    expect(waitForWorkerResults).toHaveBeenCalledWith(
      [{ sessionId: WORKER, completionTarget: 1 }],
      30_000,
      800,
    );
  });

  it("honors a 600-second wait across segments that each return before an MCP client deadline", async () => {
    let clock = 0;
    const waitForWorkerResults = vi.fn(async (_targets: unknown, timeoutMs: number) => {
      clock += timeoutMs;
      return { timedOut: true, results: [{ sessionId: WORKER, status: "working" }] };
    });
    const service = new AgentControlService(
      { get: () => worker, waitForWorkerResults } as never,
      { findBySessionId: vi.fn(async () => binding) } as never,
      { read: vi.fn() } as never,
      undefined,
      { now: () => clock, segmentSeconds: 90 },
    );
    const call = (waitId?: string) => service.waitForWorkers({
      actorSessionId: ACTOR,
      targets: [{ sessionId: WORKER, completionTarget: 1 }],
      timeoutSeconds: 600,
      ...(waitId === undefined ? {} : { waitId }),
    });

    const first = await call();
    expect(first).toMatchObject({
      timedOut: true,
      wait: {
        state: "incomplete",
        resumed: false,
        timeoutSeconds: 600,
        elapsedSeconds: 90,
        remainingSeconds: 510,
        segmentSeconds: 90,
        resume: { tool: "cyberdeck_workers_wait" },
      },
    });
    expect(first.results[0]).toMatchObject({ status: "working" });

    let latest = first;
    while (latest.wait.state === "incomplete") {
      latest = await call(latest.wait.waitId);
      expect(latest.wait.waitId).toBe(first.wait.waitId);
      expect(latest.wait.resumed).toBe(true);
    }

    expect(latest.wait).toMatchObject({ state: "timed-out", remainingSeconds: 0, elapsedSeconds: 600 });
    expect(latest.timedOut).toBe(true);
    // The whole logical budget was served without any single call outliving a client deadline.
    expect(waitForWorkerResults.mock.calls.map(([, timeoutMs]) => timeoutMs)).toEqual([
      90_000, 90_000, 90_000, 90_000, 90_000, 90_000, 60_000,
    ]);
  });

  it("clamps a short wait to the caller's own timeout instead of the segment length", async () => {
    const waitForWorkerResults = vi.fn(async () => ({ timedOut: false, results: [] }));
    const service = new AgentControlService(
      { get: () => worker, waitForWorkerResults } as never,
      { findBySessionId: vi.fn(async () => binding) } as never,
      { read: vi.fn() } as never,
    );

    await expect(service.waitForWorkers({
      actorSessionId: ACTOR,
      targets: [{ sessionId: WORKER, completionTarget: 1 }],
      timeoutSeconds: 5,
    })).resolves.toMatchObject({ timedOut: false, wait: { state: "settled" } });
    expect(waitForWorkerResults).toHaveBeenCalledWith(expect.anything(), 5_000, 1_200);
  });

  it("refuses to resume another orchestrator's wait ticket", async () => {
    let clock = 0;
    const service = new AgentControlService(
      {
        get: () => worker,
        waitForWorkerResults: async () => {
          clock += 90_000;
          return { timedOut: true, results: [] };
        },
      } as never,
      { findBySessionId: vi.fn(async () => binding) } as never,
      { read: vi.fn() } as never,
      undefined,
      { now: () => clock, segmentSeconds: 90 },
    );

    const first = await service.waitForWorkers({
      actorSessionId: ACTOR,
      targets: [{ sessionId: WORKER, completionTarget: 1 }],
      timeoutSeconds: 600,
    });
    const otherActor = "33333333-3333-4333-8333-333333333333";
    await expect(service.waitForWorkers({
      actorSessionId: otherActor,
      targets: [{ sessionId: WORKER, completionTarget: 1 }],
      timeoutSeconds: 600,
      waitId: first.wait.waitId,
    })).rejects.toMatchObject({ code: "ACTOR_NOT_AUTHORIZED" });
  });

  it("starts a fresh logical wait when a ticket is unknown or already expired", async () => {
    const service = new AgentControlService(
      { get: () => worker, waitForWorkerResults: async () => ({ timedOut: false, results: [] }) } as never,
      { findBySessionId: vi.fn(async () => binding) } as never,
      { read: vi.fn() } as never,
    );

    const result = await service.waitForWorkers({
      actorSessionId: ACTOR,
      targets: [{ sessionId: WORKER, completionTarget: 1 }],
      waitId: "44444444-4444-4444-8444-444444444444",
    });
    expect(result.wait).toMatchObject({ resumed: false, state: "settled" });
    expect(result.wait.waitId).not.toBe("44444444-4444-4444-8444-444444444444");
  });

  it("lists thread status by default and pages instead of returning every field", async () => {
    const threads = Array.from({ length: 5 }, (_, index) => ({
      ...worker,
      id: crypto.randomUUID(),
      name: `worker-${index}`,
      attentionState: "working" as const,
      latestPreview: "x".repeat(3_000),
      launchRecord: { mode: "launch" } as never,
    }));
    const service = new AgentControlService(
      { list: () => threads } as never,
      { findBySessionId: vi.fn(async () => binding) } as never,
      {} as never,
    );

    const page = await service.listThreads({ actorSessionId: ACTOR, limit: 2 });
    expect(page).toMatchObject({ view: "status", total: 5, cursor: 0, returned: 2, nextCursor: 2 });
    expect(page.threads[0]).toEqual({
      id: threads[0]!.id,
      name: "worker-0",
      provider: "codex",
      executionState: "active",
      attentionState: "working",
    });

    const last = await service.listThreads({ actorSessionId: ACTOR, limit: 2, cursor: 4 });
    expect(last).toMatchObject({ returned: 1 });
    expect(last).not.toHaveProperty("nextCursor");

    const full = await service.listThreads({ actorSessionId: ACTOR, view: "full", limit: 1 });
    const record = full.threads[0] as SessionRecord;
    expect(record.latestPreview).toHaveLength(200);
    expect(record).not.toHaveProperty("launchRecord");
    expect(JSON.stringify(page).length).toBeLessThan(JSON.stringify(full).length);
  });

  it("batch-starts workers and preserves independent validation errors", async () => {
    const start = vi.fn(async (request) => ({ ...worker, ...request, id: crypto.randomUUID() }));
    const service = new AgentControlService(
      { start } as never,
      { findBySessionId: vi.fn(async () => binding) } as never,
      {} as never,
    );

    const results = await service.startWorkers({
      actorSessionId: ACTOR,
      workers: [
        { provider: "codex", model: "gpt-5.6-sol", effort: "low", cwd: "/repo/one", prompt: "Ping" },
        { provider: "codex", model: "sol", effort: "low", cwd: "/repo/one", prompt: "Ping" },
      ],
    });

    expect(results).toEqual([
      expect.objectContaining({ ok: true, provider: "codex", model: "gpt-5.6-sol" }),
      expect.objectContaining({
        ok: false,
        provider: "codex",
        model: "sol",
        error: expect.objectContaining({ code: "MODEL_ID_NOT_CANONICAL" }),
      }),
    ]);
    expect(start).toHaveBeenCalledOnce();
  });
});

describe("AgentControlService actor description", () => {
  const SUCCESSOR = "55555555-5555-4555-8555-555555555555";
  const orchestrator: SessionRecord = {
    ...worker,
    id: ACTOR,
    kind: "orchestrator",
    role: "orchestrator",
    orchestratorScope: "fleet",
  };
  const fleetBinding: OrchestratorBinding = {
    ...binding,
    key: "fleet",
    scope: { kind: "fleet" },
    grant: { ...binding.grant, scope: { kind: "fleet" } },
  };

  function service(
    record: SessionRecord | undefined,
    store: { findBySessionId?: unknown; get?: unknown },
  ) {
    return new AgentControlService(
      {
        list: () => (record === undefined ? [] : [record]),
        get: (id: string) => {
          if (record === undefined || record.id !== id) throw new Error("SESSION_NOT_FOUND");
          return record;
        },
      } as never,
      {
        findBySessionId: vi.fn(async () => undefined),
        get: vi.fn(async () => undefined),
        ...store,
      } as never,
      {} as never,
    );
  }

  it("reports a live binding, its scope key, and the capabilities actually held", async () => {
    const control = service(orchestrator, { findBySessionId: vi.fn(async () => fleetBinding) });
    await expect(control.describeActor(ACTOR)).resolves.toMatchObject({
      status: "bound",
      bound: true,
      familyKey: "fleet",
      familyHolderSessionId: ACTOR,
      capabilities: ["thread.list", "thread.read", "worker.start"],
      executionState: "active",
    });
  });

  it("keeps resolving the same actor across /clear, because the grant binds the session", async () => {
    // /clear replaces the provider conversation but not the Cyberdeck session record, so the
    // session UUID the MCP server carries in --actor-session still resolves to its own binding.
    const findBySessionId = vi.fn(async (id: string) => id === ACTOR ? fleetBinding : undefined);
    const control = service(orchestrator, { findBySessionId });
    // The listing is a projected page now, so the binding shows up as a page that resolves at all
    // rather than as a bare array; the actor itself is never one of its own visible threads.
    await expect(control.listThreads(ACTOR)).resolves.toMatchObject({
      view: "status",
      threads: [],
      total: 0,
    });
    await expect(control.describeActor(ACTOR)).resolves.toMatchObject({ status: "bound" });
  });

  it("names the successor holding the scope without lending it the successor's grant", async () => {
    const rebound = { ...fleetBinding, sessionId: SUCCESSOR };
    const control = service(orchestrator, { get: vi.fn(async () => rebound) });
    const description = await control.describeActor(ACTOR);
    expect(description).toMatchObject({
      status: "orphaned",
      bound: false,
      familyKey: "fleet",
      familyHolderSessionId: SUCCESSOR,
    });
    expect(description.capabilities).toBeUndefined();
    expect(description.remedy).toContain(SUCCESSOR);
  });

  it("separates an unknown session from a known session that holds no binding", async () => {
    await expect(service(undefined, {}).describeActor(ACTOR)).resolves.toMatchObject({
      status: "unknown-session",
      bound: false,
    });
    await expect(service(orchestrator, {}).describeActor(ACTOR)).resolves.toMatchObject({
      status: "unbound",
      bound: false,
      familyKey: "fleet",
    });
  });

  it("fails an orphaned tool call with a distinct code instead of a bare denial", async () => {
    const control = service(orchestrator, {
      get: vi.fn(async () => ({ ...fleetBinding, sessionId: SUCCESSOR })),
    });
    await expect(control.listThreads(ACTOR)).rejects.toMatchObject({
      code: "ACTOR_BINDING_ORPHANED",
      message: expect.stringContaining(SUCCESSOR),
    });
    await expect(service(undefined, {}).listThreads(ACTOR)).rejects.toMatchObject({
      code: "ACTOR_NOT_AUTHORIZED",
      message: expect.stringContaining("unknown-session"),
    });
  });
});
