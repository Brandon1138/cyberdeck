import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SessionRegistry, type PtyHandle } from "../../src/broker/session-registry.js";
import { BrokerRuntimeConfigSchema } from "../../src/config.js";
import type { OrchestratorBinding } from "../../src/domain/orchestrator.js";
import type { ProviderAdapter } from "../../src/providers/provider.js";
import { InstructionStore } from "../../src/persistence/instruction-store.js";
import { InstructionQueue } from "../../src/orchestration/instruction-queue.js";

/**
 * MIK-64, end to end through the queue an orchestrator's `cyberdeck_thread_message` actually uses.
 *
 * The report: a worker sat at an MCP approval modal, the tool returned `delivered`, and the whole
 * instruction was found in the worker's composer under `tab to queue message` — unsent, never run,
 * and already counted. This proves the two things that must hold instead. Nothing is written into
 * a blocked provider's input surface, and nothing stronger than `rendered` is claimed until the
 * provider is seen to consume it.
 */

const ORCHESTRATOR = "11111111-1111-4111-8111-111111111111";

class FakePty implements PtyHandle {
  readonly pid = 4242;
  readonly writes: Buffer[] = [];
  private readonly outputListeners = new Set<(chunk: Buffer) => void>();
  private replay = "";

  write(data: Buffer): void { this.writes.push(Buffer.from(data)); }
  resize(): void {}
  kill(): void {}
  snapshot(): Buffer { return Buffer.from(this.replay); }
  onOutput(listener: (chunk: Buffer) => void): () => void {
    this.outputListeners.add(listener);
    return () => this.outputListeners.delete(listener);
  }
  onExit(): () => void { return () => undefined; }
  emitOutput(text: string): void {
    this.replay += text;
    for (const listener of this.outputListeners) listener(Buffer.from(text));
  }
}

const claude: ProviderAdapter = {
  id: "claude",
  buildLaunchSpec: (session) => ({ executable: "fake", args: [], cwd: session.cwd, env: {} }),
  buildResumeSpec: (session) => ({ executable: "fake", args: [], cwd: session.cwd, env: {} }),
};

function binding(cwd: string): OrchestratorBinding {
  return {
    key: `workspace:${cwd}`,
    sessionId: ORCHESTRATOR,
    provider: "codex",
    cwd,
    sandbox: "read-only",
    scope: { kind: "workspace", cwd },
    grant: {
      subjectSessionId: ORCHESTRATOR,
      capabilities: ["thread.enqueue"],
      scope: { kind: "workspace", cwd },
    },
    createdAt: "2026-08-14T12:00:00.000Z",
    updatedAt: "2026-08-14T12:00:00.000Z",
  };
}

async function harness() {
  const cwd = await mkdtemp(join(tmpdir(), "cyberdeck-delivery-cwd-"));
  const state = await mkdtemp(join(tmpdir(), "cyberdeck-delivery-state-"));
  const pty = new FakePty();
  const registry = new SessionRegistry({
    adapters: { claude },
    ptyFactory: () => pty,
    journal: { append: async () => {} },
    validateCwd: async () => undefined,
    config: BrokerRuntimeConfigSchema.parse({}),
  });
  const store = new InstructionStore(state);
  const queue = new InstructionQueue(
    registry,
    { findBySessionId: async (sessionId: string) => sessionId === ORCHESTRATOR ? binding(cwd) : undefined } as never,
    store,
  );
  queue.start();
  const worker = await registry.start(
    { provider: "claude", cwd, detached: true, sandbox: "read-only", name: "modal-worker" },
    "Run the checks",
  );
  return { registry, queue, pty, worker };
}

describe("instruction delivery at a blocked worker", () => {
  it("never reports an instruction delivered while it would only sit in the composer", async () => {
    const { registry, queue, pty, worker } = await harness();

    pty.emitOutput([
      "Claude needs your permission to use Bash",
      "  pnpm test",
      "Do you want to proceed?",
      "❯ 1. Yes",
      "  3. No",
    ].join("\r\n"));
    await vi.waitFor(() => expect(registry.get(worker.id).attentionState).toBe("needs-input"));

    const accepted = await queue.enqueue({
      actorSessionId: ORCHESTRATOR,
      targetSessionId: worker.id,
      message: "When the tests finish, run the linter and report back.",
    });

    // The only two honest answers here are `queued` or a later `submitted`. `delivered` is not one
    // of them, and neither is writing the bytes and calling it done.
    expect(accepted).toMatchObject({ status: "queued", holdReason: "provider-modal" });
    expect(pty.writes).toEqual([]);

    // The orchestrator can tell blocked UI from working execution without attaching to the pane.
    expect(registry.workerTruth(worker.id)).toMatchObject({
      state: "blocked-modal",
      terminal: false,
      detail: expect.stringContaining("Blocked on a provider prompt"),
    });

    // The operator answers the prompt: the boundary is safe and the queue flushes itself.
    pty.emitOutput("\u001b]0;⠹ modal-worker\u0007\u001b[2JWorking\r\nesc to interrupt");
    await vi.waitFor(async () =>
      expect((await queue.list(worker.id))[0]).toMatchObject({ status: "rendered", expectedTurn: 1 }));
    expect(pty.writes.at(-1)?.toString()).toBe("When the tests finish, run the linter and report back.\n");

    // The provider consumes the composer and runs. Only now is anything about delivery provable.
    pty.emitOutput("\u001b]0;⠹ modal-worker\u0007\u001b[2JWorking\r\nesc to interrupt");
    await vi.waitFor(async () =>
      expect((await queue.list(worker.id))[0]?.status).toBe("acknowledged"));

    pty.emitOutput("\u001b[2Jlinter clean\r\n\u001b]0;modal-worker\u0007");
    const settled = await registry.waitForWorkerResults([
      { sessionId: worker.id, completionTarget: 1 },
    ], 5_000, 400);
    expect(settled.results[0]).toMatchObject({ status: "completed", completedTurns: 1 });

    // The record walks accepted → queued → rendered → submitted → acknowledged → completed with no
    // gap: `thread_read` can page an instruction through to the turn that answered it.
    await vi.waitFor(async () => {
      const [instruction] = await queue.list(worker.id);
      expect(instruction).toMatchObject({ status: "completed", expectedTurn: 1 });
      expect(instruction?.submittedAt).toEqual(expect.any(String));
      expect(instruction?.completedAt).toEqual(expect.any(String));
    });
    queue.stop();
  });

  it("keeps a second instruction behind the one still holding the composer", async () => {
    const { registry, queue, pty, worker } = await harness();

    pty.emitOutput([
      "\u001b]0;⠹ modal-worker\u0007\u001b[2JDo you want to proceed?",
      "❯ 1. Yes",
    ].join("\r\n"));
    await vi.waitFor(() => expect(registry.get(worker.id).attentionState).toBe("needs-input"));

    const first = await queue.enqueue({
      actorSessionId: ORCHESTRATOR,
      targetSessionId: worker.id,
      message: "First follow-up",
    });
    const second = await queue.enqueue({
      actorSessionId: ORCHESTRATOR,
      targetSessionId: worker.id,
      message: "Second follow-up",
    });

    expect([first.status, second.status]).toEqual(["queued", "queued"]);
    expect(pty.writes).toEqual([]);

    pty.emitOutput("\u001b]0;⠹ modal-worker\u0007\u001b[2JWorking\r\nesc to interrupt");
    await vi.waitFor(async () => {
      const records = await queue.list(worker.id);
      expect(records.map(({ status }) => status)).toEqual(["rendered", "queued"]);
    });
    // Only the first may be written: two payloads in one composer is one payload with the other's
    // text pasted into the middle of it.
    expect(pty.writes.map((write) => write.toString())).toEqual(["First follow-up\n"]);

    // The provider takes the first; the composer is free and the second goes in behind it, in order.
    pty.emitOutput("\u001b]0;\u2839 modal-worker\u0007\u001b[2JWorking\r\nesc to interrupt");
    await vi.waitFor(async () =>
      expect((await queue.list(worker.id))[1]).toMatchObject({ status: "rendered" }));
    expect(pty.writes.map((write) => write.toString())).toEqual([
      "First follow-up\n",
      "Second follow-up\n",
    ]);
    queue.stop();
  });
});
