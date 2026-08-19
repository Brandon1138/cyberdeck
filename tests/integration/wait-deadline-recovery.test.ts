import { describe, expect, it, vi } from "vitest";
import { SessionRegistry } from "../../src/broker/session-registry.js";
import { BrokerRuntimeConfigSchema } from "../../src/config.js";
import type { OrchestratorBinding } from "../../src/domain/orchestrator.js";
import type { SessionRuntime } from "../../src/domain/session-runtime.js";
import type { ProviderAdapter, ProviderLaunchSpec } from "../../src/providers/provider.js";
import { AgentControlService } from "../../src/orchestration/agent-control-service.js";

const ACTOR = "11111111-1111-4111-8111-111111111111";
const CWD = "/tmp/repo";

/**
 * Production runs a 90s transport segment against a 600s logical budget. These tests keep that
 * ratio at 1s against 5s so a real registry, real timers, and several real segments all take part.
 */
const SEGMENT_SECONDS = 1;
const TIMEOUT_SECONDS = 5;

class FakePty implements SessionRuntime {
  readonly pid = 4242;
  private replay = "";
  private readonly outputListeners = new Set<(chunk: Buffer) => void>();
  private readonly exitListeners = new Set<(exitCode: number, signal?: number) => void>();

  write(): void {}
  resize(): void {}
  snapshot(): Buffer { return Buffer.from(this.replay); }
  kill(): void { for (const listener of this.exitListeners) listener(0); }
  onOutput(listener: (chunk: Buffer) => void): () => void {
    this.outputListeners.add(listener);
    return () => this.outputListeners.delete(listener);
  }
  onExit(listener: (exitCode: number, signal?: number) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }
  emitOutput(text: string): void {
    this.replay += text;
    for (const listener of this.outputListeners) listener(Buffer.from(text));
  }
}

const adapter: ProviderAdapter = {
  id: "codex",
  buildLaunchSpec: (session) => ({ executable: "fake", args: [], cwd: session.cwd, env: {} }),
  buildResumeSpec: (session) => ({ executable: "fake", args: [], cwd: session.cwd, env: {} }),
};

const binding: OrchestratorBinding = {
  key: `workspace:${CWD}`,
  kind: "primary",
  sessionId: ACTOR,
  provider: "codex",
  cwd: CWD,
  sandbox: "workspace-write",
  scope: { kind: "workspace", cwd: CWD },
  grant: {
    subjectSessionId: ACTOR,
    capabilities: ["thread.list", "thread.read", "worker.start"],
    scope: { kind: "workspace", cwd: CWD },
  },
  createdAt: "2026-07-25T12:00:00.000Z",
  updatedAt: "2026-07-25T12:00:00.000Z",
};

function harness() {
  const ptys: FakePty[] = [];
  const ptyFactory = vi.fn((_spec: ProviderLaunchSpec) => {
    const pty = new FakePty();
    ptys.push(pty);
    return pty;
  });
  const registry = new SessionRegistry({
    adapters: { codex: adapter },
    sessionRuntimeFactory: ptyFactory,
    journal: { append: async () => {} },
    validateCwd: async () => undefined,
    config: BrokerRuntimeConfigSchema.parse({}),
  });
  const service = new AgentControlService(
    registry,
    { findBySessionId: async () => binding } as never,
    {} as never,
    undefined,
    { segmentSeconds: SEGMENT_SECONDS },
  );
  return { registry, service, ptys, ptyFactory };
}

/** Marks a worker turn as started and then finished, the way a provider's title bar does. */
function runTurn(pty: FakePty, name: string, output: string): void {
  pty.emitOutput(`\u001b]0;⠹ ${name}\u0007\u001b[2JWorking`);
  pty.emitOutput(`\u001b[2J${output}\r\n\u001b]0;${name}\u0007`);
}

async function startInstallWorker(registry: SessionRegistry) {
  return registry.start({
    provider: "codex",
    cwd: CWD,
    detached: true,
    sandbox: "workspace-write",
    name: "device-install",
  });
}

describe("worker wait deadlines", () => {
  it("honors a wait longer than one transport segment without a transport failure", async () => {
    const { registry, service, ptys } = harness();
    const record = await startInstallWorker(registry);
    const pty = ptys[0]!;
    pty.emitOutput("\u001b]0;⠹ device-install\u0007\u001b[2JWorking");
    // Finishes well after a single segment would have been killed, as the 300s repro did.
    setTimeout(() => runTurn(pty, "device-install", "device install applied"), 2_400);

    const durations: number[] = [];
    let outcome = await measure(durations, () => service.waitForWorkers({
      actorSessionId: ACTOR,
      targets: [{ sessionId: record.id, completionTarget: 1 }],
      timeoutSeconds: TIMEOUT_SECONDS,
    }));
    expect(outcome.wait).toMatchObject({ state: "incomplete", timeoutSeconds: TIMEOUT_SECONDS });

    while (outcome.wait.state === "incomplete") {
      outcome = await measure(durations, () => service.waitForWorkers({
        actorSessionId: ACTOR,
        targets: [{ sessionId: record.id, completionTarget: 1 }],
        timeoutSeconds: TIMEOUT_SECONDS,
        waitId: outcome.wait.waitId,
      }));
    }

    expect(durations.length).toBeGreaterThan(1);
    // Every individual call — the thing an MCP client puts a deadline on — stayed inside a segment.
    for (const duration of durations) expect(duration).toBeLessThan(SEGMENT_SECONDS * 1_500);
    expect(outcome).toMatchObject({
      timedOut: false,
      wait: { state: "settled" },
      results: [{ status: "completed", text: expect.stringContaining("device install applied") }],
    });
  });

  it("reports an exhausted budget as a normal timeout carrying the worker's live status", async () => {
    const { registry, service, ptys } = harness();
    const record = await startInstallWorker(registry);
    ptys[0]!.emitOutput("\u001b]0;⠹ device-install\u0007\u001b[2JWorking");

    let outcome = await service.waitForWorkers({
      actorSessionId: ACTOR,
      targets: [{ sessionId: record.id, completionTarget: 1 }],
      timeoutSeconds: 2,
    });
    while (outcome.wait.state === "incomplete") {
      outcome = await service.waitForWorkers({
        actorSessionId: ACTOR,
        targets: [{ sessionId: record.id, completionTarget: 1 }],
        timeoutSeconds: 2,
        waitId: outcome.wait.waitId,
      });
    }

    expect(outcome).toMatchObject({
      timedOut: true,
      wait: { state: "timed-out", remainingSeconds: 0 },
      results: [{ status: "working" }],
    });
  });

  it("answers threads_list promptly while a wait is in flight", async () => {
    const { registry, service, ptys } = harness();
    const record = await startInstallWorker(registry);
    ptys[0]!.emitOutput("\u001b]0;⠹ device-install\u0007\u001b[2JWorking");
    const waiting = service.waitForWorkers({
      actorSessionId: ACTOR,
      targets: [{ sessionId: record.id, completionTarget: 1 }],
      timeoutSeconds: TIMEOUT_SECONDS,
    });

    const startedAt = Date.now();
    const page = await service.listThreads({ actorSessionId: ACTOR });
    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(page).toMatchObject({
      view: "status",
      total: 1,
      threads: [{ id: record.id, name: "device-install", attentionState: "working" }],
    });
    await waiting;
  });
});

describe("duplicate-safe recovery after a wait transport failure", () => {
  it("replays the completion that landed while the caller's transport was dead", async () => {
    const { registry, service, ptys, ptyFactory } = harness();
    const record = await startInstallWorker(registry);
    const pty = ptys[0]!;
    const target = { sessionId: record.id, completionTarget: 1 };

    // The orchestrator's tools/call dies here; the broker keeps the wait and the worker keeps going.
    const abandoned = service.waitForWorkers({
      actorSessionId: ACTOR,
      targets: [target],
      timeoutSeconds: TIMEOUT_SECONDS,
    });
    runTurn(pty, "device-install", "device install applied");
    await abandoned;

    // Recovery path: same sessionId, same completionTarget, no transcript reading.
    const recovered = await service.waitForWorkers({
      actorSessionId: ACTOR,
      targets: [target],
      timeoutSeconds: TIMEOUT_SECONDS,
    });
    expect(recovered).toMatchObject({
      timedOut: false,
      wait: { state: "settled" },
      results: [{
        status: "completed",
        retrieval: "replay",
        text: expect.stringContaining("device install applied"),
      }],
    });

    // "replay" is the evidence the mutation already ran, so no second installer may be launched.
    const decision = recovered.results[0]?.status === "completed" ? "reuse" : "relaunch";
    expect(decision).toBe("reuse");
    if (decision !== "reuse") await startInstallWorker(registry);
    expect(ptyFactory).toHaveBeenCalledOnce();
    expect(registry.list()).toHaveLength(1);

    // Repeating the recovery stays stable rather than resurfacing as fresh work.
    const again = await service.waitForWorkers({
      actorSessionId: ACTOR,
      targets: [target],
      timeoutSeconds: TIMEOUT_SECONDS,
    });
    expect(again.results[0]).toMatchObject({
      retrieval: "replay",
      completedAt: recovered.results[0]?.completedAt,
      text: recovered.results[0]?.text,
    });
  });
});

async function measure<T>(durations: number[], call: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  try {
    return await call();
  } finally {
    durations.push(Date.now() - startedAt);
  }
}
