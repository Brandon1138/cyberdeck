import { admitSubmitRetry } from "../../src/orchestration/session/worker-submit-verification.js";
import { describe, expect, it, vi } from "vitest";
import { InstructionQueue } from "../../src/orchestration/instruction-queue.js";
import { AgentControlService } from "../../src/orchestration/agent-control-service.js";
import { WorkerControlService } from "../../src/orchestration/worker-control-service.js";
import { OrchestratorPeerService } from "../../src/orchestration/orchestrator-peer-service.js";
import { WorkflowService } from "../../src/orchestration/workflow-service.js";
import { OrchestratorAttentionControlPlane } from "../../src/orchestration/orchestrator-attention-control.js";
import { OrchestratorNotificationControlPlane } from "../../src/orchestration/orchestrator-notification-control.js";
import type { InstructionRecord, InstructionAdmission } from "../../src/domain/instruction.js";
import type { WorkflowRun, WorkflowMessage } from "../../src/domain/workflow.js";
import type { SessionInstructionPort } from "../../src/orchestration/session/session-ports.js";
import { fixture, deferred, identity, actor, target, successor, at } from "./strigoi-admission-fixture.js";

function queueFixture(f = fixture()) {
  const records = new Map<string, InstructionRecord>();
  const entered = deferred(), preflight = deferred(), write = vi.fn();
  let finalAdmission: InstructionAdmission | undefined;
  const registry = { ...f.registry,
    onControllerReleased: () => () => {}, onDeliveryBoundary: () => () => {}, onInstructionState: () => () => {},
    submitInstruction: vi.fn(async (_id, _message, _source, _meta, _instruction, admission) => {
      finalAdmission = admission;
      entered.resolve(); await preflight.promise;
      await admission!(write);
      return { state: "rendered" as const, at };
    }),
  } satisfies SessionInstructionPort;
  const put = vi.fn(async (record: InstructionRecord) => { records.set(record.id, record); });
  const queue = new InstructionQueue(registry, f.bindings, { list: async () => [...records.values()], put }, undefined, f.admission);
  return { f, queue, records, put, entered, preflight, write, registry, finalAdmission: () => finalAdmission! };
}

describe("Strigoi at real application boundaries", () => {
  it("revalidates the current grant after queue provider preflight and retains an explicit hold", async () => {
    const q = queueFixture();
    const pending = q.queue.enqueue({ actorSessionId: actor, targetSessionId: target, message: "do it" });
    await q.entered.promise;
    q.f.state().activeBinding!.grant.capabilities = [];
    q.preflight.resolve();
    await expect(pending).resolves.toMatchObject({ status: "queued", holdReason: "CAPABILITY_DENIED" });
    expect(q.write).not.toHaveBeenCalled();
  });
  it("freezes during preflight without waiting for the provider and fences submission retries too", async () => {
    const q = queueFixture();
    const pending = q.queue.enqueue({ actorSessionId: actor, targetSessionId: target, message: "do it" });
    await q.entered.promise;
    await q.f.admission.freeze(identity); // Must resolve while preflight is still unresolved.
    q.preflight.resolve();
    await expect(pending).resolves.toMatchObject({ status: "queued", holdReason: "STRIGOI_FROZEN" });
    await expect(q.finalAdmission()(q.write)).rejects.toMatchObject({ code: "STRIGOI_FROZEN" });
    expect(q.write).not.toHaveBeenCalled();
  });
  it("rejects an old queued actor after g+1 commit", async () => {
    const q = queueFixture();
    const pending = q.queue.enqueue({ actorSessionId: actor, targetSessionId: target, message: "do it" });
    await q.entered.promise;
    await q.f.admission.freeze(identity);
    q.f.set({ ...q.f.state(), incarnation: 2, activeBinding: { ...q.f.state().activeBinding!, sessionId: successor,
      resident: { name: "strigoi", incarnation: 2 } } });
    q.preflight.resolve();
    await expect(pending).resolves.toMatchObject({ status: "queued", holdReason: "STRIGOI_STALE_INCARNATION" });
    expect(q.write).not.toHaveBeenCalled();
  });
  it("drains an actual final write before freeze completes", async () => {
    const q = queueFixture(), writing = deferred(), finish = deferred(), frozen = vi.fn();
    q.write.mockImplementation(async () => { writing.resolve(); await finish.promise; });
    q.preflight.resolve();
    const pending = q.queue.enqueue({ actorSessionId: actor, targetSessionId: target, message: "do it" });
    await writing.promise;
    const freezing = q.f.admission.freeze(identity).then(frozen);
    await Promise.resolve(); expect(frozen).not.toHaveBeenCalled();
    finish.resolve(); await pending; await freezing;
    expect(frozen).toHaveBeenCalledOnce();
  });
  it("nested workflow -> queue releases the permit before provider preflight", async () => {
    const q = queueFixture(), runs = new Map<string, WorkflowRun>(), messages: WorkflowMessage[] = [];
    const service = new WorkflowService(q.registry, q.f.bindings, {
      putRun: async (run) => { runs.set(run.id, run); }, listRuns: async () => [...runs.values()],
      getRun: async (id) => runs.get(id), putMessage: async (message) => { messages.push(message); },
      listMessages: async (id) => messages.filter((message) => message.runId === id),
    }, q.queue, q.f.admission);
    const run = await service.create({ actorSessionId: actor, name: "loop", participantSessionIds: [target] });
    const sending = service.send({ actorSessionId: actor, runId: run.id, targetSessionId: target, text: "wake", wake: true });
    await q.entered.promise;
    await q.f.admission.freeze(identity);
    q.preflight.resolve(); await sending;
    expect(messages).toHaveLength(1);
    expect([...q.records.values()]).toMatchObject([{ status: "queued", holdReason: "STRIGOI_FROZEN" }]);
    expect(q.write).not.toHaveBeenCalled();
  });
  it("does not hold admission across worker waits, and rejects their late notification acknowledgements", async () => {
    const f = fixture(), waiting = deferred(), finish = deferred(), acknowledge = vi.fn();
    const registry = { ...f.registry, waitForWorkerResults: vi.fn(async () => {
      waiting.resolve(); await finish.promise; return { timedOut: false, results: [] };
    }) };
    const service = new AgentControlService(registry as never, f.bindings as never, {} as never, undefined,
      { strigoi: f.admission, notifications: { acknowledgeByDedupeKey: acknowledge } });
    const pending = service.waitForWorkers({ actorSessionId: actor, targets: [{ sessionId: target }] });
    await waiting.promise; await f.admission.freeze(identity); finish.resolve();
    await expect(pending).rejects.toMatchObject({ code: "STRIGOI_FROZEN" });
    expect(acknowledge).not.toHaveBeenCalled();
  });
  it("revalidates worker-start authority after asynchronous preferences preflight", async () => {
    const f = fixture(), entered = deferred(), finish = deferred(), start = vi.fn();
    const service = new AgentControlService({ ...f.registry, start } as never, f.bindings as never, {} as never,
      { get: async () => { entered.resolve(); await finish.promise; return { caveman: false }; } } as never,
      { strigoi: f.admission });
    const pending = service.startWorker({ actorSessionId: actor, provider: "codex", cwd: "/repo", prompt: "inspect" });
    await entered.promise;
    await f.admission.freeze(identity); finish.resolve();
    await expect(pending).rejects.toMatchObject({ code: "STRIGOI_FROZEN" });
    expect(start).not.toHaveBeenCalled();
  });

  it("fences every externally requested mutation before its effects", async () => {
    const f = fixture(), effect = vi.fn();
    const registry = { ...f.registry, onSessionUpdate: () => () => {}, start: effect, stop: effect, forceStop: effect };
    const bindings = { ...f.bindings, get: async () => undefined, list: async () => [] };
    const agent = new AgentControlService(registry as never, bindings, {} as never, undefined, { strigoi: f.admission });
    const worker = new WorkerControlService({ registry: registry as never, orchestrators: bindings,
      coordination: { acknowledgeHandoffs: effect } as never, strigoi: f.admission });
    const peer = new OrchestratorPeerService({ registry, bindings, manager: { createPeer: effect }, strigoi: f.admission });
    const workflow = new WorkflowService(registry, bindings, { putRun: effect, putMessage: effect, getRun: effect } as never,
      { enqueue: effect }, f.admission);
    const attention = new OrchestratorAttentionControlPlane({ store: { update: effect }, strigoi: f.admission } as never);
    const notifications = new OrchestratorNotificationControlPlane({ inbox: { setPolicy: effect, acknowledgeThrough: effect },
      strigoi: f.admission } as never);
    const q = queueFixture(f);
    await f.admission.freeze(identity);
    const actions = [
      () => agent.startWorker({ actorSessionId: actor, provider: "codex", cwd: "/repo", prompt: "inspect" }),
      () => agent.stopOrchestrator({ actorSessionId: actor, targetSessionId: target, expectedGeneration: 1, reason: "test" }),
      () => agent.answerOrchestratorModal({ actorSessionId: actor, targetSessionId: target, fingerprint: "0123456789", answer: "yes", reason: "test" }),
      () => worker.lease({ actorSessionId: actor, action: "acquire", scope: "worker", workerId: target, reason: "test" }),
      () => worker.control({ actorSessionId: actor, action: "stop", workerId: target, reason: "test" }),
      () => worker.events({ actorSessionId: actor, acknowledgeHandoffIds: [target] }),
      () => peer.create({ actorSessionId: actor, provider: "codex", model: "test", cwd: "/repo", reason: "test" }),
      () => workflow.create({ actorSessionId: actor, name: "test", participantSessionIds: [target] }),
      () => workflow.send({ actorSessionId: actor, runId: target, targetSessionId: target, text: "test" }),
      () => workflow.cancel(actor, target),
      () => attention.arm({ actorSessionId: actor, mutationId: target, objective: "Review", nextAction: "Continue", targets: [{ sessionId: target, completionTarget: 1 }] }),
      () => attention.cancel({ actorSessionId: actor, epoch: target }),
      () => attention.readPage(actor, target, [], 1000),
      () => attention.acknowledge(actor, target, successor),
      () => notifications.configure({ actorSessionId: actor, policy: { wake: "off" } }),
      () => notifications.read({ actorSessionId: actor, acknowledgeThrough: 1 }),
      () => notifications.notice({ actorSessionId: actor }),
      () => q.queue.enqueue({ actorSessionId: actor, targetSessionId: target, message: "test" }),
      () => q.queue.prepareLaunch({ actorSessionId: actor, target: registry.get(target), message: "test", instructionId: target }),
    ];
    for (const action of actions) await expect(action()).rejects.toMatchObject({ code: "STRIGOI_FROZEN" });
    expect(effect).not.toHaveBeenCalled(); expect(q.put).not.toHaveBeenCalled();
  });
  it("permits a real read-only worker recovery survey while frozen without reconciling durable state", async () => {
    const f = fixture(), reconcile = vi.fn();
    const worker = new WorkerControlService({ registry: { ...f.registry, onSessionUpdate: () => () => {} } as never,
      orchestrators: f.bindings, coordination: { listSubjects: () => [], reconcileLifecycle: reconcile } as never,
      strigoi: f.admission });
    await f.admission.freeze(identity);
    await expect(worker.surveyRecovery(actor)).resolves.toMatchObject({ eligible: [], blocked: [] });
    expect(reconcile).not.toHaveBeenCalled();
  });
  it("does not bypass resident admission for broker-owned queue writes", async () => {
    const q = queueFixture();
    const pending = q.queue.enqueueBroker({ actorSessionId: actor, targetSessionId: target, message: "policy", messageId: target });
    await q.entered.promise; await q.f.admission.freeze(identity); q.preflight.resolve();
    await expect(pending).resolves.toMatchObject({ status: "queued", holdReason: "STRIGOI_FROZEN" });
    expect(q.write).not.toHaveBeenCalled();
  });
  it("still delivers normally for the current resident", async () => {
    const q = queueFixture(); q.preflight.resolve();
    await expect(q.queue.enqueue({ actorSessionId: actor, targetSessionId: target, message: "hello" }))
      .resolves.toMatchObject({ status: "rendered" });
    expect(q.write).toHaveBeenCalledOnce();
  });
  it("does not let caller-supplied recovery classification bypass service mutation checks", async () => {
    const q = queueFixture(); await q.f.admission.freeze(identity);
    await expect(q.queue.enqueue({ actorSessionId: actor, targetSessionId: target, message: "test", operation: "recovery" } as never))
      .rejects.toMatchObject({ code: "STRIGOI_FROZEN" });
    expect(q.put).not.toHaveBeenCalled();
  });

  it.each(["freeze", "grant-revoked"])("fences delayed submit verification after %s", async (change) => {
    const f = fixture(), press = vi.fn();
    const admission = f.admission.instruction(f.record);
    if (change === "freeze") await f.admission.freeze(identity);
    else f.state().activeBinding!.grant.capabilities = [];
    await expect(admitSubmitRetry({ instructionId: target, expectedTurn: 1, renderedAt: at,
      state: "rendered", messageHead: "hello", admission }, {
      epoch: () => 1, active: () => true, pending: () => true, press,
      observe: () => ({ activity: "awaiting-input", composer: { modalOpen: false, occupied: true, content: "hello" } }),
    })).resolves.toBe(false);
    expect(press).not.toHaveBeenCalled();
  });

});
