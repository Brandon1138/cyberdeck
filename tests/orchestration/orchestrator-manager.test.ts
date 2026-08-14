import { describe, expect, it, vi } from "vitest";
import { OrchestratorManager } from "../../src/orchestration/orchestrator-manager.js";
import {
  CreateOrchestratorRequestSchema,
  EnsureOrchestratorRequestSchema,
  type OrchestratorBinding,
} from "../../src/domain/orchestrator.js";
import type { SessionRecord } from "../../src/domain/session.js";
import { ClaudeProviderAdapter } from "../../src/providers/claude.js";
import { CodexProviderAdapter } from "../../src/providers/codex.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const record: SessionRecord = {
  id: SESSION_ID,
  provider: "codex",
  model: "gpt-5.6-sol",
  effort: "high",
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

/**
 * A registry double that honors `start`'s activation contract: the caller's activation runs before
 * the session is handed back, exactly as the real registry runs it before the provider's first turn.
 * A double that swallowed it would let a manager bug — persisting the grant after `start` resolved —
 * pass every test in this file.
 */
function activatingStart<T extends SessionRecord>(
  resolve: (request: never) => T | Promise<T>,
) {
  return vi.fn(async (
    request: never,
    _initialPrompt?: string,
    activate?: (started: SessionRecord) => Promise<void>,
  ) => {
    const session = await resolve(request);
    await activate?.(session);
    return session;
  });
}

const binding: OrchestratorBinding = {
  key: "workspace:/repo/one",
  sessionId: SESSION_ID,
  provider: "codex",
  model: "gpt-5.6-sol",
  effort: "high",
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
    const start = activatingStart(() => record);
    const manager = new OrchestratorManager(
      { start, get: vi.fn(() => record), stop: vi.fn(async () => {}) } as never,
      { get: vi.fn(async () => undefined), put } as never,
    );

    const result = await manager.ensure({
      provider: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
      cwd: "/repo/one",
      scope: "workspace",
    });

    expect(result).toMatchObject({
      created: true,
      binding: {
        sessionId: SESSION_ID,
        provider: "codex",
        model: "gpt-5.6-sol",
        effort: "high",
        scope: { kind: "workspace", cwd: "/repo/one" },
        grant: { capabilities: expect.arrayContaining(["thread.read", "thread.enqueue"]) },
      },
    });
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      kind: "orchestrator",
      orchestratorScope: "workspace",
      effort: "high",
      providerInstructions: expect.stringContaining("Cyberdeck orchestrator"),
    }), undefined, expect.any(Function));
    const startedRequest = start.mock.calls[0]![0] as { providerInstructions: string };
    const instructions = startedRequest.providerInstructions;
    expect(instructions).toContain("cyberdeck_provider_capabilities");
    expect(instructions).toContain("cyberdeck_workers_start once");
    expect(instructions).toContain("cyberdeck_workers_wait once");
    expect(instructions).toContain("never reread from cursor zero");
    // Request, no initial prompt, and the activation the grant is written from.
    expect(start.mock.calls[0]).toHaveLength(3);
    expect(start.mock.calls[0]![1]).toBeUndefined();
    expect(start.mock.calls[0]![0]).not.toHaveProperty("approvalMode");
    expect(put).toHaveBeenCalledOnce();
    expect(result.binding.grant.capabilities).not.toContain("worker.start.fable");
  });

  it("starts a Claude orchestrator in the persisted automatic permission mode and exposes it", async () => {
    let launchArgs: string[] = [];
    const start = activatingStart((request: object) => {
      const session = {
        ...record,
        ...request,
        provider: "claude" as const,
        model: "opus",
      };
      launchArgs = new ClaudeProviderAdapter().buildLaunchSpec(session).args;
      return session;
    });
    const manager = new OrchestratorManager(
      { start, stop: vi.fn(async () => {}) } as never,
      { get: vi.fn(async () => undefined), put: vi.fn(async () => undefined) } as never,
      undefined,
      undefined,
      {
        list: vi.fn(async () => ({ claude: "automatic" as const })),
        set: vi.fn(async () => undefined),
      },
    );

    await expect(manager.create({
      provider: "claude",
      model: "opus",
      effort: "high",
      cwd: "/repo/one",
      scope: "fleet",
    })).resolves.toMatchObject({
      session: {
        provider: "claude",
        approvalMode: "auto",
      },
    });
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      provider: "claude",
      approvalMode: "auto",
    }), undefined, expect.any(Function));
    expect(launchArgs).toEqual(expect.arrayContaining(["--permission-mode", "auto"]));
  });

  it("starts a Claude orchestrator in persisted permissioned mode", async () => {
    const start = activatingStart((request: object) => ({
      ...record,
      ...request,
      provider: "claude" as const,
      model: "opus",
    }));
    const manager = new OrchestratorManager(
      { start, stop: vi.fn(async () => {}) } as never,
      { get: vi.fn(async () => undefined), put: vi.fn(async () => undefined) } as never,
      undefined,
      undefined,
      {
        list: vi.fn(async () => ({ claude: "permissioned" as const })),
        set: vi.fn(async () => undefined),
      },
    );

    await manager.create({
      provider: "claude",
      model: "opus",
      effort: "high",
      cwd: "/repo/one",
      scope: "fleet",
    });

    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      provider: "claude",
      approvalMode: "prompt",
    }), undefined, expect.any(Function));
  });

  it("keeps an explicit prompt mode ahead of persisted automatic permission policy", async () => {
    let launchArgs: string[] = [];
    const start = activatingStart((request: object) => {
      const session = {
        ...record,
        ...request,
        provider: "claude" as const,
        model: "opus",
      };
      launchArgs = new ClaudeProviderAdapter().buildLaunchSpec(session).args;
      return session;
    });
    const manager = new OrchestratorManager(
      { start, stop: vi.fn(async () => {}) } as never,
      { get: vi.fn(async () => undefined), put: vi.fn(async () => undefined) } as never,
      undefined,
      undefined,
      {
        list: vi.fn(async () => ({ claude: "automatic" as const })),
        set: vi.fn(async () => undefined),
      },
    );

    await manager.create({
      provider: "claude",
      model: "opus",
      effort: "high",
      cwd: "/repo/one",
      scope: "fleet",
      approvalMode: "prompt",
    });

    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      provider: "claude",
      approvalMode: "prompt",
    }), undefined, expect.any(Function));
    expect(launchArgs).toEqual(expect.arrayContaining(["--permission-mode", "plan"]));
  });

  it("starts a Codex orchestrator whose automatic mode reaches the CLI as -a never", async () => {
    let launchArgs: string[] = [];
    const start = vi.fn(async (
      request: object,
      _initialPrompt?: string,
      activate?: (started: SessionRecord) => Promise<void>,
    ) => {
      const session = { ...record, ...request, provider: "codex" as const };
      launchArgs = new CodexProviderAdapter().buildLaunchSpec(session).args;
      await activate?.(session);
      return session;
    });
    const manager = new OrchestratorManager(
      { start, stop: vi.fn(async () => {}) } as never,
      { get: vi.fn(async () => undefined), put: vi.fn(async () => undefined) } as never,
      undefined,
      undefined,
      {
        list: vi.fn(async () => ({ codex: "automatic" as const })),
        set: vi.fn(async () => undefined),
      },
    );

    await expect(manager.create({
      provider: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
      cwd: "/repo/one",
      scope: "fleet",
    })).resolves.toMatchObject({
      session: {
        provider: "codex",
        approvalMode: "auto",
      },
    });
    expect(start.mock.calls[0]?.[0]).toMatchObject({
      provider: "codex",
      approvalMode: "auto",
    });
    expect(launchArgs).toEqual(expect.arrayContaining(["-a", "never"]));
    expect(launchArgs).not.toContain("on-request");
  });

  it("keeps an explicit prompt mode ahead of persisted automatic Codex policy", async () => {
    let launchArgs: string[] = [];
    const start = vi.fn(async (
      request: object,
      _initialPrompt?: string,
      activate?: (started: SessionRecord) => Promise<void>,
    ) => {
      const session = { ...record, ...request, provider: "codex" as const };
      launchArgs = new CodexProviderAdapter().buildLaunchSpec(session).args;
      await activate?.(session);
      return session;
    });
    const manager = new OrchestratorManager(
      { start, stop: vi.fn(async () => {}) } as never,
      { get: vi.fn(async () => undefined), put: vi.fn(async () => undefined) } as never,
      undefined,
      undefined,
      {
        list: vi.fn(async () => ({ codex: "automatic" as const })),
        set: vi.fn(async () => undefined),
      },
    );

    await manager.create({
      provider: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
      cwd: "/repo/one",
      scope: "fleet",
      approvalMode: "prompt",
    });

    expect(launchArgs).toEqual(expect.arrayContaining(["-a", "on-request"]));
  });

  it("persists operator-controlled Fable worker access on the binding", async () => {
    const put = vi.fn(async (_binding: OrchestratorBinding) => undefined);
    const manager = new OrchestratorManager(
      {} as never,
      { get: vi.fn(async () => binding), put } as never,
    );

    await expect(manager.fableWorkers({
      cwd: "/repo/one",
      scope: "workspace",
      enabled: true,
    })).resolves.toEqual({
      key: "workspace:/repo/one",
      configured: true,
      enabled: true,
      sessionId: SESSION_ID,
    });
    expect(put).toHaveBeenCalledWith(expect.objectContaining({
      grant: expect.objectContaining({
        capabilities: ["thread.list", "worker.start.fable"],
      }),
    }));
  });

  it("persists operator-controlled Caveman mode as a box preference", async () => {
    const set = vi.fn(async (preferences) => preferences);
    const manager = new OrchestratorManager(
      {} as never,
      {} as never,
      { get: vi.fn(async () => ({ caveman: false })), set } as never,
    );

    await expect(manager.cavemanWorkers({
      enabled: true,
    })).resolves.toEqual({
      scope: "box",
      enabled: true,
    });
    expect(set).toHaveBeenCalledWith({ caveman: true });
  });

  it("reports the box default without requiring an orchestrator binding", async () => {
    const manager = new OrchestratorManager(
      {} as never,
      {} as never,
      { get: vi.fn(async () => ({ caveman: false })) } as never,
    );
    await expect(manager.cavemanWorkers({})).resolves.toEqual({
      scope: "box",
      enabled: false,
    });
  });

  it("resolves Caveman mode from the box default", async () => {
    const manager = new OrchestratorManager(
      {} as never,
      {} as never,
      { get: vi.fn(async () => ({ caveman: true })) } as never,
    );
    await expect(manager.workerMode()).resolves.toBe("caveman");
  });

  it("reports disabled without creating a grant when no orchestrator is bound", async () => {
    const manager = new OrchestratorManager(
      {} as never,
      { get: vi.fn(async () => undefined) } as never,
    );
    for (const toggle of ["fableWorkers", "cursorWorkers"] as const) {
      await expect(manager[toggle]({ cwd: "/repo/one", scope: "workspace" })).resolves.toEqual({
        key: "workspace:/repo/one",
        configured: false,
        enabled: false,
      });
    }
  });

  it("persists operator-controlled Cursor worker access independently of Fable's", async () => {
    const put = vi.fn(async (_binding: OrchestratorBinding) => undefined);
    const manager = new OrchestratorManager(
      {} as never,
      { get: vi.fn(async () => binding), put } as never,
    );

    await expect(manager.cursorWorkers({
      cwd: "/repo/one",
      scope: "workspace",
      enabled: true,
    })).resolves.toEqual({
      key: "workspace:/repo/one",
      configured: true,
      enabled: true,
      sessionId: SESSION_ID,
    });
    expect(put).toHaveBeenCalledWith(expect.objectContaining({
      grant: expect.objectContaining({
        capabilities: ["thread.list", "worker.start.cursor"],
      }),
    }));
  });

  it("refuses to toggle a grant for a scope with no binding", async () => {
    const manager = new OrchestratorManager(
      {} as never,
      { get: vi.fn(async () => undefined), put: vi.fn() } as never,
    );

    await expect(manager.cursorWorkers({
      cwd: "/repo/one",
      scope: "workspace",
      enabled: true,
    })).rejects.toMatchObject({ code: "ORCHESTRATOR_NOT_CONFIGURED" });
  });

  it("leaves both delegation grants off when an orchestrator is created", async () => {
    const put = vi.fn(async (_binding: OrchestratorBinding) => undefined);
    const manager = new OrchestratorManager(
      { start: activatingStart(() => record), get: vi.fn(() => record) } as never,
      { get: vi.fn(async () => undefined), put } as never,
    );

    await manager.ensure({
      provider: "cursor",
      model: "claude-fable-5-thinking-high",
      cwd: "/repo/one",
      scope: "workspace",
    });

    const created = put.mock.calls[0]![0] as OrchestratorBinding;
    expect(created.grant.capabilities).toContain("worker.start");
    expect(created.grant.capabilities).not.toContain("worker.start.cursor");
    expect(created.grant.capabilities).not.toContain("worker.start.fable");
  });

  // Cursor has no system-prompt flag, so its orchestrator guidance arrives as the session's first
  // message and that turn runs inside `start`. The grant has to answer a tool call made from it.
  it("makes the grant readable back before the orchestrator's first turn", async () => {
    const persisted: OrchestratorBinding[] = [];
    const store = {
      get: vi.fn(async () => undefined),
      put: vi.fn(async (value: OrchestratorBinding) => { persisted.push(value); }),
      findBySessionId: vi.fn(async (sessionId: string) =>
        persisted.findLast((entry) => entry.sessionId === sessionId)),
    };
    const cursorRecord = { ...record, provider: "cursor" as const, model: "kimi-k3-max" };
    let bindingAtFirstTurn: OrchestratorBinding | undefined;
    const start = vi.fn(async (
      _request: never,
      _initialPrompt?: string,
      activate?: (started: SessionRecord) => Promise<void>,
    ) => {
      await activate?.(cursorRecord);
      // Stands in for the guidance turn: what the orchestrator's opening tool call would resolve.
      bindingAtFirstTurn = await store.findBySessionId(cursorRecord.id);
      return cursorRecord;
    });
    const manager = new OrchestratorManager({ start } as never, store as never);

    await expect(manager.ensure({
      provider: "cursor",
      model: "kimi-k3-max",
      cwd: "/repo/one",
      scope: "workspace",
    })).resolves.toMatchObject({ created: true });

    expect(bindingAtFirstTurn).toMatchObject({
      key: "workspace:/repo/one",
      sessionId: cursorRecord.id,
      grant: {
        subjectSessionId: cursorRecord.id,
        capabilities: expect.arrayContaining(["worker.start", "thread.enqueue"]),
      },
    });
  });

  it("takes back a grant it wrote when the rest of the start then fails", async () => {
    const put = vi.fn(async (_binding: OrchestratorBinding) => undefined);
    const reset = vi.fn(async (_key: string) => undefined);
    const start = vi.fn(async (
      _request: never,
      _initialPrompt?: string,
      activate?: (started: SessionRecord) => Promise<void>,
    ) => {
      await activate?.(record);
      throw new Error("Provider session exited during initialization");
    });
    const manager = new OrchestratorManager(
      { start } as never,
      { get: vi.fn(async () => undefined), put, reset } as never,
    );

    await expect(manager.ensure({
      provider: "cursor",
      model: "kimi-k3-max",
      cwd: "/repo/one",
      scope: "workspace",
    })).rejects.toThrow("Provider session exited during initialization");
    expect(put).toHaveBeenCalledOnce();
    expect(reset).toHaveBeenCalledWith("workspace:/repo/one");
  });

  it("restores the binding it replaced when a rebinding start fails", async () => {
    const writes: OrchestratorBinding[] = [];
    const put = vi.fn(async (value: OrchestratorBinding) => { writes.push(value); });
    const reset = vi.fn(async (_key: string) => undefined);
    const start = vi.fn(async (
      _request: never,
      _initialPrompt?: string,
      activate?: (started: SessionRecord) => Promise<void>,
    ) => {
      await activate?.({ ...record, id: "22222222-2222-4222-8222-222222222222" });
      throw new Error("pty allocation failed");
    });
    const manager = new OrchestratorManager(
      { get: vi.fn(() => ({ ...record, executionState: "cancelled" })), start } as never,
      { get: vi.fn(async () => binding), put, reset } as never,
    );

    await expect(manager.ensure({
      provider: "claude",
      model: "sonnet",
      cwd: "/repo/one",
      scope: "workspace",
    })).rejects.toThrow("pty allocation failed");
    expect(writes.at(-1)).toEqual(binding);
    expect(reset).not.toHaveBeenCalled();
  });

  it("accepts the advertised Cursor orchestrator slugs and refuses anything else", async () => {
    const start = activatingStart(() => record);
    const manager = new OrchestratorManager(
      { start, get: vi.fn(() => record), stop: vi.fn(async () => {}) } as never,
      { get: vi.fn(async () => undefined), put: vi.fn(async () => undefined) } as never,
    );

    await expect(manager.create({
      provider: "cursor",
      model: "claude-fable-5-thinking-high",
      cwd: "/repo/one",
      scope: "workspace",
    })).resolves.toMatchObject({ created: true });
    // Effort lives in the slug, so naming one separately is a selection error, not a translation.
    await expect(manager.create({
      provider: "cursor",
      model: "claude-fable-5-thinking-high",
      effort: "high",
      cwd: "/repo/one",
      scope: "workspace",
    })).rejects.toMatchObject({ code: "ORCHESTRATOR_SELECTION_UNSUPPORTED" });
    await expect(manager.create({
      provider: "cursor",
      model: "composer-2.5",
      cwd: "/repo/one",
      scope: "workspace",
    })).rejects.toMatchObject({ code: "ORCHESTRATOR_SELECTION_UNSUPPORTED" });
  });

  it("disables future Fable starts without removing unrelated capabilities", async () => {
    const enabled: OrchestratorBinding = {
      ...binding,
      grant: {
        ...binding.grant,
        capabilities: ["thread.list", "worker.start", "worker.start.fable"],
      },
    };
    const put = vi.fn(async (_binding: OrchestratorBinding) => undefined);
    const manager = new OrchestratorManager(
      {} as never,
      { get: vi.fn(async () => enabled), put } as never,
    );

    await expect(manager.fableWorkers({
      cwd: "/repo/one",
      scope: "workspace",
      enabled: false,
    })).resolves.toMatchObject({ enabled: false });
    expect(put).toHaveBeenCalledWith(expect.objectContaining({
      grant: expect.objectContaining({ capabilities: ["thread.list", "worker.start"] }),
    }));
  });

  it("creates one cwd-independent fleet grant", async () => {
    const put = vi.fn(async (_binding: OrchestratorBinding) => undefined);
    const start = activatingStart((request: Partial<SessionRecord>) => ({ ...record, ...request }));
    const manager = new OrchestratorManager(
      { start, get: vi.fn(() => record), stop: vi.fn(async () => {}) } as never,
      { get: vi.fn(async () => undefined), put } as never,
    );

    await expect(manager.ensure({
      provider: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
      cwd: "/repo/one",
      scope: "fleet",
    })).resolves.toMatchObject({
      binding: {
        key: "fleet",
        scope: { kind: "fleet" },
        grant: { scope: { kind: "fleet" } },
      },
    });
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/repo/one",
      orchestratorScope: "fleet",
    }), undefined, expect.any(Function));
  });

  it("always creates a separately bound peer without consulting or replacing the primary binding", async () => {
    const peer = {
      ...record,
      id: "22222222-2222-4222-8222-222222222222",
    };
    const get = vi.fn(async () => binding);
    const put = vi.fn(async (_binding: OrchestratorBinding) => undefined);
    const start = activatingStart(() => peer);
    const manager = new OrchestratorManager(
      { start, stop: vi.fn(async () => undefined) } as never,
      { get, put } as never,
    );

    await expect(manager.create({
      provider: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
      cwd: "/repo/one",
      scope: "fleet",
    })).resolves.toMatchObject({
      created: true,
      session: { id: peer.id },
      binding: {
        key: `fleet:peer:${peer.id}`,
        sessionId: peer.id,
        grant: {
          subjectSessionId: peer.id,
          capabilities: expect.arrayContaining(["worker.start", "workflow.run"]),
        },
      },
    });
    expect(get).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledOnce();
    expect(put).toHaveBeenCalledWith(expect.objectContaining({
      key: `fleet:peer:${peer.id}`,
      sessionId: peer.id,
    }));
  });

  it("requires an explicit supported provider, model, and effort for a new peer", async () => {
    const start = vi.fn();
    const manager = new OrchestratorManager({ start } as never, {} as never);

    await expect(manager.create({
      provider: "codex",
      model: "sol",
      effort: "high",
      cwd: "/repo/one",
      scope: "fleet",
    })).rejects.toMatchObject({ code: "ORCHESTRATOR_SELECTION_UNSUPPORTED" });
    await expect(manager.create({
      provider: "claude",
      model: "opus",
      effort: "ultra",
      cwd: "/repo/one",
      scope: "fleet",
    })).rejects.toMatchObject({ code: "ORCHESTRATOR_SELECTION_UNSUPPORTED" });
    expect(CreateOrchestratorRequestSchema.safeParse({
      provider: "codex",
      cwd: "/repo/one",
      scope: "fleet",
    }).success).toBe(false);
    expect(start).not.toHaveBeenCalled();
  });

  it("defaults unscoped broker requests to the fleet binding", () => {
    expect(EnsureOrchestratorRequestSchema.parse({ cwd: "/repo/one" }).scope).toBe("fleet");
  });

  it("requires an explicit provider for an unbound scope", async () => {
    const manager = new OrchestratorManager({} as never, { get: vi.fn(async () => undefined) } as never);
    await expect(manager.ensure({ cwd: "/repo/one", scope: "workspace" })).rejects.toMatchObject({
      code: "ORCHESTRATOR_PROVIDER_REQUIRED",
    });
  });

  it.each([
    ["antigravity", "its adapter has no supported MCP surface"],
  ])("refuses %s when it cannot receive the Cyberdeck MCP server", async (provider, reason) => {
    const start = vi.fn();
    const manager = new OrchestratorManager(
      { start } as never,
      { get: vi.fn(async () => undefined) } as never,
    );

    await expect(manager.ensure({
      provider: provider as "antigravity",
      cwd: "/repo/one",
      scope: "workspace",
    })).rejects.toMatchObject({
      code: "ORCHESTRATOR_PROVIDER_UNSUPPORTED",
      message: `Orchestrator provider ${provider} cannot receive the Cyberdeck MCP server; ${reason}`,
    });
    expect(start).not.toHaveBeenCalled();
  });

  it.each([
    ["antigravity"],
  ])("refuses a durable %s binding before resuming it", async (provider) => {
    const inert: OrchestratorBinding = { ...binding, provider: provider as "antigravity" };
    const get = vi.fn(() => record);
    const resume = vi.fn(async () => record);
    const start = vi.fn();
    const manager = new OrchestratorManager(
      { get, resume, start } as never,
      { get: vi.fn(async () => inert) } as never,
    );

    await expect(manager.ensure({ cwd: "/repo/one", scope: "workspace" })).rejects.toMatchObject({
      code: "ORCHESTRATOR_PROVIDER_UNSUPPORTED",
      message:
        `Orchestrator provider ${provider} cannot receive the Cyberdeck MCP server; its adapter has no supported MCP surface`,
    });
    expect(get).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("refuses a durable unsupported binding through the direct get entry point", async () => {
    const get = vi.fn(() => record);
    const resume = vi.fn(async () => record);
    const manager = new OrchestratorManager(
      { get, resume } as never,
      { get: vi.fn(async () => ({ ...binding, provider: "antigravity" as const })) } as never,
    );

    await expect(manager.get("/repo/one", "workspace")).rejects.toMatchObject({
      code: "ORCHESTRATOR_PROVIDER_UNSUPPORTED",
    });
    expect(get).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });

  it("still resumes a supported existing binding when the request omits a provider", async () => {
    for (const provider of ["codex", "claude"] as const) {
      const existing: OrchestratorBinding = { ...binding, provider };
      const resume = vi.fn(async () => ({ ...record, provider }));
      const manager = new OrchestratorManager(
        { get: vi.fn(() => ({ ...record, executionState: "cancelled" })), resume } as never,
        { get: vi.fn(async () => existing) } as never,
      );

      await expect(manager.ensure({ cwd: "/repo/one", scope: "workspace" })).resolves.toMatchObject({
        created: false,
        binding: { provider },
      });
      expect(resume).toHaveBeenCalledWith(SESSION_ID);
    }
  });

  it("allows Claude orchestrator creation", async () => {
    const start = activatingStart(() => ({ ...record, provider: "claude" as const }));
    const manager = new OrchestratorManager(
      { start } as never,
      { get: vi.fn(async () => undefined), put: vi.fn(async () => undefined) } as never,
    );

    await expect(manager.ensure({
      provider: "claude",
      model: "opus",
      cwd: "/repo/one",
      scope: "workspace",
    })).resolves.toMatchObject({ created: true, binding: { provider: "claude" } });
    expect(start).toHaveBeenCalledOnce();
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

  it("creates a fresh explicit orchestrator when native resume is unavailable", async () => {
    const stopped = { ...record, executionState: "cancelled" as const };
    const replacement = {
      ...record,
      id: "22222222-2222-4222-8222-222222222222",
    };
    const resume = vi.fn(async () => {
      throw Object.assign(new Error("native conversation missing"), { code: "SESSION_RESUME_UNAVAILABLE" });
    });
    const start = activatingStart(() => replacement);
    const put = vi.fn(async (_binding: OrchestratorBinding) => undefined);
    const manager = new OrchestratorManager(
      { get: vi.fn(() => stopped), resume, start } as never,
      { get: vi.fn(async () => binding), put } as never,
    );

    await expect(manager.ensure({
      provider: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
      cwd: "/repo/one",
      scope: "workspace",
    })).resolves.toMatchObject({
      created: true,
      session: { id: replacement.id },
    });
    expect(resume).toHaveBeenCalledWith(SESSION_ID);
    expect(start).toHaveBeenCalledOnce();
    expect(put).toHaveBeenCalledWith(expect.objectContaining({ sessionId: replacement.id }));
  });

  it("does not create a duplicate when resume fails for an unrelated reason", async () => {
    const stopped = { ...record, executionState: "cancelled" as const };
    const start = vi.fn();
    const manager = new OrchestratorManager(
      {
        get: vi.fn(() => stopped),
        resume: vi.fn(async () => { throw new Error("PTY allocation failed"); }),
        start,
      } as never,
      { get: vi.fn(async () => binding) } as never,
    );

    await expect(manager.ensure({
      provider: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
      cwd: "/repo/one",
      scope: "workspace",
    })).rejects.toThrow("PTY allocation failed");
    expect(start).not.toHaveBeenCalled();
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
    const start = activatingStart(() => replacement);
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

  it("clears the matching binding before an orchestrator session record is deleted", async () => {
    const reset = vi.fn(async () => undefined);
    const manager = new OrchestratorManager(
      {} as never,
      { findBySessionId: vi.fn(async () => binding), reset } as never,
    );

    await expect(manager.resetSessionBinding(SESSION_ID)).resolves.toEqual({
      reset: true,
      key: "workspace:/repo/one",
    });
    expect(reset).toHaveBeenCalledWith("workspace:/repo/one");
  });

  describe("custody colors", () => {
    const custodyColors = () => ({
      assign: vi.fn(async () => 0),
      release: vi.fn(async () => undefined),
    });
    const spawning = () => ({
      start: activatingStart(() => record),
      get: vi.fn(() => record),
      stop: vi.fn(async () => {}),
    });
    const unbound = () => ({ get: vi.fn(async () => undefined), put: vi.fn(async () => undefined) });

    it("assigns the spawning orchestrator's durable controller a slot", async () => {
      const colors = custodyColors();
      const manager = new OrchestratorManager(
        spawning() as never,
        unbound() as never,
        undefined,
        colors,
      );

      await manager.ensure({
        provider: "codex",
        model: "gpt-5.6-sol",
        effort: "high",
        cwd: "/repo/one",
        scope: "workspace",
      });

      expect(colors.assign).toHaveBeenCalledWith("orchestrator:workspace:/repo/one");
    });

    it("gives a peer its own slot, because a peer owns workers like any orchestrator", async () => {
      const colors = custodyColors();
      const manager = new OrchestratorManager(
        spawning() as never,
        unbound() as never,
        undefined,
        colors,
      );

      await manager.create({
        provider: "codex",
        model: "gpt-5.6-sol",
        effort: "high",
        cwd: "/repo/one",
        scope: "workspace",
      });

      expect(colors.assign).toHaveBeenCalledWith(
        expect.stringMatching(/^orchestrator:workspace:\/repo\/one:peer:/),
      );
    });

    it("releases the slot on both reset paths", async () => {
      const colors = custodyColors();
      const store = {
        get: vi.fn(async () => binding),
        findBySessionId: vi.fn(async () => binding),
        reset: vi.fn(async () => undefined),
      };
      const manager = new OrchestratorManager(
        { get: vi.fn(() => ({ ...record, executionState: "cancelled" })) } as never,
        store as never,
        undefined,
        colors,
      );

      await manager.reset({ cwd: "/repo/one", scope: "workspace" });
      await manager.resetSessionBinding(SESSION_ID);

      expect(colors.release.mock.calls).toEqual([
        ["orchestrator:workspace:/repo/one"],
        ["orchestrator:workspace:/repo/one"],
      ]);
    });

    it("spawns the orchestrator anyway when the color ledger fails", async () => {
      const colors = {
        assign: vi.fn(async () => { throw new Error("ledger unavailable"); }),
        release: vi.fn(async () => { throw new Error("ledger unavailable"); }),
      };
      const manager = new OrchestratorManager(
        spawning() as never,
        unbound() as never,
        undefined,
        colors,
      );

      await expect(manager.ensure({
        provider: "codex",
        model: "gpt-5.6-sol",
        effort: "high",
        cwd: "/repo/one",
        scope: "workspace",
      })).resolves.toMatchObject({ created: true });
    });
  });
});
