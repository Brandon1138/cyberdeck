import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionRegistry } from "../../src/broker/session-registry.js";
import { BrokerRuntimeConfigSchema } from "../../src/config.js";
import type { SessionRuntime } from "../../src/domain/session-runtime.js";
import type { ProviderLaunchSpec } from "../../src/orchestration/session/provider-ports.js";
import type { SessionRegistryOptions } from "../../src/orchestration/session/session-registry-ports.js";
import type { CaptureWorkerTurns, ObservedWorkerTurn, WorkerTurnObservation } from "../../src/orchestration/session/worker-turn-ports.js";
import { InstructionQueue } from "../../src/orchestration/instruction-queue.js";
import { OrchestratorManager } from "../../src/orchestration/orchestrator-manager.js";
import { OrchestratorPeerService } from "../../src/orchestration/orchestrator-peer-service.js";
import { fallbackWorkerCapabilities } from "../../src/orchestration/worker-capabilities.js";
import { InstructionStore } from "../../src/persistence/instruction-store.js";
import { OrchestratorStore } from "../../src/persistence/orchestrator-store.js";
import { SessionStore } from "../../src/persistence/session-store.js";
import { ThreadTranscriptStore } from "../../src/persistence/thread-transcript-store.js";
import { ClaudeProviderAdapter } from "../../src/providers/claude.js";
import { CodexProviderAdapter } from "../../src/providers/codex.js";
import { WorkerTurnObservationAdapter } from "../../src/runtime/worker-turn-observation-adapter.js";
import { ModalAnswerPolicy } from "../../src/orchestration/modal-answer-policy.js";
import { answerOrchestratorModal } from "../../src/orchestration/orchestrator-modal-service.js";
import { CLAUDE_TRUST_WARNED, CLAUDE_TRUST_BACKSTOP } from "../fixtures/provider-startup-dialogs.js";

class FixtureRuntime implements SessionRuntime {
  readonly pid = 4242;
  readonly writes: Buffer[] = [];
  private replay = "";
  private readonly outputs = new Set<(data: Buffer) => void>();
  private readonly exits = new Set<(code: number) => void>();
  write(data: Buffer) { this.writes.push(Buffer.from(data)); }
  resize() {}
  snapshot() { return Buffer.from(this.replay); }
  kill() { this.exit(0); }
  onOutput(listener: (data: Buffer) => void) { this.outputs.add(listener); return () => { this.outputs.delete(listener); }; }
  onExit(listener: (code: number) => void) { this.exits.add(listener); return () => { this.exits.delete(listener); }; }
  emit(text: string) { this.replay += text; for (const listener of this.outputs) listener(Buffer.from(text)); }
  exit(code: number) { for (const listener of this.exits) listener(code); }
}

/** Synthetic native observations, with the real durable commit/dedupe/ledger implementation. */
class FixtureTranscripts extends ThreadTranscriptStore {
  readonly native = new Map<string, ObservedWorkerTurn[]>();
  complete(sessionId: string, text: string) {
    const turns = this.native.get(sessionId) ?? [];
    turns.push({ providerTurnId: randomUUID(), providerOccurredAt: new Date().toISOString(), text, transport: "provider-native" });
    this.native.set(sessionId, turns);
  }
  override async observeProviderTurns(input: CaptureWorkerTurns): Promise<WorkerTurnObservation> {
    const ledger = await this.readCompletionLedger(input.sessionId);
    return { sessionId: input.sessionId, provider: input.provider, turnNumber: input.turnNumber,
      turns: (this.native.get(input.sessionId) ?? []).slice(ledger.completedTurns) };
  }
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const READY = {
  claude: "\u001b[2J❯ \n⏵⏵ auto mode on (shift+tab to cycle)\n",
  codex: "\u001b[2J› Ask Codex to do anything\n? for shortcuts 100% context left\n",
};

async function harness(creator: "claude" | "codex") {
  const directory = await mkdtemp(join(tmpdir(), "cyberdeck-first-instruction-"));
  const transcripts = new FixtureTranscripts(directory, {
    claudeProjectsDirectory: join(directory, "native-claude"), codexSessionsDirectory: join(directory, "native-codex"),
  });
  const handles: Array<{ handle: FixtureRuntime; spec: ProviderLaunchSpec }> = [];
  const order: string[] = [];
  const sessionStore = new SessionStore(directory);
  const registryOptions: SessionRegistryOptions = {
    config: BrokerRuntimeConfigSchema.parse({}), workerTurnObservation: new WorkerTurnObservationAdapter(),
    adapters: { claude: new ClaudeProviderAdapter({ directory: join(directory, "launch") }),
      cursor: { id: "cursor", buildLaunchSpec: (session) => ({ executable: "fixture", args: [], cwd: session.cwd, env: {} }),
        buildResumeSpec: (session) => ({ executable: "fixture", args: [], cwd: session.cwd, env: {} }) },
      codex: new CodexProviderAdapter({ nativeSessionId: randomUUID(), runCommand: async () => '{"status":"connected"}' }) },
    sessionRuntimeFactory: (spec) => {
      order.push("spawn"); const handle = new FixtureRuntime(); handles.push({ handle, spec }); return handle;
    },
    transcripts, store: sessionStore, validateCwd: async () => undefined, journal: { append: async () => undefined },
  };
  const registry = new SessionRegistry(registryOptions);
  const bindings = new OrchestratorStore(directory);
  const manager = new OrchestratorManager(registry, bindings, undefined, undefined, async () =>
    fallbackWorkerCapabilities("first-instruction fixture", "codex").map((capability) => ({
      ...capability, source: "provider-query" as const, observedAt: new Date().toISOString(),
      models: ["gpt-6.1-sol"], modelEfforts: { "gpt-6.1-sol": ["high"] },
    })));
  const actor = await manager.create({ provider: creator, model: creator === "claude" ? "fable" : "gpt-6.1-sol", cwd: directory, scope: "fleet" });
  order.length = 0;
  const store = new InstructionStore(directory);
  const queue = new InstructionQueue(registry, bindings, store);
  queue.start();
  const service = new OrchestratorPeerService({ registry, bindings, manager,
    instructions: { list: (id) => queue.list(id), flush: (id) => queue.flush(id), prepareLaunch: async (input) => {
      const record = await queue.prepareLaunch(input); order.push("receipt"); return record;
    } },
  });
  cleanups.push(async () => {
    for (const record of registry.list()) {
      await registry.stop(record.id);
      await vi.waitFor(() => expect(registry.get(record.id).exitCode).not.toBeNull());
      await queue.flush(record.id);
    }
    queue.stop(); await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  });
  const create = (provider: "claude" | "codex" | "cursor", brief = "Read the handoff. Reply FIRST_ACK once.") => service.create({
    actorSessionId: actor.session.id, provider, model: provider === "claude" ? "fable" : provider === "cursor" ? "claude-opus-5-thinking-high" : "gpt-6.1-sol",
    ...(provider === "cursor" ? {} : { effort: "high" as const }),
    cwd: directory, reason: "first instruction regression", brief, mutationId: "first-instruction",
    approval: { kind: "per-create", quote: "Run the first-instruction regression", channel: "terminal" },
  });
  const restart = async (sessionId: string, recoveredTranscripts = transcripts) => {
    queue.stop();
    const recovered = new SessionRegistry({ ...registryOptions, transcripts: recoveredTranscripts, recoveredSessions: [registry.get(sessionId), registry.get(actor.session.id)] });
    await recovered.ready();
    const recoveredQueue = new InstructionQueue(recovered, bindings, new InstructionStore(directory));
    recoveredQueue.start();
    await recoveredQueue.recoverLaunchInstructions(async (id) => ({
      canonicalTurns: (await recoveredTranscripts.readCompletionLedger(id)).canonicalTurns,
      pending: recovered.initialInstructionRecoveryFailure(id),
    }));
    cleanups.push(async () => {
      await recovered.stop(sessionId);
      await recoveredQueue.flush(sessionId);
      recoveredQueue.stop();
    });
    return { registry: recovered, queue: recoveredQueue };
  };
  return { directory, registry, transcripts, handles, queue, store, bindings, manager, service, actor, order, create, restart };
}

describe("peer first-instruction lifecycle", () => {
  it.each([CLAUDE_TRUST_WARNED, CLAUDE_TRUST_BACKSTOP,
    CLAUDE_TRUST_WARNED.replace("Bash(npm run *)", "Bash(echo Enter to confirm; Would you like to proceed?)"),
    CLAUDE_TRUST_BACKSTOP.replace("Bash(npm run *)", "Bash(echo Enter to confirm; Would you like to proceed?)"),
  ])("never enables Claude's folder permissions through plan wording in its path or warning", async (fixture) => {
    const h = await harness("codex"); const created = await h.create("claude");
    if (created.outcome !== "CREATED") throw new Error(created.reason);
    const handle = h.handles[1]!.handle;
    handle.emit(fixture.replace("/Users/op/repos/api/worktrees/fix-races", "/repo/worktrees/Would you like to proceed?"));
    const modal = h.registry.workerTruth(created.sessionId).modal!;
    expect(modal.kind).toBe("workspace-trust");
    const policy = new ModalAnswerPolicy({ grants: { allowsRoot: async () => true },
      probe: { gitCommonDirectory: async () => `${h.directory}/.git`, primaryWorktree: async () => h.directory }, canonicalize: async (path) => path });
    const deps = { registry: h.registry, bindings: h.bindings, policy, audit: { append: async () => undefined } };
    const input = { actorSessionId: h.actor.session.id, targetSessionId: created.sessionId,
      fingerprint: modal.fingerprint, answer: "proceed-manual", reason: "Regression: no permission approval through workspace text" };
    expect(await answerOrchestratorModal(input, deps)).toMatchObject({ code: "MODAL_ANSWER_UNSUPPORTED" });
    expect(handle.writes).toEqual([]);
    expect(await answerOrchestratorModal({ ...input, answer: modal.answers[0]!.id }, deps)).toMatchObject({ code: "PRESSED" });
    expect(handle.writes.map((bytes) => bytes.toString())).toEqual(["1"]);
  });

  it.each(["claude", "codex"] as const)("retries unresolved %s launch evidence before resuming without discarding its receipt", async (provider) => {
    const h = await harness("codex"); const created = await h.create(provider);
    if (created.outcome !== "CREATED") throw new Error(created.reason);
    const recoveredTranscripts = new FixtureTranscripts(h.directory);
    recoveredTranscripts.complete(created.sessionId, "FIRST_ACK");
    const nativeRead = vi.spyOn(recoveredTranscripts, "observeProviderTurns")
      .mockRejectedValueOnce(new Error("Transcript changed during read"))
      .mockRejectedValueOnce(new Error("Transcript still changing"));
    const restarted = await h.restart(created.sessionId, recoveredTranscripts);
    await expect(restarted.registry.resume(created.sessionId)).rejects.toMatchObject({ code: "SESSION_RESUME_UNAVAILABLE" });
    await restarted.queue.flush(created.sessionId);
    expect((await restarted.queue.list(created.sessionId))[0]).toMatchObject({ status: "rendered", holdReason: "native-recovery-unavailable" });
    expect(h.handles).toHaveLength(2);
    await restarted.registry.resume(created.sessionId);
    await vi.waitFor(async () => expect((await restarted.queue.list(created.sessionId))[0]?.status).toBe("completed"));
    expect(restarted.registry.initialInstructionRecoveryFailure(created.sessionId)).toBeUndefined();
    expect(nativeRead).toHaveBeenCalledTimes(3);
    expect((await recoveredTranscripts.readCompletionLedger(created.sessionId)).canonicalTurns).toBe(1);
    expect(h.handles.at(-1)!.spec.args).not.toContain("Read the handoff. Reply FIRST_ACK once.");
    expect(h.handles.at(-1)!.handle.writes).toEqual([]);
  });

  it.each(["claude", "codex"] as const)("contains a %s native-read recovery failure and retries without resending the brief", async (provider) => {
    const h = await harness("codex"); const created = await h.create(provider);
    if (created.outcome !== "CREATED") throw new Error(created.reason);
    const recoveredTranscripts = new FixtureTranscripts(h.directory);
    recoveredTranscripts.complete(created.sessionId, "FIRST_ACK");
    vi.spyOn(recoveredTranscripts, "observeProviderTurns").mockRejectedValueOnce(new Error("Transcript changed during read"));
    const first = await h.restart(created.sessionId, recoveredTranscripts);
    expect(first.registry.get(h.actor.session.id).id).toBe(h.actor.session.id);
    expect(first.registry.initialInstructionRecoveryFailure(created.sessionId)).toContain("without resending the brief");
    await first.queue.flush(created.sessionId);
    expect((await first.queue.list(created.sessionId))[0]).toMatchObject({ status: "rendered", holdReason: "native-recovery-unavailable" });
    first.queue.stop();
    const retried = await h.restart(created.sessionId, recoveredTranscripts);
    expect(retried.registry.initialInstructionRecoveryFailure(created.sessionId)).toBeUndefined();
    expect((await retried.queue.list(created.sessionId))[0]?.status).toBe("completed");
    expect(h.handles).toHaveLength(2);
    expect(h.handles[1]!.handle.writes).toEqual([]);
  });

  it.each(["claude", "codex"] as const)("keeps a completed %s brief completed across broker recovery, resume, and stop", async (provider) => {
    const h = await harness("codex"); const created = await h.create(provider);
    if (created.outcome !== "CREATED") throw new Error(created.reason);
    h.transcripts.complete(created.sessionId, "FIRST_ACK");
    h.handles[1]!.handle.emit(READY[provider]);
    await vi.waitFor(async () => expect((await h.queue.list(created.sessionId))[0]?.status).toBe("completed"), { timeout: 4_000 });
    const restarted = await h.restart(created.sessionId);
    await restarted.registry.resume(created.sessionId);
    h.handles.at(-1)!.handle.emit(READY[provider]);
    await restarted.registry.stop(created.sessionId);
    await vi.waitFor(() => expect(restarted.registry.get(created.sessionId).exitCode).toBe(0));
    await restarted.queue.flush(created.sessionId);
    expect((await restarted.queue.list(created.sessionId))[0]?.status).toBe("completed");
    expect(h.handles.at(-1)!.spec.args).not.toContain("Read the handoff. Reply FIRST_ACK once.");
    expect(h.handles.at(-1)!.handle.writes).toEqual([]);
  });

  it.each(["claude", "codex"] as const)("recovers a persisted native %s first turn from before the broker committed it", async (provider) => {
    const h = await harness("codex"); const created = await h.create(provider);
    if (created.outcome !== "CREATED") throw new Error(created.reason);
    const recoveredTranscripts = new FixtureTranscripts(h.directory);
    recoveredTranscripts.complete(created.sessionId, "FIRST_ACK");
    expect((await recoveredTranscripts.readCompletionLedger(created.sessionId)).canonicalTurns).toBe(0);
    const nativeRead = vi.spyOn(recoveredTranscripts, "observeProviderTurns");
    const restarted = await h.restart(created.sessionId, recoveredTranscripts);
    expect(nativeRead).toHaveBeenCalledWith(expect.objectContaining({ sessionId: created.sessionId, allowFallback: false }));
    expect((await recoveredTranscripts.readCompletionLedger(created.sessionId)).canonicalTurns).toBe(1);
    expect((await restarted.queue.list(created.sessionId))[0]?.status).toBe("completed");
    expect(h.handles).toHaveLength(2);
    expect(h.handles[1]!.handle.writes).toEqual([]);
  });

  it("keeps Cursor on verified queue delivery without a native transcript requirement", async () => {
    const h = await harness("codex"); const created = await h.create("cursor");
    if (created.outcome !== "CREATED") throw new Error(created.reason);
    const { handle, spec } = h.handles[1]!;
    expect(spec.args).not.toContain("Read the handoff. Reply FIRST_ACK once.");
    expect((await h.store.list(created.sessionId))[0]).toMatchObject({ launch: false, status: "queued", holdReason: "provider-starting" });
    expect(handle.writes).toEqual([]);
    handle.emit("\u001b[2J→ Add a follow-up\n");
    await vi.waitFor(async () => expect((await h.store.list(created.sessionId))[0]).toMatchObject({ status: "rendered", expectedTurn: 1 }));
    expect(handle.writes).toHaveLength(1);
    handle.emit("\u001b]0;⠹ Working\u0007\u001b[2JComposing\nctrl+c to stop\n");
    handle.emit("\u001b]0;Ready\u0007\u001b[2JFIRST_ACK\n→ Add a follow-up\n");
    await vi.waitFor(async () => expect((await h.store.list(created.sessionId))[0]?.status).toBe("completed"));
    expect(h.registry.workerTruth(created.sessionId).canonicalTurns).toBe(0);
  });
  it.each([ ["claude", "claude"], ["claude", "codex"], ["codex", "claude"], ["codex", "codex"] ] as const)(
    "%s to %s persists a native first brief, orders early follow-ups, and replays the receipt", async (creator, provider) => {
      const h = await harness(creator);
      const created = await h.create(provider);
      if (created.outcome !== "CREATED") throw new Error(created.reason);
      expect(created.brief).toMatchObject({ delivery: "rendered", expectedTurn: 1 });
      expect(h.order).toEqual(["receipt", "spawn"]);
      const { handle, spec } = h.handles[1]!;
      expect(spec.args.filter((arg) => arg === "Read the handoff. Reply FIRST_ACK once.")).toHaveLength(1);
      expect(handle.writes).toEqual([]);
      const receipt = (await new InstructionStore(h.directory).list(created.sessionId))[0]!;
      expect(receipt).toMatchObject({ launch: true, expectedTurn: 1, status: "rendered" });
      handle.emit(READY[provider]);
      const early = await h.queue.enqueue({ actorSessionId: h.actor.session.id, targetSessionId: created.sessionId, message: "Then reply SECOND_ACK." });
      expect(early).toMatchObject({ status: "queued", holdReason: "provider-busy" });
      expect(handle.writes).toEqual([]);
      // Startup repaints, including a superficially ready composer, cannot complete the brief.
      handle.emit("\u001b]0;⠹ Startup\u0007\u001b[2JWorking\nesc to interrupt\n");
      handle.emit(READY[provider]);
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(h.registry.workerTruth(created.sessionId).completedTurns).toBe(0);
      h.transcripts.complete(created.sessionId, "FIRST_ACK");
      handle.emit(READY[provider]);
      await vi.waitFor(async () => expect((await h.queue.list(created.sessionId))[0]?.status).toBe("completed"), { timeout: 4_000 });
      await vi.waitFor(async () => expect((await h.queue.list(created.sessionId))[1]).toMatchObject({ status: "rendered", expectedTurn: 2 }), { timeout: 4_000 });
      expect(h.registry.workerTruth(created.sessionId).canonicalTurns).toBe(1);
      expect(handle.writes).toHaveLength(1);
      expect(handle.writes[0]!.toString()).toContain("Then reply SECOND_ACK.");
      const replay = await h.create(provider, "A retry must never replace the original brief.");
      expect(replay).toMatchObject({ outcome: "CREATED", sessionId: created.sessionId, retrieval: "replay", brief: { delivery: "completed" } });
      expect(h.handles).toHaveLength(2);
      expect(handle.writes).toHaveLength(1);
      // Simulate a crash between the durable native receipt and the queue's completion update.
      await h.store.put({ ...(await h.store.list(created.sessionId))[0]!, status: "rendered", submittedAt: undefined, completedAt: undefined });
      const restartedQueue = new InstructionQueue(h.registry, h.bindings, new InstructionStore(h.directory));
      await restartedQueue.recoverLaunchInstructions(async (id) => (await h.transcripts.readCompletionLedger(id)).canonicalTurns);
      const restartedService = new OrchestratorPeerService({ registry: h.registry, bindings: new OrchestratorStore(h.directory), manager: h.manager, instructions: restartedQueue });
      expect(await restartedService.create({ actorSessionId: h.actor.session.id, provider, model: provider === "claude" ? "fable" : "gpt-6.1-sol",
        cwd: h.directory, reason: "restart retry", mutationId: "first-instruction" })).toMatchObject({
        outcome: "CREATED", sessionId: created.sessionId, retrieval: "replay", brief: { delivery: "completed", instructionId: receipt.id },
      });
      expect(handle.writes).toHaveLength(1);
    },
  );

  it("records a clean exit before consumption as a startup exit, with an undelivered brief", async () => {
    const h = await harness("claude"); const created = await h.create("codex");
    if (created.outcome !== "CREATED") throw new Error(created.reason);
    h.handles[1]!.handle.exit(0);
    await vi.waitFor(async () => expect((await h.queue.list(created.sessionId))[0]?.status).toBe("undelivered"));
    expect(h.registry.get(created.sessionId)).toMatchObject({ exitCode: 0, executionState: "exited", attentionState: "failed", termination: { kind: "startup-exit" } });
    expect(h.registry.workerTruth(created.sessionId)).toMatchObject({ canonicalTurns: 0, completedTurns: 0, detail: expect.stringContaining("before its first canonical turn") });
    expect(await h.create("codex")).toMatchObject({ outcome: "CREATED", retrieval: "replay", brief: { delivery: "failed" } });
    expect(h.handles).toHaveLength(2);
  });

  it("captures an already finished native first turn when the provider exits before its next poll", async () => {
    const h = await harness("codex"); const created = await h.create("codex");
    if (created.outcome !== "CREATED") throw new Error(created.reason);
    h.transcripts.complete(created.sessionId, "FIRST_ACK");
    h.handles[1]!.handle.exit(0);
    await vi.waitFor(async () => expect((await h.queue.list(created.sessionId))[0]?.status).toBe("completed"));
    await vi.waitFor(() => expect(h.registry.get(created.sessionId).exitCode).toBe(0));
    expect(h.registry.get(created.sessionId).termination).toBeUndefined();
    expect(h.registry.workerTruth(created.sessionId).canonicalTurns).toBe(1);
  });
});
