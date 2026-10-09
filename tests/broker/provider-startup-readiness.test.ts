import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionRegistry } from "../../src/broker/session-registry.js";
import { WorkerCoordinationService } from "../../src/broker/worker-coordination.js";
import { BrokerWorkerLeaseCredentialCustodian } from "../../src/broker/worker-lease-credential-custodian.js";
import { BrokerRuntimeConfigSchema } from "../../src/config.js";
import type { OrchestratorBinding } from "../../src/domain/orchestrator.js";
import { ORCHESTRATOR_GRANT_CAPABILITIES } from "../../src/domain/orchestrator.js";
import type { SessionRuntime } from "../../src/domain/session-runtime.js";
import type { ProviderId } from "../../src/domain/session.js";
import { InstructionQueue } from "../../src/orchestration/instruction-queue.js";
import { WorkerHandoffService } from "../../src/orchestration/worker-handoff-service.js";
import { InstructionStore } from "../../src/persistence/instruction-store.js";
import { WorkerCoordinationStore } from "../../src/persistence/worker-coordination-store.js";
import { ClaudeProviderAdapter } from "../../src/providers/claude.js";
import { CodexProviderAdapter } from "../../src/providers/codex.js";
import type { ProviderAdapter } from "../../src/providers/provider.js";
import { WorkerTurnObservationAdapter } from "../../src/runtime/worker-turn-observation-adapter.js";

const CLEAR = "\u001b[2J";
const READY = {
  codex: `\u001b]0;Codex\u0007${CLEAR}› Ask Codex to do anything\n  ? for shortcuts  100% context left\n`,
  claude: `\u001b]0;Claude\u0007${CLEAR}────────────────────\n❯ \n────────────────────\n  ? for shortcuts\n`,
  cursor: `${CLEAR}→ Add a follow-up\n`,
  antigravity: `${CLEAR}│ > Ask Gemini about this codebase │\n? for shortcuts\n`,
} as const;

class ScriptedRuntime implements SessionRuntime {
  readonly pid = 4242;
  readonly writes: Buffer[] = [];
  private replay = "";
  private output = new Set<(chunk: Buffer) => void>();
  private exit = new Set<(code: number) => void>();
  write(data: Buffer) { this.writes.push(Buffer.from(data)); }
  resize() {}
  snapshot() { return Buffer.from(this.replay); }
  kill() { for (const listener of this.exit) listener(0); }
  onOutput(listener: (chunk: Buffer) => void) {
    this.output.add(listener);
    return () => { this.output.delete(listener); };
  }
  onExit(listener: (code: number) => void) {
    this.exit.add(listener);
    return () => { this.exit.delete(listener); };
  }
  emit(text: string) {
    this.replay += text;
    for (const listener of this.output) listener(Buffer.from(text));
  }
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
});

async function harness(provider: ProviderId = "codex", initialPrompt?: string) {
  const directory = await mkdtemp(join(tmpdir(), "cyberdeck-startup-test-"));
  const handles: ScriptedRuntime[] = [];
  const adapter: ProviderAdapter = provider === "claude"
    ? new ClaudeProviderAdapter({ directory })
    : provider === "codex"
      ? new CodexProviderAdapter({
          runCommand: async () => '{"status":"connected"}',
          nativeSessionId: "11111111-1111-4111-8111-111111111111",
        })
      : {
          id: provider,
          buildLaunchSpec: (session) => ({ executable: "fixture", args: [], cwd: session.cwd, env: {} }),
          buildResumeSpec: (session) => ({ executable: "fixture", args: [], cwd: session.cwd, env: {} }),
        };
  const registry = new SessionRegistry({
    config: BrokerRuntimeConfigSchema.parse({}),
    workerTurnObservation: new WorkerTurnObservationAdapter(),
    adapters: { [provider]: adapter },
    sessionRuntimeFactory: () => {
      const handle = new ScriptedRuntime();
      handles.push(handle);
      return handle;
    },
    validateCwd: async () => undefined,
    journal: { append: async () => undefined },
  });
  const record = await registry.start({
    provider, model: provider === "claude" ? "opus" : undefined,
    cwd: directory, sandbox: "read-only", detached: true, kind: "orchestrator",
  }, initialPrompt);
  const binding: OrchestratorBinding = {
    key: "fleet", kind: "primary", sessionId: record.id, provider,
    cwd: directory, sandbox: "read-only", scope: { kind: "fleet" },
    grant: { subjectSessionId: record.id, capabilities: [...ORCHESTRATOR_GRANT_CAPABILITIES], scope: { kind: "fleet" } },
    createdAt: record.createdAt, updatedAt: record.createdAt,
  };
  const store = new InstructionStore(directory);
  const queue = new InstructionQueue(registry, { findBySessionId: async () => binding }, store);
  queue.start();
  cleanups.push(async () => {
    queue.stop();
    await registry.stop(record.id);
    await rm(directory, { recursive: true, force: true });
  });
  const enqueue = (message: string, messageId: string = randomUUID()) => queue.enqueue({
    actorSessionId: record.id, targetSessionId: record.id, message, messageId,
  });
  return { registry, record, handles, queue, enqueue, store, directory, binding };
}

describe("automated provider startup delivery", () => {
  it.each(["codex", "claude", "cursor", "antigravity"] as const)(
    "keeps the first %s brief durable through blank output, idle titles, and wait timeout",
    async (provider) => {
      const { registry, record, handles, queue, enqueue, directory } = await harness(provider);
      const brief = await enqueue("Read the handoff and begin.");
      expect(brief).toMatchObject({ status: "queued", holdReason: "provider-starting" });
      expect(handles[0]!.writes).toEqual([]);
      handles[0]!.emit(`\u001b]0;New session\u0007${CLEAR}Loading provider…\n`);
      await queue.flush(record.id);
      expect(handles[0]!.writes).toEqual([]);
      expect(registry.workerTruth(record.id)).toMatchObject({ state: "starting", completedTurns: 0 });
      const wait = await registry.waitForWorkerResults([{ sessionId: record.id, completionTarget: 1 }], 1, 300);
      expect(wait.timedOut).toBe(true);
      expect((await new InstructionStore(directory).list())[0])
        .toMatchObject({ id: brief.id, status: "queued" });
      expect(await enqueue(brief.message, brief.messageId)).toMatchObject({ id: brief.id, status: "queued" });
      expect(handles).toHaveLength(1);
      expect(handles[0]!.writes).toEqual([]);
    },
  );

  it.each(["codex", "claude"] as const)("holds %s trust/permission UI without answering it", async (provider) => {
    const { registry, record, handles, queue, enqueue } = await harness(provider);
    await enqueue("Start the task.");
    handles[0]!.emit(`${CLEAR}Do you trust the contents of this project?\n❯ 1. Yes\nEnter to confirm\n`);
    await queue.flush(record.id);
    expect((await queue.list(record.id))[0]).toMatchObject({ status: "queued", holdReason: "provider-modal" });
    expect(registry.workerTruth(record.id)).toMatchObject({ state: "blocked-modal" });
    expect(handles[0]!.writes).toEqual([]);
  });

  it.each(["codex", "claude", "cursor", "antigravity"] as const)(
    "releases %s briefs once in FIFO order and distinguishes rendering from consumption",
    async (provider) => {
      const { registry, record, handles, queue, enqueue } = await harness(provider);
      const first = await enqueue("First brief.");
      const second = await enqueue("Later handoff.");
      handles[0]!.emit(`\u001b]0;⠹ Startup\u0007${CLEAR}⠹ Composing\nesc to interrupt\n`);
      handles[0]!.emit(READY[provider]);
      await vi.waitFor(async () => expect((await queue.list(record.id))[0]?.status).toBe("rendered"));
      expect(handles[0]!.writes).toHaveLength(1);
      expect(handles[0]!.writes[0]!.toString()).toContain(first.message);
      const rendered = (await queue.list(record.id))[0]!;
      expect(rendered.expectedTurn).toBe(1);
      expect(rendered.submittedAt).toBeUndefined();
      expect(registry.workerTruth(record.id).completedTurns).toBe(0);
      handles[0]!.emit(`\u001b]0;⠹ Working\u0007${CLEAR}⠹ Composing\nesc to interrupt\n`);
      await vi.waitFor(async () => expect((await queue.list(record.id))[0]?.status).toBe("acknowledged"));
      expect(handles[0]!.writes).toHaveLength(1);
      handles[0]!.emit(`\u001b]0;Ready\u0007${READY[provider]}`);
      await vi.waitFor(async () => expect((await queue.list(record.id))[1]?.status).toBe("rendered"));
      expect(handles[0]!.writes).toHaveLength(2);
      expect(handles[0]!.writes[1]!.toString()).toContain(second.message);
      expect((await queue.list(record.id))[1]).toMatchObject({ expectedTurn: 2 });
      await queue.flush(record.id);
      expect(handles[0]!.writes).toHaveLength(2);
    },
  );

  it.each(["codex", "claude"] as const)("preserves the first %s turn started through native launch arguments", async (provider) => {
    const { registry, record, handles } = await harness(provider, "Answer the launch prompt.");
    handles[0]!.emit(`\u001b]0;⠹ Working\u0007${CLEAR}Working\nesc to interrupt\n`);
    handles[0]!.emit(`${READY[provider]}\n`);
    await vi.waitFor(() => expect(registry.workerTruth(record.id).completedTurns).toBe(1));
    expect(handles[0]!.writes).toEqual([]);
  });

  it("keeps human control ahead of a Claude startup brief and flushes after detach", async () => {
    const { registry, record, handles, queue, enqueue } = await harness("claude");
    await registry.attach(record.id, "human", "control", () => undefined);
    expect(await enqueue("Read this after I detach.")).toMatchObject({ status: "queued", holdReason: "human-controller" });
    handles[0]!.emit(READY.claude);
    await queue.flush(record.id);
    expect(handles[0]!.writes).toEqual([]);
    await registry.detach(record.id, "human");
    await vi.waitFor(async () => expect((await queue.list(record.id))[0]?.status).toBe("rendered"));
    expect(handles[0]!.writes).toHaveLength(1);
  });

  it("keeps a directed Claude handoff durable during startup and replays it until explicit acknowledgement", async () => {
    const { registry, record, handles, queue, directory, binding } = await harness("claude");
    const worker = await registry.start({
      provider: "claude", model: "opus", kind: "worker", cwd: directory, sandbox: "read-only", detached: true,
    });
    cleanups.push(async () => { await registry.stop(worker.id); });
    const coordination = new WorkerCoordinationService({ store: new WorkerCoordinationStore(directory) });
    await coordination.initialize();
    const credentials = new BrokerWorkerLeaseCredentialCustodian();
    const handoffs = new WorkerHandoffService({
      registry, coordination, credentials, instructions: queue,
      orchestrators: { findBySessionId: async () => binding },
    });
    const result = await handoffs.handoff({
      recipientSessionId: record.id, workerIds: [worker.id], directive: "Review the worker's result, then report.",
    });
    expect(result).toMatchObject({ committed: true, delivery: "pending", recipientControllerId: "orchestrator:fleet" });
    expect(coordination.getSubject(worker.id)?.lease.controller?.controllerId).toBe("orchestrator:fleet");
    expect(credentials.get("orchestrator:fleet", worker.id)).toBeDefined();
    expect((await queue.list(record.id))[0]).toMatchObject({ status: "queued", holdReason: "provider-starting" });
    expect(handles[0]!.writes).toEqual([]);
    const pending = () => coordination.pendingHandoffs({ controllerId: "orchestrator:fleet", limit: 1 });
    expect(pending()[0]?.handoffId).toBe(result.handoffId);
    expect(pending()[0]?.handoffId).toBe(result.handoffId);
    handles[0]!.emit(READY.claude);
    await vi.waitFor(async () => expect((await queue.list(record.id))[0]?.status).toBe("rendered"));
    expect(handles[0]!.writes).toHaveLength(1);
    expect(handles[0]!.writes[0]!.toString()).toContain("Review the worker's result, then report.");
    expect(pending()[0]?.handoffId).toBe(result.handoffId);
    await coordination.acknowledgeHandoffs({ controllerId: "orchestrator:fleet", handoffIds: [result.handoffId!] });
    const recovered = new WorkerCoordinationService({ store: new WorkerCoordinationStore(directory) });
    await recovered.initialize();
    expect(recovered.pendingHandoffs({ controllerId: "orchestrator:fleet", limit: 1 })).toEqual([]);
  });

  it.each(["codex", "claude"] as const)("requires fresh %s readiness after resume and ignores old callbacks", async (provider) => {
    const { registry, record, handles, queue, enqueue } = await harness(provider);
    handles[0]!.emit(READY[provider]);
    await registry.stop(record.id);
    await registry.resume(record.id);
    const brief = await enqueue("Resume work.");
    expect(brief).toMatchObject({ status: "queued", holdReason: "provider-starting" });
    handles[0]!.emit(READY[provider]);
    await queue.flush(record.id);
    expect(handles[1]!.writes).toEqual([]);
    handles[1]!.emit(`${CLEAR}Working\nesc to interrupt\n`);
    handles[1]!.emit(READY[provider]);
    await vi.waitFor(async () => expect((await queue.list(record.id))[0]?.status).toBe("rendered"));
    expect(handles[1]!.writes).toHaveLength(1);
    expect((await queue.list(record.id))[0]?.expectedTurn).toBe(1);
    expect(registry.workerTruth(record.id).completedTurns).toBe(0);
  });
});
