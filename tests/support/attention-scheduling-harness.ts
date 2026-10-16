import { InstructionRecordSchema, type InstructionAdmission, type InstructionRecord } from "../../src/domain/instruction.js";
import { OrchestratorAttentionScheduling, type AttentionSchedulingOptions } from "../../src/broker/orchestrator-attention-scheduling.js";
import { InstructionQueue } from "../../src/orchestration/instruction-queue.js";
import { observeInstructionRepository } from "../../src/orchestration/observed-instruction-repository.js";
import type { InstructionDelivery, SessionInstructionPort } from "../../src/orchestration/session/session-ports.js";
import { InstructionStore } from "../../src/persistence/instruction-store.js";
import { ACTOR, attentionHarness, cleanupAttentionHarnesses } from "./attention-harness.js";

const schedulers: OrchestratorAttentionScheduling[] = [];
export async function cleanupSchedulingHarnesses(): Promise<void> {
  for (const scheduler of schedulers.splice(0)) { scheduler.stop(); await scheduler.flush(); }
  await cleanupAttentionHarnesses();
}

export async function schedulingHarness(decide?: AttentionSchedulingOptions["decide"]) {
  const f = await attentionHarness();
  await f.inbox.setPolicy(f.controller.controllerId, { ...f.inbox.policy(f.controller.controllerId), coalesceMs: 60_000 });
  const writes: string[] = [];
  const errors: unknown[] = [];
  let hold: InstructionDelivery["hold"];
  let beforeAdmission: (() => Promise<void>) | undefined;
  let scheduler: OrchestratorAttentionScheduling;
  const registry: SessionInstructionPort = {
    ...f.registry,
    onControllerReleased: () => () => {}, onDeliveryBoundary: () => () => {}, onInstructionState: () => () => {},
    async submitInstruction(id, message, _source, _metadata, _instructionId, admission?: InstructionAdmission) {
      const at = new Date().toISOString();
      if (hold !== undefined) return { state: "queued", hold, at };
      if (f.registry.workerTruth(id).state === "working") return { state: "queued", hold: "provider-busy", at };
      await beforeAdmission?.();
      const render = () => { writes.push(message); return { state: "rendered" as const, expectedTurn: 1, at }; };
      return admission === undefined ? render() : admission(render);
    },
  };
  const instructionStore = new InstructionStore(f.directory);
  const observed = observeInstructionRepository(instructionStore, (record) => scheduler?.observeInstruction(record));
  const queue = new InstructionQueue(registry, f.controlOptions.bindings, observed, (record) => (apply) => f.attention.admitWake(record, apply));
  const options: AttentionSchedulingOptions = { attention: f.attention, inbox: f.inbox, registry: f.registry, instructions: queue,
    onError: (error) => errors.push(error), ...(decide === undefined ? {} : { decide }) };
  const makeScheduler = (overrides: Partial<AttentionSchedulingOptions> = {}) => {
    const next = new OrchestratorAttentionScheduling({ ...options, ...overrides }); schedulers.push(next); return next;
  };
  scheduler = makeScheduler(); await scheduler.start();
  f.emit(ACTOR, { state: "idle" });
  return { ...f, scheduler, makeScheduler, options, queue, instructionStore, writes, errors,
    setHold(value: typeof hold) { hold = value; },
    beforeAdmission(value: typeof beforeAdmission) { beforeAdmission = value; },
    async drain() { await f.attention.flush(); await scheduler.flush(); },
    async lifecycle(status: InstructionRecord["status"]) {
      const record = (await queue.list(ACTOR)).at(-1)!;
      const at = new Date().toISOString();
      await observed.put(InstructionRecordSchema.parse({ ...record, status, updatedAt: at,
        ...(["submitted", "acknowledged", "completed"].includes(status) ? { submittedAt: at } : {}),
        ...(status === "completed" ? { completedAt: at } : {}) }));
      await scheduler.flush();
    },
  };
}
