import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { InstructionQueue } from "../../src/orchestration/instruction-queue.js";
import { InstructionStore } from "../../src/persistence/instruction-store.js";
import { ThreadTranscriptStore } from "../../src/persistence/thread-transcript-store.js";
import { SessionUpdateBus } from "../../src/orchestration/session/session-update-bus.js";
import { WorkerTurnEngineFactory } from "../../src/orchestration/session/worker-turn-engine.js";
import type { WorkerTurnEngine } from "../../src/orchestration/session/worker-turn-engine.js";
import type { SessionRecord } from "../../src/domain/session.js";
import type { ComposerObservation } from "../../src/domain/worker-truth.js";
import type { SessionInstructionPort } from "../../src/orchestration/session/session-ports.js";

const roots: string[] = [];
const engines: WorkerTurnEngine[] = [];
const queues: InstructionQueue[] = [];
afterEach(async () => {
  queues.splice(0).forEach(queue => queue.stop());
  engines.splice(0).forEach(engine => engine.releaseTimers());
  vi.useRealTimers();
  await sleep(50);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

/** Production queue, journals, transcript reader, update bus and engine; no provider process. */
async function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-20T09:00:01.000Z"));
  const root = await mkdtemp(join(tmpdir(), "followup-delivery-"));
  roots.push(root);
  const actor = randomUUID(), id = randomUUID(), createdAt = "2026-08-20T09:00:00.000Z";
  const record: SessionRecord = { id, provider: "claude", cwd: "/tmp/repo", detached: true,
    sandbox: "workspace-write", kind: "worker", createdAt, updatedAt: createdAt,
    executionState: "active", attachmentState: "detached", pid: 4242, exitCode: null, childIds: [] };
  const projects = join(root, "projects"), directory = join(projects, "-tmp-repo");
  await mkdir(directory, { recursive: true });
  const nativePath = join(directory, `${id}.jsonl`);
  const transcripts = new ThreadTranscriptStore(root, { claudeProjectsDirectory: projects });
  await transcripts.append({ sessionId: id, kind: "prompt", source: "human", text: "launch", data: { initial: true } });
  const bus = new SessionUpdateBus();
  const writes: string[] = [];
  let composer: ComposerObservation = { occupied: false, modalOpen: false, inputReady: true };
  let human = false, beforeWrite: (() => void) | undefined, failAfterWrite = false;
  let engine: WorkerTurnEngine;
  function createEngine() {
    engine = new WorkerTurnEngineFactory({
      observations: {
        createReplay: () => ({ appendBytes: () => {}, reset: () => {}, frameText: () => "",
          strippedTail: () => ({ text: "", truncated: false }), tokenCount: () => undefined, version: 0 }),
        activity: () => "unknown", composer: () => composer, fatalTermination: () => undefined,
        compactFrame: text => text, compactTerminal: text => text, fallbackTerminal: text => text,
        truncateResult: text => text,
      }, transcripts,
      effects: { snapshot: () => "", write: bytes => {
        writes.push(bytes.toString());
        if (failAfterWrite) throw new Error("transport response lost after write");
      },
        appendEvent: async () => {}, persist: async () => {}, setAttention: async () => {},
        notifySessionUpdate: () => bus.notifySessionUpdate(id),
        notifyDeliveryBoundary: () => bus.notifyDeliveryBoundary(id),
        notifyInstructionState: update => bus.notifyInstructionState(update) }, workerStallSeconds: 120,
    }).create(record, 4096);
    engines.push(engine);
    engine.finishInitialization(true);
  }
  createEngine();
  const sessions: SessionInstructionPort = {
    get: () => record,
    onControllerReleased: listener => bus.onControllerReleased(listener),
    onDeliveryBoundary: listener => bus.onDeliveryBoundary(listener),
    onInstructionState: listener => bus.onInstructionState(listener),
    submitInstruction: async (_id, message, source, _metadata, instructionId) => {
      if (human) throw Object.assign(new Error("human control"), { code: "SESSION_BUSY" });
      return engine.submitInstruction({ message, source: source ?? "orchestrator", instructionId: instructionId!,
        encoded: () => {
          beforeWrite?.();
          if (human) throw Object.assign(new Error("human raced admission"), { code: "SESSION_BUSY" });
          return Buffer.from(message);
        } });
    },
  };
  const bindings = { findBySessionId: async () => ({ key: "fleet", kind: "primary" as const, sessionId: actor,
    provider: "codex" as const, cwd: "/tmp/repo", sandbox: "read-only" as const,
    scope: { kind: "fleet" as const }, grant: { subjectSessionId: actor, capabilities: ["thread.enqueue" as const],
      scope: { kind: "fleet" as const } }, createdAt, updatedAt: createdAt }) };
  let store = new InstructionStore(root);
  let queue = new InstructionQueue(sessions, bindings, store);
  queues.push(queue); queue.start();
  async function tick() {
    await vi.advanceTimersByTimeAsync(1500);
    // Real journal I/O must settle as well as fake provider timers. No queue flush/manual nudge.
    await sleep(5);
  }
  async function until(check: () => Promise<boolean>, description: string) {
    for (let n = 0; n < 40; n++) { if (await check()) return; await tick(); }
    throw new Error(`Bounded follow-up wait failed: ${description}; records=${JSON.stringify(await store.list(id))}`);
  }
  async function append(frames: unknown[]) {
    await appendFile(nativePath, frames.map(frame => JSON.stringify(frame)).join("\n") + "\n");
  }
  return {
    record, writes, transcripts, bus, tick, until,
    get engine() { return engine; }, get queue() { return queue; }, get store() { return store; },
    set composer(value: ComposerObservation) { composer = value; },
    set human(value: boolean) { human = value; if (!value) bus.notifyControllerReleased(id); },
    set beforeWrite(value: (() => void) | undefined) { beforeWrite = value; },
    set failAfterWrite(value: boolean) { failAfterWrite = value; },
    enqueue: (message: string) => queue.enqueue({ actorSessionId: actor, targetSessionId: id, message }),
    async working(turn: number) {
      await append([{ type: "assistant", timestamp: new Date().toISOString(),
        message: { id: `turn-${turn}`, role: "assistant", stop_reason: null, content: [{ type: "text", text: `working ${turn}` }] } }]);
      await tick();
    },
    async complete(turn: number) {
      vi.setSystemTime(new Date(Date.now() + 1));
      const timestamp = new Date().toISOString();
      await append([{ type: "assistant", timestamp, message: { id: `turn-${turn}`, role: "assistant",
        stop_reason: "end_turn", content: [{ type: "text", text: `reply ${turn}` }] } },
      { type: "system", subtype: "turn_duration", uuid: `stop-${turn}`, timestamp, durationMs: 100 }]);
    },
    async recover() {
      queue.stop(); engine.releaseTimers();
      store = new InstructionStore(root); createEngine();
      queue = new InstructionQueue(sessions, bindings, store); queues.push(queue); queue.start();
      await queue.recoverLaunchInstructions(async () => (await transcripts.readCompletionLedger(id)).canonicalTurns);
      await queue.recoverPendingInstructions(sessionId => transcripts.readCompletionLedger(sessionId));
    },
  };
}

describe("same-worker durable follow-ups", () => {
  it("does not repeat an ambiguous write or let the old answer resolve it across recovery", async () => {
    const f = await fixture();
    await f.complete(1);
    await f.until(async () => f.engine.completedTurns === 1, "initial receipt");
    f.failAfterWrite = true;
    const instruction = await f.enqueue("uncertain input");
    await f.until(async () => (await f.store.list())[0]?.holdReason === "delivery-outcome-unknown", "explicit unknown-outcome failure");
    f.failAfterWrite = false;
    await f.recover();
    for (let n = 0; n < 4; n++) await f.tick();
    expect(f.writes).toEqual(["uncertain input"]);
    expect((await f.store.list())[0]).toMatchObject({ id: instruction.id, status: "queued",
      holdReason: "delivery-outcome-unknown", holdDetail: expect.stringContaining("Inspect"), deliveryAttemptAt: expect.any(String) });
    expect((await f.store.list())[0]?.completedAt).toBeUndefined();
    expect(await f.queue.withdraw(f.record.id, instruction.messageId)).toMatchObject({ status: "queued", deliveryAttemptAt: expect.any(String) });
    expect(await f.queue.withdrawForOperator({ targetSessionId: f.record.id, instructionId: instruction.id,
      messageId: instruction.messageId, reason: "fixture withdrawal", authority: { path: "/fixture/authority", sha256: "0".repeat(64) } }))
      .toMatchObject({ outcome: "TOO_LATE" });
  });

  it("recovers the exact rendered identity when the queue receipt write fails after input", async () => {
    const f = await fixture();
    await f.complete(1);
    await f.until(async () => f.engine.completedTurns === 1, "initial receipt");
    // Wait for preflight, rather than failing a boundary-driven background write.
    await f.engine.reconcileCanonicalTurns();
    const put = f.store.put.bind(f.store);
    vi.spyOn(f.store, "put").mockImplementation(async record => {
      if (record.status === "rendered") throw new Error("queue receipt persistence unavailable");
      await put(record);
    });
    await expect(f.enqueue("persisted input identity")).rejects.toThrow("queue receipt persistence unavailable");
    const before = (await f.store.list())[0]!;
    expect(f.writes).toEqual(["persisted input identity"]);
    await f.recover();
    for (let n = 0; n < 2; n++) await f.tick();
    expect((await f.store.list())[0]?.status).not.toBe("completed");
    await f.working(2); await f.complete(2);
    await f.until(async () => (await f.store.list())[0]?.status === "completed", "exact recovered input reply");
    expect((await f.store.list())[0]).toMatchObject({ id: before.id, messageId: before.messageId, expectedTurn: 2, status: "completed" });
    expect((await f.store.list())[0]?.deliveryAttemptAt).toBeUndefined();
    expect(f.writes).toEqual(["persisted input identity"]);
  });

  it("delivers FIFO through working, completion, idle, delayed native writes, read failure and recovery", async () => {
    const f = await fixture();
    await f.working(1);
    const first = await f.enqueue("follow-up 1");
    expect(first).toMatchObject({ status: "queued", holdReason: "provider-busy" });
    await f.complete(1); // No terminal bytes arrive at any stage of this test.
    const second = await f.enqueue("follow-up 2"); // Exact completion boundary, behind first.
    await f.until(async () => (await f.store.list()).find(r => r.id === first.id)?.status === "rendered", "first input after launch completion");
    expect(f.writes).toEqual(["follow-up 1"]);
    expect((await f.store.list()).find(r => r.id === first.id)).toMatchObject({ status: "rendered", expectedTurn: 2 });
    expect(f.engine.waitResult(2).status).not.toBe("completed"); // Old launch reply owns no new input.
    await f.working(2);
    for (let n = 0; n < 4; n++) await f.tick(); // Transcript completion deliberately delayed.
    expect(f.writes).toHaveLength(1);
    await f.complete(2);
    await f.until(async () => f.writes.length === 2, "second input after first matching reply");
    expect(f.engine.waitResult(2)).toMatchObject({ text: "reply 2" });
    await f.until(async () => (await f.store.list()).find(r => r.id === first.id)?.status === "completed", "first instruction completion attribution");
    await f.working(3); await f.complete(3);
    await f.until(async () => (await f.store.list()).find(r => r.id === second.id)?.status === "completed", "second reply");
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000); await sleep(5);
    // The same completion ID returns after a real read exception. No fresh native event exists.
    vi.spyOn(f.transcripts, "observeProviderTurns").mockRejectedValueOnce(new Error("transient read failure"));
    const third = await f.enqueue("follow-up 3");
    expect(third.status).toBe("queued");
    await f.until(async () => f.writes.length === 3, "long-idle read recovery");
    await f.working(4);
    const fourth = await f.enqueue("follow-up 4");
    expect(fourth.status).toBe("queued");
    await f.complete(4);
    // Reconstruct queue and engine with the same worker identity and durable journals.
    await f.recover();
    await f.until(async () => f.writes.length === 4, "queued follow-up after runtime recovery");
    await f.working(5); await f.complete(5);
    await f.until(async () => (await f.store.list()).find(r => r.id === fourth.id)?.status === "completed", "fourth reply");
    expect(f.writes).toEqual(["follow-up 1", "follow-up 2", "follow-up 3", "follow-up 4"]);
    const records = await f.store.list();
    expect(records.map(r => [r.id, r.messageId, r.expectedTurn, r.status])).toEqual(
      [first, second, third, fourth].map((r, i) => [r.id, r.messageId, i + 2, "completed"]));
    const turns = (await f.transcripts.read(f.record.id)).events.filter(event => event.kind === "turn");
    expect(turns.map(event => [event.data.turnNumber, event.text])).toEqual(
      [1, 2, 3, 4, 5].map(n => [n, `reply ${n}`]));
  });

  it("retains an instruction when human control races the final write, then respects a modal", async () => {
    const f = await fixture();
    await f.complete(1);
    await f.until(async () => f.engine.completedTurns === 1, "initial receipt");
    f.beforeWrite = () => { f.human = true; };
    const instruction = await f.enqueue("after human and modal");
    await f.until(async () => (await f.store.list())[0]?.holdReason === "human-controller", "human raced final admission");
    expect(f.writes).toEqual([]);
    f.beforeWrite = undefined;
    f.composer = { occupied: false, modalOpen: true, inputReady: true };
    f.human = false;
    await f.until(async () => (await f.store.list())[0]?.holdReason === "provider-modal", "modal hold");
    expect(f.writes).toEqual([]);
    f.composer = { occupied: true, modalOpen: false, inputReady: true };
    await f.tick(); expect(f.writes).toEqual([]);
    f.composer = { occupied: false, modalOpen: false, inputReady: true };
    await f.until(async () => f.writes.length === 1, "human and modal released");
    await f.working(2); await f.complete(2);
    await f.until(async () => (await f.store.list())[0]?.status === "completed", "matching reply");
    expect((await f.store.list())[0]).toMatchObject({ id: instruction.id, expectedTurn: 2, status: "completed" });
    expect(f.writes).toEqual(["after human and modal"]);
  });
});
