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

    await expect(service.listThreads(ACTOR)).resolves.toEqual([worker]);
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
    })).resolves.toEqual({ timedOut: false, results: [] });
    expect(waitForWorkerResults).toHaveBeenCalledWith(
      [{ sessionId: WORKER, completionTarget: 1 }],
      30_000,
      800,
    );
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
