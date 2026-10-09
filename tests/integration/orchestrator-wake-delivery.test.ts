import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrchestratorNotificationDelivery } from "../../src/broker/orchestrator-notification-delivery.js";
import { SessionRegistry } from "../../src/broker/session-registry.js";
import { BrokerRuntimeConfigSchema } from "../../src/config.js";
import { orchestratorController, type OrchestratorBinding } from "../../src/domain/orchestrator.js";
import { DEFAULT_NOTIFICATION_POLICY } from "../../src/domain/orchestrator-notification.js";
import type { SessionRuntime } from "../../src/domain/session-runtime.js";
import { InstructionQueue } from "../../src/orchestration/instruction-queue.js";
import { OrchestratorControllerDirectory } from "../../src/orchestration/orchestrator-controller-directory.js";
import type { NoticeFilePort } from "../../src/orchestration/orchestrator-notice-file-port.js";
import { WAKE_OPERATOR_QUIET_MS } from "../../src/orchestration/session/session-io-surface.js";
import { SUBMIT_VERIFY_MS } from "../../src/orchestration/session/worker-submit-verification.js";
import { InstructionStore } from "../../src/persistence/instruction-store.js";
import { OrchestratorNotificationStore } from "../../src/persistence/orchestrator-notification-store.js";
import { WorkerTurnObservationAdapter } from "../../src/runtime/worker-turn-observation-adapter.js";

class Pane implements SessionRuntime {
  readonly pid = 42;
  readonly writes: string[] = [];
  private replay = "\u001b]0;orc\u0007\u001b[2J› \r\n? for shortcuts\r\n";
  private output = new Set<(bytes: Buffer) => void>();
  private exits = new Set<(code: number) => void>();
  write(bytes: Buffer) { this.writes.push(bytes.toString()); }
  resize() {}
  kill() { for (const listener of this.exits) listener(0); }
  snapshot() { return Buffer.from(this.replay); }
  onOutput(listener: (bytes: Buffer) => void) { this.output.add(listener); return () => { this.output.delete(listener); }; }
  onExit(listener: (code: number) => void) { this.exits.add(listener); return () => { this.exits.delete(listener); }; }
  frame(text: string) {
    const bytes = Buffer.from(`\u001b[2J${text}\r\n`);
    this.replay += bytes.toString();
    for (const listener of this.output) listener(bytes);
  }
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
});

async function harness(instructionPersistence?: Promise<void>, humanPersistence?: Promise<void>) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-09T12:00:00Z"));
  const directory = await mkdtemp(join(tmpdir(), "cyberdeck-wake-"));
  const pane = new Pane();
  let humanInputBlocked = false;
  const registry = new SessionRegistry({
    adapters: { codex: {
      id: "codex", buildLaunchSpec: (session) => ({ executable: "fake", args: [], cwd: session.cwd, env: {} }),
      buildResumeSpec: (session) => ({ executable: "fake", args: [], cwd: session.cwd, env: {} }),
      submitInput: (message) => Buffer.from(`\u001b[200~${message}\u001b[201~\u001b[13u`),
      submitKey: () => Buffer.from("\u001b[13u"),
    } },
    sessionRuntimeFactory: () => pane, journal: { append: async () => {} },
    transcripts: { append: async (event) => {
      if (event.kind === "instruction") await instructionPersistence;
      if (humanInputBlocked && event.kind === "prompt" && event.source === "human") await humanPersistence;
    } },
    validateCwd: async () => undefined, config: BrokerRuntimeConfigSchema.parse({}),
    workerTurnObservation: new WorkerTurnObservationAdapter(),
  });
  const session = await registry.start({ provider: "codex", cwd: directory, detached: true,
    kind: "orchestrator", sandbox: "workspace-write", name: "orc" }, "Standby");
  humanInputBlocked = true;
  const binding: OrchestratorBinding = {
    key: "fleet", kind: "primary", sessionId: session.id, provider: "codex", cwd: directory,
    sandbox: "workspace-write", scope: { kind: "fleet" },
    grant: { subjectSessionId: session.id, capabilities: ["thread.enqueue"], scope: { kind: "fleet" } },
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  const bindings = { list: async () => [binding], findBySessionId: async (id: string) => id === session.id ? binding : undefined };
  const controllerId = orchestratorController(binding).controllerId;
  await registry.attach(session.id, "human", "control", () => {});
  let store = new InstructionStore(directory);
  let queue = new InstructionQueue(registry, bindings, store);
  queue.start();
  let inbox = new OrchestratorNotificationStore(directory);
  await inbox.load();
  await inbox.setPolicy(controllerId, { ...DEFAULT_NOTIFICATION_POLICY, coalesceMs: 0 });
  const files: NoticeFilePort = { write: async () => {}, remove: async () => {}, readShown: async () => undefined };
  const createDelivery = () => new OrchestratorNotificationDelivery({
    inbox, controllers: new OrchestratorControllerDirectory(bindings), registry, instructions: queue, noticeFiles: files,
  });
  let delivery = createDelivery();
  await delivery.start();
  // Drain durable queue writes without advancing time or consuming notifications.
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await Promise.resolve();
      await queue.list(session.id);
      const tails = (delivery as unknown as { tails: Map<string, Promise<unknown>> }).tails;
      while (tails.size) await Promise.allSettled([...tails.values()]);
      const writers = (queue as unknown as { writers: Map<string, Promise<unknown>> }).writers;
      while (writers.size) await Promise.allSettled([...writers.values()]);
    }
  };
  const advance = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); await settle(); };
  const append = async () => {
    const record = await inbox.append({ controllerId, kind: "settled", sessionId: session.id,
      summary: "Worker settled", severity: "info", wakeEligible: true });
    await settle();
    await advance(0);
    return record.record!;
  };
  cleanups.push(async () => {
    delivery.stop(); queue.stop(); pane.kill();
    await settle();
    await rm(directory, { recursive: true, force: true });
  });
  return { registry, pane, session, controllerId, append, advance, settle,
    queue: () => queue, inbox: () => inbox,
    restart: async () => {
      delivery.stop(); queue.stop(); await settle();
      store = new InstructionStore(directory);
      queue = new InstructionQueue(registry, bindings, store); queue.start();
      inbox = new OrchestratorNotificationStore(directory); await inbox.load();
      delivery = createDelivery(); await delivery.start(); await settle();
    },
  };
}

const wakeInput = (sessionId: string, controllerId: string) => ({
  actorSessionId: sessionId, targetSessionId: sessionId, message: "[cyberdeck notice] Wake",
  messageId: randomUUID(), submissionKind: "wake" as const,
  wake: { controllerId, cursor: 1, notificationIds: [randomUUID()] },
});

describe("broker wake channel with an attached operator", () => {
  it("delivers to an idle empty composer with a controller attached and verifies swallowed submit", async () => {
    const h = await harness();
    await h.advance(WAKE_OPERATOR_QUIET_MS);
    await h.append();
    const [record] = await h.queue().list(h.session.id);
    expect(record).toMatchObject({ submissionKind: "wake", status: "rendered" });
    expect(h.registry.get(h.session.id).attachmentState).toBe("controlled");
    expect(h.pane.writes).toHaveLength(1);
    h.pane.frame(`› ${record!.message}\r\ntab to queue message`);
    await h.advance(SUBMIT_VERIFY_MS);
    expect(h.pane.writes).toHaveLength(2);
    expect(h.pane.writes[1]).toBe("\u001b[13u");
    h.pane.frame("]0;⠹ orcWorking\r\nesc to interrupt");
    await h.settle();
    expect((await h.queue().list(h.session.id))[0]?.status).toBe("acknowledged");
  });

  it("holds for operator bytes, extends the quiet window on more bytes, then retries without output", async () => {
    const h = await harness();
    await h.advance(WAKE_OPERATOR_QUIET_MS);
    await h.registry.write(h.session.id, "human", Buffer.from("x"));
    await h.append();
    expect((await h.queue().list(h.session.id))[0]).toMatchObject({ status: "queued", holdReason: "wake-operator-active" });
    await h.advance(WAKE_OPERATOR_QUIET_MS - 1);
    await h.registry.write(h.session.id, "human", Buffer.from("\u007f"));
    await h.advance(1);
    expect(h.pane.writes).toEqual(["x", "\u007f"]);
    await h.advance(WAKE_OPERATOR_QUIET_MS - 1);
    expect((await h.queue().list(h.session.id))[0]?.status).toBe("rendered");
    expect(h.pane.writes).toHaveLength(3);
  });

  it("holds composer text, retries when cleared, and never submits operator text during verification", async () => {
    const h = await harness();
    await h.advance(WAKE_OPERATOR_QUIET_MS);
    h.pane.frame("› operator draft\r\ntab to queue message");
    await h.append();
    expect((await h.queue().list(h.session.id))[0]).toMatchObject({ status: "queued", holdReason: "wake-composer-occupied" });
    expect(h.pane.writes).toEqual([]);
    h.pane.frame("› \r\n? for shortcuts");
    await h.advance(16);
    expect((await h.queue().list(h.session.id))[0]?.status).toBe("rendered");
    h.pane.frame("› new operator draft\r\ntab to queue message");
    await h.advance(SUBMIT_VERIFY_MS);
    expect(h.pane.writes).toHaveLength(1);
  });

  it("ordinary and ordinary broker instructions still throw SESSION_BUSY; caller metadata cannot mint a wake", async () => {
    const h = await harness();
    await h.advance(WAKE_OPERATOR_QUIET_MS);
    await expect(h.registry.submitInstruction(h.session.id, "ordinary", "orchestrator")).rejects.toMatchObject({ code: "SESSION_BUSY" });
    await expect(h.registry.submitInstruction(h.session.id, "budget", "broker", { brokerOwned: true })).rejects.toMatchObject({ code: "SESSION_BUSY" });
    const forged = { ...wakeInput(h.session.id, h.controllerId), brokerOwned: true };
    expect(await h.queue().enqueue(forged)).toMatchObject({ status: "queued", holdReason: "human-controller" });
    await h.append();
    expect(h.pane.writes).toHaveLength(1); // The separate wake passes an ordinary controller hold.
    expect((await h.queue().list(h.session.id)).map((record) => record.status)).toEqual(["queued", "rendered"]);
  });

  it("recovers one pending journal wake when inbox grows across restart, then delivers exactly once", async () => {
    const h = await harness();
    await h.advance(WAKE_OPERATOR_QUIET_MS);
    h.pane.frame("› operator draft\r\ntab to queue message");
    await h.append();
    const before = (await h.queue().list(h.session.id))[0]!;
    expect(before.status).toBe("queued");
    // A second notification arrives before journal/delivery recovery; use the same durable inbox.
    await h.inbox().append({ controllerId: h.controllerId, kind: "settled", sessionId: h.session.id,
      summary: "Second worker", severity: "info", wakeEligible: true });
    await h.restart();
    expect(await h.queue().list(h.session.id)).toHaveLength(1);
    h.pane.frame("› \r\n? for shortcuts");
    await h.advance(16);
    expect((await h.queue().list(h.session.id))[0]).toMatchObject({ id: before.id, messageId: before.messageId, status: "rendered" });
    expect(h.pane.writes).toHaveLength(1);
    await h.restart();
    await h.advance(16);
    // Replaying the exact durable message is idempotent, too.
    const duplicate = await h.queue().enqueueBroker({ ...wakeInput(h.session.id, h.controllerId), messageId: before.messageId });
    expect(duplicate.id).toBe(before.id);
    expect(h.pane.writes).toHaveLength(1);
    expect(h.inbox().listPending(h.controllerId, 0, 50)[0]!.deliveredVia).toEqual(["wake"]);
  });

  it("holds a turn in flight even when its composer is empty", async () => {
    const h = await harness();
    await h.advance(WAKE_OPERATOR_QUIET_MS);
    h.pane.frame("]0;⠹ orcWorking\r\nesc to interrupt");
    const record = await h.queue().enqueueBroker(wakeInput(h.session.id, h.controllerId));
    expect(record).toMatchObject({ status: "queued", holdReason: "wake-turn-in-flight" });
    expect(h.pane.writes).toEqual([]);
    h.pane.frame("Done\r\n› \r\n? for shortcuts\r\n\u001b]0;orc\u0007");
    await h.advance(250);
    expect((await h.queue().list(h.session.id))[0]?.status).toBe("rendered");
  });

  it("retries a held wake on controller detach without weakening ordinary control ownership", async () => {
    const h = await harness();
    await h.advance(WAKE_OPERATOR_QUIET_MS);
    h.pane.frame("› operator draft\r\ntab to queue message");
    await h.append();
    expect(h.pane.writes).toEqual([]);
    h.pane.frame("› \r\n? for shortcuts");
    // No session-update timer has fired. Detach is the edge that retries this wake.
    await h.registry.detach(h.session.id, "human");
    await h.settle();
    expect((await h.queue().list(h.session.id))[0]?.status).toBe("rendered");
    expect(h.pane.writes).toHaveLength(1);
  });

  it("applies a conservative quiet window after startup even without remembered operator bytes", async () => {
    const h = await harness();
    await h.append();
    expect((await h.queue().list(h.session.id))[0]).toMatchObject({ status: "queued", holdReason: "wake-operator-active" });
    await h.advance(WAKE_OPERATOR_QUIET_MS - 1);
    expect(h.pane.writes).toEqual([]);
    await h.advance(1);
    expect(h.pane.writes).toHaveLength(1);
  });

  it("holds while human submit persists its prompt, then waits for its admitted bytes to become quiet", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const h = await harness(undefined, pending);
    await h.advance(WAKE_OPERATOR_QUIET_MS);
    const submit = h.registry.submit(h.session.id, "human", "Human message");
    const wake = wakeInput(h.session.id, h.controllerId);
    const held = await h.queue().enqueueBroker(wake);
    expect(held).toMatchObject({ status: "queued", holdReason: "wake-turn-in-flight" });
    expect(h.pane.writes).toEqual([]);
    release(); await submit; await h.settle();
    expect((await h.queue().list(h.session.id))[0]).toMatchObject({ status: "queued", holdReason: "wake-operator-active" });
    expect(h.pane.writes).toHaveLength(1);
    h.pane.frame("\u001b]0;⠹ orc\u0007Working\r\nesc to interrupt");
    await h.advance(WAKE_OPERATOR_QUIET_MS);
    expect(h.pane.writes).toHaveLength(1);
  });

  it("revalidates atomically before paste even while transcript persistence is awaiting I/O", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const h = await harness(pending);
    await h.advance(WAKE_OPERATOR_QUIET_MS);
    const wake = wakeInput(h.session.id, h.controllerId);
    const submit = h.registry.submitInstruction(h.session.id, wake.message, "broker", {
      actorSessionId: h.session.id, brokerOwned: true, submissionKind: "wake",
    }, randomUUID());
    // The synchronous session exclusion has already pasted before another admitted byte can write.
    expect(h.pane.writes).toHaveLength(1);
    await h.registry.write(h.session.id, "human", Buffer.from("x"));
    release();
    await submit;
    expect(h.pane.writes[0]).toContain(wake.message);
    expect(h.pane.writes[1]).toBe("x");
    await expect(h.registry.write(h.session.id, "intruder", Buffer.from("x"))).rejects.toMatchObject({ code: "NOT_SESSION_CONTROLLER" });
  });
});
