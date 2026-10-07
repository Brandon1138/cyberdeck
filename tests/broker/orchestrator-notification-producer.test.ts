import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrchestratorNotificationProducer } from "../../src/broker/orchestrator-notification-producer.js";
import type { WorkerEventObserver, HandoffBatchObserver } from "../../src/broker/observed-worker-coordination.js";
import type { HandoffBatchInput, HandoffBatchResult, WorkerBudgetUpdateListener } from "../../src/broker/worker-coordination.js";
import type { InstructionRecord } from "../../src/domain/instruction.js";
import { DEFAULT_NOTIFICATION_POLICY, settledDedupeKey } from "../../src/domain/orchestrator-notification.js";
import { orchestratorController, type OrchestratorBinding } from "../../src/domain/orchestrator.js";
import { SessionRecordSchema, type SessionRecord } from "../../src/domain/session.js";
import { OwnershipSubjectSchema, type OwnershipSubject, type WorkerEvent } from "../../src/domain/worker-coordination.js";
import { createWorkerBudgetRecord, WorkerBudgetDeclarationSchema, WorkerBudgetEnforcementSchema } from "../../src/domain/worker-budget.js";
import type { WorkerTruth } from "../../src/domain/worker-truth.js";
import { OrchestratorControllerDirectory } from "../../src/orchestration/orchestrator-controller-directory.js";
import { observeInstructionRepository } from "../../src/orchestration/observed-instruction-repository.js";
import { OrchestratorNotificationStore } from "../../src/persistence/orchestrator-notification-store.js";

const NOW = "2026-10-07T10:00:00.000Z";
const A = "orchestrator:a", B = "orchestrator:b";
const directories: string[] = [];
const producers: OrchestratorNotificationProducer[] = [];
afterEach(async () => {
  for (const producer of producers.splice(0)) { await producer.start(); producer.stop(); }
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return SessionRecordSchema.parse({ id: randomUUID(), name: "Builder", provider: "codex", cwd: "/repo",
    detached: true, sandbox: "workspace-write", kind: "worker", executionState: "active",
    attachmentState: "detached", pid: 123, exitCode: null, childIds: [],
    createdAt: NOW, updatedAt: NOW, ...overrides });
}
function truth(overrides: Partial<WorkerTruth> = {}): WorkerTruth {
  return { state: "working", terminal: false, completedTurns: 0, canonicalTurns: 0,
    pendingInstructions: 0, composerOccupied: false, modalOpen: false, detail: "Working", ...overrides };
}
function controller(controllerId: string) {
  return { controllerId, familyId: controllerId, scope: { kind: "fleet" as const, scopeId: "fleet" } };
}
function subject(record: SessionRecord, owner = A): OwnershipSubject {
  return OwnershipSubjectSchema.parse({ subjectId: record.id, subjectKind: "worker", lifecycle: "working",
    origin: { creatorControllerId: A, taskId: "task-a", waveId: "wave-a", threadId: record.id, createdAt: NOW },
    resources: { sessionId: record.id, eventStreamId: `worker:${record.id}` },
    lease: { leaseId: randomUUID(), version: 1, state: "active", controller: controller(owner),
      issuedAt: NOW, renewedAt: NOW, expiresAt: NOW }, updatedAt: NOW });
}
function instruction(targetSessionId: string, overrides: Partial<InstructionRecord> = {}): InstructionRecord {
  return { id: randomUUID(), actorSessionId: randomUUID(), targetSessionId, message: "Continue",
    status: "rendered", expectedTurn: 2, messageId: randomUUID(), hop: 0,
    createdAt: NOW, updatedAt: NOW, ...overrides };
}
function event(workerId: string, overrides: Partial<WorkerEvent> = {}): WorkerEvent {
  return { schemaVersion: 1, eventId: randomUUID(), sequence: 1, workerId, taskId: "task-a", waveId: "wave-a",
    controllerLeaseVersion: 1, kind: "DECISION_REQUEST", severity: "error", interventionRequired: false,
    summary: "Choose next step", evidenceRefs: [], changedAssumptions: [], continuation: "continuing",
    timestamp: NOW, ...overrides };
}
function binding(sessionId: string): OrchestratorBinding {
  return { key: "fleet", kind: "primary", sessionId, provider: "codex", cwd: "/repo",
    sandbox: "workspace-write", scope: { kind: "fleet" },
    grant: { subjectSessionId: sessionId, capabilities: ["thread.read"], scope: { kind: "fleet" } },
    createdAt: NOW, updatedAt: NOW };
}
class FakeRegistry {
  records = new Map<string, SessionRecord>();
  truths = new Map<string, WorkerTruth>();
  listeners = new Set<(sessionId: string) => void>();
  get = (id: string): SessionRecord => {
    const record = this.records.get(id); if (record === undefined) throw new Error("missing"); return record;
  };
  list = () => [...this.records.values()];
  workerTruth = (id: string) => this.truths.get(id)!;
  onSessionUpdate = (listener: (id: string) => void) => {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  };
  fire(id: string, update: Partial<WorkerTruth>) {
    this.truths.set(id, truth(update));
    for (const listener of this.listeners) listener(id);
  }
}
class FakeCoordination {
  subjects = new Map<string, OwnershipSubject>();
  events = new Set<WorkerEventObserver>();
  handoffs = new Set<HandoffBatchObserver>();
  budgets = new Set<WorkerBudgetUpdateListener>();
  getSubject = (id: string) => this.subjects.get(id);
  onEventSubmitted = (listener: WorkerEventObserver) => {
    this.events.add(listener); return () => { this.events.delete(listener); };
  };
  onHandoffCommitted = (listener: HandoffBatchObserver) => {
    this.handoffs.add(listener); return () => { this.handoffs.delete(listener); };
  };
  onBudgetUpdate = (listener: WorkerBudgetUpdateListener) => {
    this.budgets.add(listener); return () => { this.budgets.delete(listener); };
  };
  fireEvent(value: WorkerEvent, code: "accepted" | "superseded" | "rejected" = "accepted") {
    for (const listener of this.events) listener(value, { code, eventId: value.eventId });
  }
}
async function fixture(initialTruth: Partial<WorkerTruth> = {}, initialInstructions: InstructionRecord[] = []) {
  const directory = await mkdtemp(join(tmpdir(), "cyberdeck-producer-")); directories.push(directory);
  const inbox = new OrchestratorNotificationStore(directory, { now: () => NOW }); await inbox.load();
  const registry = new FakeRegistry(), coordination = new FakeCoordination();
  const worker = session(); registry.records.set(worker.id, worker); registry.truths.set(worker.id, truth(initialTruth));
  coordination.subjects.set(worker.id, subject(worker));
  const bindings: OrchestratorBinding[] = [];
  const controllers = new OrchestratorControllerDirectory({ list: async () => bindings,
    findBySessionId: async (id) => bindings.find((item) => item.sessionId === id) });
  const options = { registry, coordination, inbox, controllers, now: () => NOW,
    instructions: { list: async () => initialInstructions } };
  const producer = new OrchestratorNotificationProducer(options); producers.push(producer); await producer.start();
  return { directory, inbox, registry, coordination, worker, bindings, options, producer,
    flush: () => producer.start(), pending: (id = A) => inbox.listPending(id, 0, 50) };
}

describe("OrchestratorNotificationProducer", () => {
  it("settles every rendered/submitted/acknowledged/completed target once, survives restart and acknowledgement", async () => {
    const f = await fixture();
    for (const [index, status] of (["rendered", "submitted", "acknowledged", "completed"] as const).entries()) {
      f.producer.observeInstruction(instruction(f.worker.id, { status, expectedTurn: index + 2 }));
    }
    await f.flush();
    f.registry.fire(f.worker.id, { completedTurns: 5, canonicalTurns: 5 }); await f.flush();
    f.registry.fire(f.worker.id, { completedTurns: 5 }); await f.flush();
    expect(f.pending().map((item) => item.completionTarget)).toEqual([1, 2, 3, 4, 5]);
    for (const item of f.pending()) expect(item).toMatchObject({ kind: "settled", severity: "info",
      dedupeKey: settledDedupeKey(f.worker.id, item.completionTarget), wakeEligible: true, createdAt: NOW });
    f.producer.stop();
    const replay = new OrchestratorNotificationStore(f.directory); await replay.load();
    const history = [2, 3, 4, 5].map((expectedTurn) => instruction(f.worker.id, { expectedTurn }));
    const restarted = new OrchestratorNotificationProducer({ ...f.options, inbox: replay,
      instructions: { list: async () => history } }); producers.push(restarted);
    await restarted.start(); expect(replay.headCursor(A)).toBe(5);
    expect(replay.listPending(A, 0, 50)).toHaveLength(5);
    await replay.acknowledgeThrough(A, 5); restarted.stop();
    await restarted.start(); expect(replay.headCursor(A)).toBe(5); expect(replay.pendingCount(A)).toBe(0);
  });

  it("catches up completed and terminal workers from instruction history, seeded attention stays quiet", async () => {
    const f = await fixture({ state: "stalled", stalledForSeconds: 650 });
    expect(f.pending()).toEqual([]);
    f.registry.fire(f.worker.id, { state: "stalled", stalledForSeconds: 650 }); await f.flush();
    expect(f.pending()).toEqual([]);
    f.producer.stop();
    f.registry.truths.set(f.worker.id, truth({ completedTurns: 3, terminal: true, state: "exited", detail: "Exited" }));
    const restarted = new OrchestratorNotificationProducer({ ...f.options,
      instructions: { list: async () => [instruction(f.worker.id, { expectedTurn: 3 })] } });
    producers.push(restarted); await restarted.start();
    expect(f.pending().map((item) => item.dedupeKey)).toEqual([
      settledDedupeKey(f.worker.id, 1), settledDedupeKey(f.worker.id, 3), settledDedupeKey(f.worker.id),
    ]);
    expect(f.pending()[2]).toMatchObject({ severity: "info", wakeEligible: true });
    restarted.stop(); await restarted.start(); expect(f.inbox.headCursor(A)).toBe(3);
  });

  it.each(["failed", "errored", "provider-limit", "stopped", "exited"] as const)(
    "terminal %s carries lowest unreached target and Scout/provider detail", async (state) => {
      const f = await fixture(); f.registry.records.set(f.worker.id, { ...f.worker, profile: "scout" });
      for (const expectedTurn of [4, 2]) f.producer.observeInstruction(instruction(f.worker.id, { expectedTurn }));
      await f.flush();
      f.registry.fire(f.worker.id, { state, terminal: true, completedTurns: 1, detail: "Stopped\nnow",
        providerLimit: { kind: "session-limit", reason: "Window exhausted", detail: "limit" } }); await f.flush();
      f.registry.fire(f.worker.id, { state, terminal: true, completedTurns: 1 }); await f.flush();
      expect(f.pending()).toHaveLength(2);
      expect(f.pending()[1]).toMatchObject({ kind: "settled", completionTarget: 2,
        severity: ["failed", "errored", "provider-limit"].includes(state) ? "warning" : "info",
        dedupeKey: settledDedupeKey(f.worker.id), wakeEligible: true, refs: ["profile:scout"] });
      expect(f.pending()[1]?.summary).toContain(`${state}: Stopped now; Window exhausted; scout`);
    },
  );

  it("catches expectedTurn persisted after completion without waiting for another registry edge", async () => {
    const f = await fixture({ completedTurns: 2 });
    f.producer.observeInstruction(instruction(f.worker.id)); await f.flush();
    expect(f.pending().map((item) => item.completionTarget)).toEqual([1, 2]);
  });

  it("modal edges carry kind/fingerprint and dedupe across close/reopen", async () => {
    const f = await fixture();
    const modal = { provider: "codex", kind: "permission-approval" as const, fingerprint: "fingerprint-a",
      evidence: "Approve", answers: [] };
    f.registry.fire(f.worker.id, { state: "blocked-modal", detail: "Needs permission", modal });
    f.registry.fire(f.worker.id, { state: "blocked-modal", modal });
    f.registry.fire(f.worker.id, { state: "working" });
    f.registry.fire(f.worker.id, { state: "blocked-modal", modal }); await f.flush();
    expect(f.pending()).toHaveLength(1);
    expect(f.pending()[0]).toMatchObject({ kind: "attention", severity: "warning", wakeEligible: true,
      dedupeKey: `attention:modal:${f.worker.id}:fingerprint-a`, refs: ["fingerprint-a"],
      summary: "Builder: Needs permission; permission-approval" });
    f.registry.fire(f.worker.id, { state: "working" });
    f.registry.fire(f.worker.id, { state: "blocked-modal" }); await f.flush();
    expect(f.pending()[1]?.dedupeKey).toBe(`attention:modal:${f.worker.id}:unknown`);
  });

  it("stalled edges replace only at subsequent 300-second buckets", async () => {
    const f = await fixture();
    for (const stalledForSeconds of [299, 299, 300, 301, 599, 600]) {
      f.registry.fire(f.worker.id, { state: "stalled", detail: "No progress", stalledForSeconds });
    }
    await f.flush(); expect(f.inbox.headCursor(A)).toBe(3); expect(f.pending()).toHaveLength(1);
    expect(f.pending()[0]).toMatchObject({ kind: "attention", severity: "warning", wakeEligible: false,
      dedupeKey: `attention:${f.worker.id}`, summary: "Builder: No progress; stalled 600s" });
  });

  it.each([
    ["DECISION_REQUEST", false, "continuing"], ["EXCEPTION", true, "blocked"],
    ["CHECKPOINT", false, "awaiting-response"],
  ] as const)("%s produces one wake-eligible intervention", async (kind, interventionRequired, continuation) => {
    const f = await fixture(); const value = event(f.worker.id, { kind, interventionRequired, continuation,
      recommendedAction: "Pick option B", checkpointCorrelationId: "checkpoint-a" });
    f.coordination.fireEvent(value); f.coordination.fireEvent(value); await f.flush();
    expect(f.pending()).toHaveLength(1);
    expect(f.pending()[0]).toMatchObject({ kind: "intervention", severity: "error", wakeEligible: true,
      dedupeKey: `event:${value.eventId}`, refs: [value.eventId, "checkpoint-a"],
      workerId: f.worker.id, taskId: "task-a", waveId: "wave-a", summary: "Builder: Choose next step; Pick option B" });
  });

  it.each(["warning", "critical"] as const)("RISK preserves %s severity", async (severity) => {
    const f = await fixture(); const value = event(f.worker.id, { kind: "RISK", severity });
    f.coordination.fireEvent(value); await f.flush();
    expect(f.pending()[0]).toMatchObject({ kind: "risk", severity, wakeEligible: severity === "critical",
      dedupeKey: `event:${value.eventId}` });
  });

  it("ten progress events keep only latest, checkpoint answers share replacement", async () => {
    const f = await fixture();
    for (let sequence = 1; sequence <= 10; sequence++) f.coordination.fireEvent(event(f.worker.id,
      { kind: "PROGRESS", sequence, severity: "critical", summary: `Step ${sequence}` }));
    await f.flush(); expect(f.pending()).toHaveLength(1); expect(f.inbox.headCursor(A)).toBe(10);
    expect(f.pending()[0]).toMatchObject({ kind: "progress", severity: "info", wakeEligible: false,
      dedupeKey: `progress:${f.worker.id}`, summary: "Builder: Step 10" });
    f.coordination.fireEvent(event(f.worker.id, { kind: "CHECKPOINT", summary: "Answer" })); await f.flush();
    expect(f.pending()).toHaveLength(1); expect(f.pending()[0]?.summary).toBe("Builder: Answer");
    f.coordination.fireEvent(event(f.worker.id, { kind: "EXCEPTION" }));
    f.coordination.fireEvent(event(f.worker.id), "rejected"); await f.flush(); expect(f.inbox.headCursor(A)).toBe(11);
  });

  it("observed queue writes emit undelivered and human-controller holds only on edges", async () => {
    const f = await fixture(); const value = instruction(f.worker.id, { status: "queued", holdReason: "provider-busy" });
    const repository = observeInstructionRepository({ list: async () => [], put: async () => {} },
      (record) => f.producer.observeInstruction(record));
    await repository.put(value); await f.flush(); expect(f.pending()).toEqual([]);
    const held = { ...value, holdReason: "human-controller" };
    await repository.put(held); await repository.put(held);
    const failed = { ...held, status: "undelivered" as const, holdReason: "terminal-worker" };
    await repository.put(failed); await repository.put(failed); await f.flush();
    expect(f.pending()).toHaveLength(2);
    for (const [index, reason] of ["human-controller", "undelivered"].entries()) {
      expect(f.pending()[index]).toMatchObject({ kind: "delivery", severity: "warning", wakeEligible: true,
        dedupeKey: `delivery:${value.id}:${reason}`, refs: [value.id, value.messageId] });
    }
    expect(f.pending()[1]?.summary).toContain("terminal-worker");
  });

  it("brokerOwned delivery and every orchestrator trigger produce nothing", async () => {
    const f = await fixture();
    f.producer.observeInstruction(instruction(f.worker.id, { brokerOwned: true, status: "undelivered" }));
    f.producer.observeInstruction(instruction(f.worker.id, { brokerOwned: true, status: "queued", holdReason: "human-controller" }));
    const orchestrator = session({ kind: "orchestrator" }); f.registry.records.set(orchestrator.id, orchestrator);
    f.coordination.subjects.set(orchestrator.id, subject(orchestrator));
    f.registry.fire(orchestrator.id, { terminal: true, state: "failed", completedTurns: 3 });
    f.producer.observeInstruction(instruction(orchestrator.id, { status: "undelivered" }));
    f.coordination.fireEvent(event(orchestrator.id)); await f.flush(); expect(f.pending()).toEqual([]);
  });

  it("soft budget states dedupe per revision, active/hard states do nothing", async () => {
    const f = await fixture(); const budget = createWorkerBudgetRecord(WorkerBudgetDeclarationSchema.parse({
      resource: "session", allocation: { unit: "tokens", amount: 1_000 },
    }), NOW);
    for (const [revision, state] of [[1, "active"], [1, "soft-pending"], [1, "soft-pending"],
      [1, "soft-notified"], [2, "soft-notified"], [2, "hard-reached"]] as const) {
      for (const listener of f.coordination.budgets) listener(f.worker.id,
        { ...budget, revision, enforcement: WorkerBudgetEnforcementSchema.parse({ state, revision,
          reachedAt: NOW, notifiedAt: NOW }) });
    }
    await f.flush(); expect(f.pending()).toHaveLength(2);
    expect(f.pending().map((item) => item.dedupeKey)).toEqual([`budget:soft:${f.worker.id}:1`, `budget:soft:${f.worker.id}:2`]);
    for (const item of f.pending()) expect(item).toMatchObject({ kind: "budget", severity: "warning", wakeEligible: false });
  });

  it("routes lease, origin, parent binding, then skips unknown controller; legacy kind is worker", async () => {
    const f = await fixture(); const current = f.coordination.subjects.get(f.worker.id)!;
    current.lease.controller = controller(B); f.coordination.fireEvent(event(f.worker.id)); await f.flush();
    expect(f.pending(B)).toHaveLength(1); expect(f.pending()).toEqual([]);
    current.lease.controller = undefined; f.coordination.fireEvent(event(f.worker.id)); await f.flush();
    expect(f.pending()).toHaveLength(1);
    f.coordination.subjects.delete(f.worker.id);
    const parent = binding(randomUUID()); f.bindings.push(parent);
    f.registry.records.set(f.worker.id, { ...f.worker, kind: undefined, parentSessionId: parent.sessionId });
    f.coordination.fireEvent(event(f.worker.id)); await f.flush();
    expect(f.pending(orchestratorController(parent).controllerId)).toHaveLength(1);
    f.bindings.length = 0; f.coordination.fireEvent(event(f.worker.id)); await f.flush();
    expect(f.inbox.controllers()).toHaveLength(3);
    f.registry.fire(randomUUID(), { state: "failed", terminal: true }); await f.flush();
  });

  it("two controllers keep separate inboxes; transfer affects future writes only", async () => {
    const f = await fixture(); const second = session({ name: "Second" });
    f.registry.records.set(second.id, second); f.registry.truths.set(second.id, truth());
    f.coordination.subjects.set(second.id, subject(second, B));
    f.coordination.fireEvent(event(f.worker.id)); f.coordination.fireEvent(event(second.id)); await f.flush();
    const original = f.pending()[0]; expect(f.pending(B).map((item) => item.sessionId)).toEqual([second.id]);
    f.coordination.subjects.get(f.worker.id)!.lease.controller = controller(B);
    f.coordination.fireEvent(event(f.worker.id)); await f.flush();
    expect(f.pending()).toEqual([original]); expect(f.pending(B).map((item) => item.sessionId)).toEqual([second.id, f.worker.id]);
  });

  it("handoff writes each session-bearing worker directly to recipient, once", async () => {
    const f = await fixture(); const second = session({ name: "Second" });
    f.registry.records.set(second.id, second); f.coordination.subjects.set(second.id, subject(second));
    const missing = subject(session()); missing.resources.sessionId = undefined;
    f.coordination.subjects.set(missing.subjectId, missing);
    const handoffId = randomUUID();
    const input: HandoffBatchInput = { mutationId: "handoff", actor: controller(A), recipient: controller(B),
      recipientSessionId: randomUUID(), directive: "Input directive", reason: "Move", members: [] };
    const result: HandoffBatchResult = { mutationId: "handoff", operation: "handoff", idempotentReplay: false,
      committed: true, outcomes: [], handoff: { schemaVersion: 1, handoffId, recipient: controller(B),
        recipientSessionId: input.recipientSessionId, issuedBy: controller(A), directive: "Durable\ndirective",
        issuedAt: NOW, state: "pending", manifest: [f.worker.id, second.id, missing.subjectId].map((workerId) =>
          ({ workerId, taskId: "task-a", lifecycle: "working" })) } };
    const { handoff: _handoff, ...noHandoff } = result;
    for (const listener of f.coordination.handoffs) { listener(input, result); listener(input, result);
      listener(input, noHandoff); }
    await f.flush(); expect(f.pending()).toEqual([]); expect(f.pending(B)).toHaveLength(2);
    for (const item of f.pending(B)) expect(item).toMatchObject({ kind: "handoff", severity: "info", wakeEligible: true,
      dedupeKey: `handoff:${handoffId}:${item.sessionId}`, refs: [handoffId] });
    expect(f.pending(B)[0]?.summary).toBe("Builder: handoff: Durable directive");
  });

  it("uses policy at write time, bounds summaries and strips every line separator", async () => {
    const f = await fixture(); await f.inbox.setPolicy(A, { ...DEFAULT_NOTIFICATION_POLICY, wake: "off" });
    f.coordination.fireEvent(event(f.worker.id, { summary: "x\r\ny\u2028z\u2029".repeat(150), recommendedAction: "Choose" }));
    await f.flush(); expect(f.pending()[0]?.summary).toHaveLength(512);
    expect(f.pending()[0]?.summary).toMatch(/^Builder: /); expect(f.pending()[0]?.summary).not.toMatch(/[\r\n\u2028\u2029]/);
    expect(f.pending()[0]?.wakeEligible).toBe(false);
    await f.inbox.setPolicy(A, { ...DEFAULT_NOTIFICATION_POLICY, wake: "all" });
    f.coordination.fireEvent(event(f.worker.id, { kind: "PROGRESS" })); await f.flush();
    expect(f.pending()[1]?.wakeEligible).toBe(true);
  });

  it("subscribes before the history scan, preserves updates received during startup", async () => {
    const f = await fixture(); f.producer.stop();
    let release!: (records: InstructionRecord[]) => void;
    const history = new Promise<InstructionRecord[]>((resolve) => { release = resolve; });
    const restarted = new OrchestratorNotificationProducer({ ...f.options,
      instructions: { list: () => history } }); producers.push(restarted);
    const starting = restarted.start();
    expect([f.registry.listeners.size, f.coordination.events.size, f.coordination.handoffs.size, f.coordination.budgets.size])
      .toEqual([1, 1, 1, 1]);
    f.coordination.fireEvent(event(f.worker.id, { summary: "During startup" }));
    release([instruction(f.worker.id, { expectedTurn: 2 })]);
    await starting; await restarted.start();
    expect(f.pending()[0]?.summary).toBe("Builder: During startup");
    f.registry.fire(f.worker.id, { completedTurns: 2 }); await restarted.start();
    expect(f.pending().filter((item) => item.kind === "settled").map((item) => item.completionTarget)).toEqual([1, 2]);
  });

  it("startup seeds instruction edges without replaying old delivery records", async () => {
    const f = await fixture(); f.producer.stop();
    const held = instruction(f.worker.id, { status: "queued", holdReason: "human-controller" });
    const restarted = new OrchestratorNotificationProducer({ ...f.options,
      instructions: { list: async () => [held] } }); producers.push(restarted);
    await restarted.start(); restarted.observeInstruction(held); await restarted.start();
    expect(f.pending()).toEqual([]);
    restarted.observeInstruction({ ...held, status: "undelivered" }); await restarted.start();
    expect(f.pending()[0]?.kind).toBe("delivery");
  });

  it("instruction edge cache stays bounded; durable dedupe survives eviction", async () => {
    const f = await fixture(); const held = instruction(f.worker.id, { status: "queued", holdReason: "human-controller" });
    f.producer.observeInstruction(held); await f.flush();
    for (let index = 0; index < 4_096; index++) f.producer.observeInstruction(instruction(f.worker.id,
      { status: "queued", holdReason: "provider-busy" }));
    await f.flush(); f.producer.observeInstruction(held); await f.flush();
    expect(f.inbox.headCursor(A)).toBe(1);
  });

  it("failed catch-up rejects start and unsubscribes; retry recovers target", async () => {
    const f = await fixture(); f.producer.stop();
    f.registry.truths.set(f.worker.id, truth({ completedTurns: 1 }));
    const append = vi.spyOn(f.inbox, "append").mockRejectedValueOnce(new Error("disk failed"));
    const restarted = new OrchestratorNotificationProducer(f.options); producers.push(restarted);
    await expect(restarted.start()).rejects.toThrow("disk failed");
    expect([f.registry.listeners.size, f.coordination.events.size, f.coordination.handoffs.size, f.coordination.budgets.size])
      .toEqual([0, 0, 0, 0]);
    append.mockRestore(); await restarted.start(); expect(f.pending()[0]?.completionTarget).toBe(1);
  });

  it("background write failures warn, cannot break successful upstream observation", async () => {
    const f = await fixture(); const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    vi.spyOn(f.inbox, "append").mockRejectedValueOnce(new Error("disk failed"));
    expect(() => f.coordination.fireEvent(event(f.worker.id))).not.toThrow(); await f.flush();
    expect(warning).toHaveBeenCalledWith("Orchestrator notification producer write failed; inspect inbox health",
      { code: "ORCHESTRATOR_NOTIFICATION_WRITE_FAILED" });
    f.coordination.fireEvent(event(f.worker.id)); await f.flush(); expect(f.pending()).toHaveLength(1);
  });

  it("stop lets accepted writes finish but ignores later instruction puts", async () => {
    const f = await fixture();
    f.coordination.fireEvent(event(f.worker.id));
    const accepted = f.flush(); f.producer.stop();
    f.producer.observeInstruction(instruction(f.worker.id, { status: "undelivered" }));
    await accepted; expect(f.pending()).toHaveLength(1); expect(f.pending()[0]?.kind).toBe("intervention");
  });

  it("start subscribes once, stop unsubscribes every hook and rejects later input", async () => {
    const f = await fixture(); await f.producer.start();
    expect([f.registry.listeners.size, f.coordination.events.size, f.coordination.handoffs.size, f.coordination.budgets.size])
      .toEqual([1, 1, 1, 1]);
    f.producer.stop(); f.producer.stop();
    expect([f.registry.listeners.size, f.coordination.events.size, f.coordination.handoffs.size, f.coordination.budgets.size])
      .toEqual([0, 0, 0, 0]);
    f.producer.observeInstruction(instruction(f.worker.id, { status: "undelivered" }));
    f.coordination.fireEvent(event(f.worker.id)); expect(f.pending()).toEqual([]);
  });
});
