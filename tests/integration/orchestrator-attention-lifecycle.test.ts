import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrokerRuntimeConfigSchema } from "../../src/config.js";
import { SessionRegistry } from "../../src/broker/session-registry.js";
import { ObservedWorkerCoordinationService } from "../../src/broker/observed-worker-coordination.js";
import { composeOrchestratorNotificationFeed } from "../../src/broker/orchestrator-notification-feed.js";
import { ORCHESTRATOR_GRANT_CAPABILITIES, orchestratorController } from "../../src/domain/orchestrator.js";
import type { SessionRuntime } from "../../src/domain/session-runtime.js";
import type { CaptureWorkerTurns, ObservedWorkerTurn, WorkerTurnObservation } from "../../src/orchestration/session/worker-turn-ports.js";
import type { ProviderAdapter } from "../../src/providers/provider.js";
import { OrchestratorAttentionControlPlane } from "../../src/orchestration/orchestrator-attention-control.js";
import { InstructionQueue } from "../../src/orchestration/instruction-queue.js";
import { observeInstructionRepository } from "../../src/orchestration/observed-instruction-repository.js";
import { OrchestratorAttentionStore } from "../../src/persistence/orchestrator-attention-store.js";
import { OrchestratorNotificationStore } from "../../src/persistence/orchestrator-notification-store.js";
import { OrchestratorNoticeFiles } from "../../src/persistence/orchestrator-notice-files.js";
import { OrchestratorStore } from "../../src/persistence/orchestrator-store.js";
import { InstructionStore } from "../../src/persistence/instruction-store.js";
import { ThreadTranscriptStore } from "../../src/persistence/thread-transcript-store.js";
import { WorkerCoordinationStore } from "../../src/persistence/worker-coordination-store.js";
import { WorkerTurnObservationAdapter } from "../../src/runtime/worker-turn-observation-adapter.js";

/** Real registry, queue, feed and durable journals; provider processes are controlled local fixtures. */
class SimulatedProvider implements SessionRuntime {
  readonly pid = 4242;
  readonly writes: Buffer[] = [];
  private readonly output = new Set<(chunk: Buffer) => void>();
  private readonly exits = new Set<(code: number) => void>();
  private replay = "";
  write(data: Buffer): void { this.writes.push(Buffer.from(data)); }
  resize(): void {}
  kill(): void { for (const listener of this.exits) listener(0); }
  snapshot(): Buffer { return Buffer.from(this.replay); }
  onOutput(listener: (chunk: Buffer) => void): () => void { this.output.add(listener); return () => { this.output.delete(listener); }; }
  onExit(listener: (code: number) => void): () => void { this.exits.add(listener); return () => { this.exits.delete(listener); }; }
  emit(text: string): void { this.replay = text; for (const listener of this.output) listener(Buffer.from(text)); }
  working(): void { this.emit("\u001b]0;⠹ Orc\u0007\u001b[2J\u001b[HWorking\r\nesc to interrupt"); }
  ready(text = "Ready"): void { this.emit(`\u001b[2J\u001b[H${text}\r\n❯ \r\n? for shortcuts\r\n\u001b]0;Orc\u0007`); }
}

/** Provider-native observations are explicit fixtures; persistence and attribution stay real. */
class SimulatedTranscripts extends ThreadTranscriptStore {
  private readonly turns = new Map<string, ObservedWorkerTurn[]>();
  fixtureTime = () => Date.now();
  complete(sessionId: string, text: string): void {
    const turns = this.turns.get(sessionId) ?? [];
    turns.push({ providerTurnId: randomUUID(), providerOccurredAt: new Date(this.fixtureTime()).toISOString(), text, transport: "provider-native" });
    this.turns.set(sessionId, turns);
  }
  override async observeProviderTurns(input: CaptureWorkerTurns): Promise<WorkerTurnObservation> {
    const ledger = await this.readCompletionLedger(input.sessionId);
    return { sessionId: input.sessionId, provider: input.provider, turnNumber: input.turnNumber,
      turns: (this.turns.get(input.sessionId) ?? []).slice(ledger.completedTurns) };
  }
}

const close: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of close.splice(0)) await dispose(); vi.restoreAllMocks(); });

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), "attention-lifecycle-"));
  let offset = 0;
  const now = () => Date.now() + offset;
  const providers: SimulatedProvider[] = [];
  const transcripts = new SimulatedTranscripts(directory, { claudeProjectsDirectory: join(directory, "native-claude"), codexSessionsDirectory: join(directory, "native-codex") });
  transcripts.fixtureTime = now;
  const adapter: ProviderAdapter = { id: "claude", buildLaunchSpec: (session) => ({ executable: "simulated", args: [], cwd: session.cwd, env: {} }),
    buildResumeSpec: (session) => ({ executable: "simulated", args: [], cwd: session.cwd, env: {} }) };
  const registry = new SessionRegistry({ adapters: { claude: adapter }, transcripts,
    workerTurnObservation: new WorkerTurnObservationAdapter(),
    sessionRuntimeFactory: () => { const provider = new SimulatedProvider(); providers.push(provider); return provider; },
    journal: { append: async () => {} }, store: { put: async () => {}, delete: async () => {} },
    validateCwd: async () => undefined, now, config: BrokerRuntimeConfigSchema.parse({}) });
  const actor = await registry.start({ provider: "claude", kind: "orchestrator", cwd: directory, detached: true, sandbox: "read-only" });
  const worker = await registry.start({ provider: "claude", cwd: directory, detached: true, sandbox: "read-only" });
  const actorProvider = providers[0]!, workerProvider = providers[1]!;
  actorProvider.ready(); workerProvider.working();
  await vi.waitFor(() => { expect(registry.workerTruth(actor.id).state).toBe("idle"); expect(registry.workerTruth(worker.id).state).toBe("working"); });
  offset += 4_000; // The existing provider admission's conservative startup quiet window.
  const bindings = new OrchestratorStore(directory);
  const stamp = new Date(now()).toISOString();
  const bound = { key: `workspace:${directory}`, kind: "primary" as const, sessionId: actor.id,
    provider: "claude" as const, cwd: directory, sandbox: "read-only" as const, scope: { kind: "workspace" as const, cwd: directory },
    grant: { subjectSessionId: actor.id, capabilities: [...ORCHESTRATOR_GRANT_CAPABILITIES], scope: { kind: "workspace" as const, cwd: directory } },
    createdAt: stamp, updatedAt: stamp };
  await bindings.put(bound);
  const controller = orchestratorController(bound);
  const coordination = new ObservedWorkerCoordinationService({ store: new WorkerCoordinationStore(directory) }); await coordination.initialize();
  const registered = await coordination.registerSubject({ mutationId: randomUUID(), actor: controller, subjectId: worker.id,
    origin: { creatorControllerId: controller.controllerId, creatorSessionId: actor.id, taskId: "lifecycle-fixture", threadId: worker.id, createdAt: stamp },
    lifecycle: "working", resources: { sessionId: worker.id, worktreePath: directory, eventStreamId: `worker:${worker.id}` }, controller, reason: "Fixture worker" });
  const leaseToken = registered.outcomes[0]!.leaseToken!;
  const store = new OrchestratorAttentionStore(directory);
  const attention = new OrchestratorAttentionControlPlane({ store, registry, bindings, coordination, transcripts, now: () => new Date(now()).toISOString() });
  const inbox = new OrchestratorNotificationStore(directory); await inbox.load();
  await inbox.setPolicy(controller.controllerId, { ...inbox.policy(controller.controllerId), coalesceMs: 60_000 });
  const instructionStore = new InstructionStore(directory);
  const feed = composeOrchestratorNotificationFeed({ attention, registry, bindings, coordination, inbox, instructionRepository: instructionStore,
    noticeFiles: new OrchestratorNoticeFiles(directory), now: () => new Date(now()).toISOString() });
  const queue = new InstructionQueue(registry, bindings, observeInstructionRepository(instructionStore, (record) => feed.observeInstruction(record)),
    (record) => (apply) => attention.admitWake(record, apply));
  queue.start(); await feed.start(queue);
  close.push(async () => { feed.stop(); await attention.flush(); await feed.scheduling!.flush(); queue.stop(); await registry.stopAll(); });
  return { directory, actor, worker, registry, actorProvider, workerProvider, attention, store, feed, queue, transcripts,
    coordination, inbox, controller, leaseToken, advance(milliseconds: number) { offset += milliseconds; },
    arm: (extra = {}) => attention.arm({ actorSessionId: actor.id, mutationId: randomUUID(), objective: "Read and verify the worker result",
      nextAction: "Process the exact result then acknowledge it", targets: [{ sessionId: worker.id, completionTarget: 1 }], ...extra }),
    async drain() { await attention.flush(); await feed.scheduling!.flush(); },
    async complete(text: string) {
      transcripts.complete(worker.id, text);
      workerProvider.ready(text);
      await vi.waitFor(async () => expect((await transcripts.readCompletionLedger(worker.id)).completedTurns).toBe(1), { timeout: 5_000 });
      await attention.flush(); await feed.scheduling!.flush();
    },
    async waitState(status: string) {
      await vi.waitFor(async () => expect((await queue.list(actor.id))[0]!.status).toBe(status), { timeout: 5_000 });
      await feed.scheduling!.flush();
    },
  };
}

describe("attention simulated-provider lifecycle", () => {
  it("runs source capture → decision → queue → render → attributed turn → exact read/action/ack → progress → re-arm", async () => {
    const h = await harness(); const arm = await h.arm(); await h.drain();
    expect(h.actorProvider.writes).toEqual([]);
    const uniqueResult = `EXACT-WORKER-RESULT-${randomUUID()}`;
    await h.complete(uniqueResult);
    expect(h.actorProvider.writes).toHaveLength(1); await h.waitState("rendered");
    let state = (await h.store.get(arm.controllerId))!;
    expect(state.lastWake).toMatchObject({ renderedAt: expect.any(String) });
    expect(state.lastWake!.submittedAt).toBeUndefined(); expect(state.lastWake!.initiatedAt).toBeUndefined(); expect(state.coverage.consumed).toEqual([]);
    h.actorProvider.working(); await h.waitState("acknowledged");
    state = (await h.store.get(arm.controllerId))!; expect(state.lastWake!.initiatedAt).toBeDefined(); expect(state.coverage.consumed).toEqual([]);
    const page = await h.feed.control.read({ actorSessionId: h.actor.id, attentionEpoch: arm.epoch });
    const received = page.attention!.workers[0]!.completion!.text;
    expect(received).toContain(uniqueResult);
    const artifact = join(h.directory, "simulated-orc-result.txt"); await writeFile(artifact, received);
    expect(await readFile(artifact, "utf8")).toContain(uniqueResult);
    await h.feed.control.read({ actorSessionId: h.actor.id, attentionEpoch: arm.epoch, attentionReceiptId: page.attention!.receiptId }); await h.drain();
    expect((await h.store.get(arm.controllerId))!.pendingIntent).toBeUndefined();
    h.transcripts.complete(h.actor.id, "Processed the exact result"); h.actorProvider.ready("Processed the exact result"); await h.waitState("completed"); await h.drain();
    state = (await h.store.get(arm.controllerId))!;
    expect(state.lastWake).toMatchObject({ consumedAt: expect.any(String), progressAt: expect.any(String), dormantAt: expect.any(String) });
    h.workerProvider.working(); await vi.waitFor(() => expect(h.registry.workerTruth(h.worker.id).state).toBe("working"));
    const next = await h.arm({ previousEpoch: arm.epoch, targets: [{ sessionId: h.worker.id, completionTarget: 2 }] }); await h.drain();
    expect(next.epoch).not.toBe(arm.epoch); expect(next.status).toBe("armed"); expect(h.actorProvider.writes).toHaveLength(1);
  });

  it("keeps a wake held behind a real provider modal and resumes it only at a safe input boundary", async () => {
    const h = await harness(); const arm = await h.arm(); await h.drain();
    h.actorProvider.emit("Claude needs your permission to use Bash\r\nDo you want to proceed?\r\n❯ 1. Yes\r\n  3. No");
    await vi.waitFor(() => expect(h.registry.workerTruth(h.actor.id).state).toBe("blocked-modal"));
    await h.complete("Result while modal open");
    expect(h.actorProvider.writes).toEqual([]); expect((await h.queue.list(h.actor.id))[0]!.status).toBe("queued");
    const page = await h.feed.control.read({ actorSessionId: h.actor.id, attentionEpoch: arm.epoch });
    expect(page.attention!.lastWake!.holdReason).toContain("modal"); expect(page.attention!.consumed).toEqual([]);
    h.actorProvider.ready(); await h.waitState("rendered"); expect(h.actorProvider.writes).toHaveLength(1);
    expect((await h.store.get(arm.controllerId))!.coverage.consumed).toEqual([]);
  });

  it("does not attribute an unrelated active turn to a held wake", async () => {
    const h = await harness(); const arm = await h.arm(); await h.drain();
    h.actorProvider.working(); await vi.waitFor(() => expect(h.registry.workerTruth(h.actor.id).state).toBe("working"));
    await h.complete("Result during unrelated Orc work");
    expect(h.actorProvider.writes).toEqual([]);
    expect((await h.store.get(arm.controllerId))!.lastWake!.initiatedAt).toBeUndefined();
    h.transcripts.complete(h.actor.id, "Earlier Orc work finished"); h.actorProvider.ready("Earlier Orc work finished"); await h.waitState("rendered");
    expect((await h.queue.list(h.actor.id))[0]!.expectedTurn).toBe(2);
    expect((await h.store.get(arm.controllerId))!.coverage.consumed).toEqual([]);
    h.actorProvider.working(); await h.waitState("acknowledged");
    expect((await h.store.get(arm.controllerId))!.lastWake).toMatchObject({ expectedTurn: 2, initiatedAt: expect.any(String) });
  });

  it("preserves operator input and composer gates while ordinary instructions retain their ownership", async () => {
    const h = await harness(); const arm = await h.arm(); await h.drain();
    await h.registry.attach(h.actor.id, "fixture-human", "control", () => {});
    await h.registry.write(h.actor.id, "fixture-human", Buffer.from("human draft"));
    h.actorProvider.emit("\u001b[2J\u001b[HReady\r\n❯ human draft\r\n? for shortcuts\r\n");
    await vi.waitFor(() => expect(h.registry.workerTruth(h.actor.id).composerOccupied).toBe(true));
    const ordinary = await h.queue.enqueue({ actorSessionId: h.actor.id, targetSessionId: h.actor.id, message: "Ordinary instruction" });
    expect(ordinary).toMatchObject({ status: "queued", holdReason: "human-controller" });
    await h.complete("Result during human editing");
    expect(h.actorProvider.writes).toHaveLength(1); expect(h.actorProvider.writes[0]!.toString()).toBe("human draft");
    h.actorProvider.ready(); await h.drain();
    expect(h.actorProvider.writes).toHaveLength(1);
    h.advance(4_000); await h.queue.flush(h.actor.id); await h.drain();
    expect(h.actorProvider.writes).toHaveLength(2);
    expect(h.actorProvider.writes[1]!.toString()).toContain("[cyberdeck attention]");
    expect((await h.queue.list(h.actor.id)).find((record) => record.id === ordinary.id)!.status).toBe("queued");
    expect((await h.store.get(arm.controllerId))!.coverage.consumed).toEqual([]);
  });
});
