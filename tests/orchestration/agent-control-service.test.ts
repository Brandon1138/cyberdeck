import { describe, expect, it, vi } from "vitest";
import { AgentControlService } from "../../src/orchestration/agent-control-service.js";
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
});

