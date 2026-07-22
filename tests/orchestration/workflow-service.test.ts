import { describe, expect, it, vi } from "vitest";
import { WorkflowService } from "../../src/orchestration/workflow-service.js";
import type { WorkflowMessage, WorkflowRun } from "../../src/domain/workflow.js";
import type { OrchestratorBinding } from "../../src/domain/orchestrator.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const WORKER = "22222222-2222-4222-8222-222222222222";
const binding: OrchestratorBinding = {
  key: "workspace:/repo",
  sessionId: OWNER,
  provider: "codex",
  cwd: "/repo",
  sandbox: "read-only",
  scope: { kind: "workspace", cwd: "/repo" },
  grant: {
    subjectSessionId: OWNER,
    capabilities: ["workflow.run"],
    scope: { kind: "workspace", cwd: "/repo" },
  },
  createdAt: "2026-07-22T12:00:00.000Z",
  updatedAt: "2026-07-22T12:00:00.000Z",
};

function harness() {
  const runs = new Map<string, WorkflowRun>();
  const messages: WorkflowMessage[] = [];
  const enqueue = vi.fn(async () => ({ status: "delivered" }));
  const service = new WorkflowService(
    { get: (id: string) => ({ id, cwd: "/repo" }) } as never,
    { findBySessionId: vi.fn(async (id: string) => id === OWNER ? binding : undefined) } as never,
    {
      putRun: vi.fn(async (run: WorkflowRun) => { runs.set(run.id, run); }),
      listRuns: vi.fn(async () => [...runs.values()]),
      getRun: vi.fn(async (id: string) => runs.get(id)),
      putMessage: vi.fn(async (message: WorkflowMessage) => { messages.push(message); }),
      listMessages: vi.fn(async (id: string) => messages.filter((message) => message.runId === id)),
    } as never,
    { enqueue } as never,
  );
  return { service, enqueue };
}

describe("WorkflowService", () => {
  it("keeps messages passive by default and bounds explicit wake turns", async () => {
    const { service, enqueue } = harness();
    const run = await service.create({
      actorSessionId: OWNER,
      name: "review loop",
      participantSessionIds: [WORKER],
      limits: { maxMessages: 5, maxTurns: 1, maxHops: 2 },
    });

    const passive = await service.send({
      actorSessionId: WORKER,
      runId: run.id,
      targetSessionId: OWNER,
      text: "I finished",
    });
    expect(passive.wake).toBe(false);
    expect(enqueue).not.toHaveBeenCalled();

    const wake = await service.send({
      actorSessionId: OWNER,
      runId: run.id,
      targetSessionId: WORKER,
      text: "Please revise",
      wake: true,
      causationId: passive.messageId,
    });
    expect(wake.hop).toBe(1);
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      actorSessionId: OWNER,
      senderSessionId: OWNER,
      targetSessionId: WORKER,
      workflowRunId: run.id,
    }));

    await expect(service.send({
      actorSessionId: WORKER,
      runId: run.id,
      targetSessionId: OWNER,
      text: "Wake again",
      wake: true,
    })).rejects.toMatchObject({ code: "WORKFLOW_TURN_LIMIT" });
  });

  it("deduplicates message retries and lets the human operator cancel", async () => {
    const { service } = harness();
    const run = await service.create({ actorSessionId: OWNER, name: "bounded", participantSessionIds: [WORKER] });
    const messageId = crypto.randomUUID();
    const first = await service.send({
      actorSessionId: OWNER,
      runId: run.id,
      targetSessionId: WORKER,
      text: "Note",
      messageId,
    });
    await expect(service.send({
      actorSessionId: OWNER,
      runId: run.id,
      targetSessionId: WORKER,
      text: "Duplicate",
      messageId,
    })).resolves.toEqual(first);
    await expect(service.cancel(undefined, run.id, "operator stop")).resolves.toMatchObject({
      status: "cancelled",
      cancelledReason: "operator stop",
    });
  });
});

