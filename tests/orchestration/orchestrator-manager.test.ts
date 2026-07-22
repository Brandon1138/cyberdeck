import { describe, expect, it, vi } from "vitest";
import { OrchestratorManager } from "../../src/orchestration/orchestrator-manager.js";
import type { OrchestratorBinding } from "../../src/domain/orchestrator.js";
import type { SessionRecord } from "../../src/domain/session.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const record: SessionRecord = {
  id: SESSION_ID,
  provider: "codex",
  model: "gpt-5.6-sol",
  cwd: "/repo/one",
  detached: true,
  sandbox: "read-only",
  role: "orchestrator",
  kind: "orchestrator",
  name: "Cyberdeck orchestrator (codex:gpt-5.6-sol)",
  providerInstructions: "You are the user's Cyberdeck orchestrator.",
  createdAt: "2026-07-22T12:00:00.000Z",
  updatedAt: "2026-07-22T12:00:00.000Z",
  executionState: "active",
  attachmentState: "detached",
  pid: 123,
  exitCode: null,
  childIds: [],
};

const binding: OrchestratorBinding = {
  key: "workspace:/repo/one",
  sessionId: SESSION_ID,
  provider: "codex",
  model: "gpt-5.6-sol",
  cwd: "/repo/one",
  sandbox: "read-only",
  scope: { kind: "workspace", cwd: "/repo/one" },
  grant: {
    subjectSessionId: SESSION_ID,
    capabilities: ["thread.list"],
    scope: { kind: "workspace", cwd: "/repo/one" },
  },
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
};

describe("OrchestratorManager", () => {
  it("creates an explicit scoped orchestrator with native provider instructions and reports ownership", async () => {
    const put = vi.fn(async (_binding: OrchestratorBinding) => undefined);
    const start = vi.fn(async () => record);
    const manager = new OrchestratorManager(
      { start, get: vi.fn(() => record), stop: vi.fn(async () => {}) } as never,
      { get: vi.fn(async () => undefined), put } as never,
    );

    const result = await manager.ensure({
      provider: "codex",
      model: "gpt-5.6-sol",
      cwd: "/repo/one",
      scope: "workspace",
    });

    expect(result).toMatchObject({
      created: true,
      binding: {
        sessionId: SESSION_ID,
        provider: "codex",
        model: "gpt-5.6-sol",
        scope: { kind: "workspace", cwd: "/repo/one" },
        grant: { capabilities: expect.arrayContaining(["thread.read", "thread.enqueue"]) },
      },
    });
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      kind: "orchestrator",
      providerInstructions: expect.stringContaining("Cyberdeck orchestrator"),
    }));
    expect(start.mock.calls[0]).toHaveLength(1);
    expect(put).toHaveBeenCalledOnce();
  });

  it("requires an explicit provider for an unbound scope", async () => {
    const manager = new OrchestratorManager({} as never, { get: vi.fn(async () => undefined) } as never);
    await expect(manager.ensure({ cwd: "/repo/one", scope: "workspace" })).rejects.toMatchObject({
      code: "ORCHESTRATOR_PROVIDER_REQUIRED",
    });
  });

  it("resumes a stopped bound orchestrator and reports it as reused", async () => {
    const stopped = { ...record, executionState: "cancelled" as const };
    const resume = vi.fn(async () => record);
    const manager = new OrchestratorManager(
      { get: vi.fn(() => stopped), resume } as never,
      { get: vi.fn(async () => binding) } as never,
    );

    await expect(manager.ensure({ cwd: "/repo/one", scope: "workspace" })).resolves.toMatchObject({
      created: false,
      session: { executionState: "active" },
    });
    expect(resume).toHaveBeenCalledWith(SESSION_ID);
  });

  it("refuses to orphan an active binding when explicit provider or model changes", async () => {
    const start = vi.fn();
    const manager = new OrchestratorManager(
      { get: vi.fn(() => record), start } as never,
      { get: vi.fn(async () => binding) } as never,
    );

    await expect(manager.ensure({
      provider: "claude",
      model: "sonnet",
      cwd: "/repo/one",
      scope: "workspace",
    })).rejects.toMatchObject({ code: "ORCHESTRATOR_ACTIVE_REBIND_REFUSED" });
    expect(start).not.toHaveBeenCalled();
  });

  it("cleanly replaces an inactive binding when a different provider and model are explicit", async () => {
    const replacement = {
      ...record,
      id: "22222222-2222-4222-8222-222222222222",
      provider: "claude" as const,
      model: "sonnet",
      name: "Cyberdeck orchestrator (claude:sonnet)",
    };
    const put = vi.fn(async (_binding: OrchestratorBinding) => undefined);
    const start = vi.fn(async () => replacement);
    const manager = new OrchestratorManager(
      { get: vi.fn(() => ({ ...record, executionState: "cancelled" })), start } as never,
      { get: vi.fn(async () => binding), put } as never,
    );

    await expect(manager.ensure({
      provider: "claude",
      model: "sonnet",
      cwd: "/repo/one",
      scope: "workspace",
    })).resolves.toMatchObject({
      created: true,
      binding: {
        sessionId: replacement.id,
        provider: "claude",
        model: "sonnet",
      },
    });
    expect(start).toHaveBeenCalledOnce();
    expect(put).toHaveBeenCalledWith(expect.objectContaining({ sessionId: replacement.id }));
  });

  it("resets an inactive binding through an append-only tombstone", async () => {
    const reset = vi.fn(async () => undefined);
    const manager = new OrchestratorManager(
      { get: vi.fn(() => ({ ...record, executionState: "cancelled" })) } as never,
      { get: vi.fn(async () => binding), reset } as never,
    );

    await expect(manager.reset({ cwd: "/repo/one", scope: "workspace" })).resolves.toEqual({
      key: "workspace:/repo/one",
      reset: true,
      sessionId: SESSION_ID,
    });
    expect(reset).toHaveBeenCalledWith("workspace:/repo/one");
  });

  it("refuses to reset an active binding and gives the exact stop command", async () => {
    const reset = vi.fn();
    const manager = new OrchestratorManager(
      { get: vi.fn(() => record) } as never,
      { get: vi.fn(async () => binding), reset } as never,
    );

    await expect(manager.reset({ cwd: "/repo/one", scope: "workspace" })).rejects.toMatchObject({
      code: "ORCHESTRATOR_ACTIVE_RESET_REFUSED",
      message: expect.stringContaining(`cyberdeck stop ${SESSION_ID}`),
    });
    expect(reset).not.toHaveBeenCalled();
  });
});
