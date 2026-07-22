import { describe, expect, it, vi } from "vitest";
import { OrchestratorManager } from "../../src/orchestration/orchestrator-manager.js";
import type { OrchestratorBinding } from "../../src/domain/orchestrator.js";
import type { SessionRecord } from "../../src/domain/session.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const record: SessionRecord = {
  id: SESSION_ID,
  provider: "codex",
  model: "sol",
  cwd: "/repo/one",
  detached: true,
  sandbox: "read-only",
  role: "orchestrator",
  name: "Cyberdeck orchestrator (codex:sol)",
  createdAt: "2026-07-22T12:00:00.000Z",
  updatedAt: "2026-07-22T12:00:00.000Z",
  executionState: "active",
  attachmentState: "detached",
  pid: 123,
  exitCode: null,
  childIds: [],
};

describe("OrchestratorManager", () => {
  it("creates an explicit scoped orchestrator with capability grant", async () => {
    const put = vi.fn(async (_binding: OrchestratorBinding) => undefined);
    const manager = new OrchestratorManager(
      { start: vi.fn(async () => record), get: vi.fn(() => record) } as never,
      { get: vi.fn(async () => undefined), put } as never,
    );

    const result = await manager.ensure({ provider: "codex", model: "sol", cwd: "/repo/one", scope: "workspace" });

    expect(result.binding).toMatchObject({
      sessionId: SESSION_ID,
      provider: "codex",
      model: "sol",
      scope: { kind: "workspace", cwd: "/repo/one" },
      grant: { capabilities: expect.arrayContaining(["thread.read", "thread.enqueue"]) },
    });
    expect(put).toHaveBeenCalledOnce();
  });

  it("requires an explicit provider for an unbound scope", async () => {
    const manager = new OrchestratorManager({} as never, { get: vi.fn(async () => undefined) } as never);
    await expect(manager.ensure({ cwd: "/repo/one", scope: "workspace" })).rejects.toMatchObject({
      code: "ORCHESTRATOR_PROVIDER_REQUIRED",
    });
  });

  it("resumes a stopped bound orchestrator before returning it to tmux", async () => {
    const stopped = { ...record, executionState: "cancelled" as const };
    const existing = {
      key: "workspace:/repo/one",
      sessionId: SESSION_ID,
      provider: "codex" as const,
      model: "sol",
      cwd: "/repo/one",
      sandbox: "read-only" as const,
      scope: { kind: "workspace" as const, cwd: "/repo/one" },
      grant: {
        subjectSessionId: SESSION_ID,
        capabilities: ["thread.list" as const],
        scope: { kind: "workspace" as const, cwd: "/repo/one" },
      },
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
    const resume = vi.fn(async () => record);
    const manager = new OrchestratorManager(
      { get: vi.fn(() => stopped), resume } as never,
      { get: vi.fn(async () => existing) } as never,
    );

    await expect(manager.ensure({ cwd: "/repo/one", scope: "workspace" })).resolves.toMatchObject({
      session: { executionState: "active" },
    });
    expect(resume).toHaveBeenCalledWith(SESSION_ID);
  });
});
