import { effectiveInstruction, WakeHeldError, type InstructionRecord, type InstructionAdmission } from "../domain/instruction.js";
import { AttentionError, AttentionWakeHeldError } from "../domain/orchestrator-attention.js";
import type { SessionRecord } from "../domain/session.js";
import type { InstructionLifecycleState } from "../domain/worker-truth.js";
import type { InstructionRepository, SessionInstructionPort } from "./session/session-ports.js";
import type { StrigoiAdmission } from "./strigoi-admission.js";

/** Broker-only routing policy. Provider preflight remains outside final authority. */
export interface InstructionRouting {
  key(sessionId: string): Promise<string>;
  prepare(record: InstructionRecord, persist: () => Promise<void>): Promise<{ effective: InstructionRecord; admission: InstructionAdmission } | undefined>;
}
export class InstructionDelivery {
  constructor(private readonly o: { registry: SessionInstructionPort; store: InstructionRepository;
    strigoi?: StrigoiAdmission | undefined; routing?: InstructionRouting | undefined;
    wakeAdmission?: ((record: InstructionRecord) => InstructionAdmission) | undefined;
    persistState(record: InstructionRecord, status: InstructionLifecycleState, fields: Partial<InstructionRecord>): Promise<InstructionRecord> }) {}
  async deliver(record: InstructionRecord): Promise<InstructionRecord> {
    if (record.launch === true) {
      let target: SessionRecord | undefined;
      try { target = this.o.registry.get(record.targetSessionId); } catch { /* Failed before catalog registration. */ }
      if (target === undefined || !["starting", "active"].includes(target.executionState)) {
        if (record.holdReason === "native-recovery-unavailable") return record;
        return this.o.persistState(record, "undelivered", { holdReason: "worker-terminal" });
      }
      if (target.initialInstructionId === record.id && target.pid > 0 && target.executionState === "active") {
        return this.o.persistState(record, "rendered", { renderedAt: target.updatedAt, expectedTurn: 1, holdReason: undefined });
      }
      return this.o.persistState(record, "queued", { holdReason: "provider-starting" });
    }
    if (record.deliveryAttemptAt !== undefined) return this.o.persistState(record, "queued", {
      holdReason: "delivery-outcome-unknown",
      holdDetail: "Delivery attempt has no durable outcome. Inspect this instruction ID in the worker transcript before retrying; text will not be resent automatically",
    });
    const source = record.brokerOwned === true
      ? "broker"
      : record.senderSessionId !== undefined && record.senderSessionId !== record.actorSessionId
        ? "worker"
        : "orchestrator";
    let delivery, attemptAt: string | undefined;
    try {
      if (record.wake?.attentionEpoch !== undefined && this.o.wakeAdmission === undefined) {
        throw new AttentionWakeHeldError("attention-admission-unavailable");
      }
      const wake = record.submissionKind === "wake" ? this.o.wakeAdmission?.(record) : undefined;
      const routed = await this.o.routing?.prepare(record, async () => this.o.store.put(record));
      const effective = routed?.effective ?? effectiveInstruction(record);
      // Resident routing owns its generation-specific submissionAttempt fence. Ordinary
      // workers use the queue attempt fence; neither may bypass the other's unknown outcome.
      if (routed === undefined) {
        let target: SessionRecord | undefined;
        try { target = this.o.registry.get(effective.targetSessionId); } catch { /* Normal refusal below. */ }
        if (target?.executionState === "cancelled" && target.attentionState === "interrupted") {
          return this.o.persistState(record, "queued", { holdReason: "worker-interrupted",
            holdDetail: "Broker recovery lost the process generation. Resume this same session to retry the retained instruction; no replacement or automatic restart is performed" });
        }
        attemptAt = new Date().toISOString();
        await this.o.persistState(record, record.status, { deliveryAttemptAt: attemptAt });
        record = { ...record, deliveryAttemptAt: undefined };
      }
      const resident = routed?.admission ?? this.o.strigoi?.instruction(effective);
      const admission: InstructionAdmission | undefined = resident === undefined ? wake
        : (apply) => resident(() => wake === undefined ? apply() : wake(apply));
      delivery = await this.o.registry.submitInstruction(effective.targetSessionId, record.message, source, {
        actorSessionId: effective.actorSessionId,
        senderSessionId: effective.senderSessionId ?? effective.actorSessionId,
        messageId: record.messageId,
        workflowRunId: record.workflowRunId ?? null,
        brokerOwned: record.brokerOwned === true,
        ...(record.submissionKind === undefined ? {} : { submissionKind: record.submissionKind }),
      }, record.id, ...(admission === undefined ? [] as const : [admission] as const));
    } catch (error) {
      if (error instanceof AttentionWakeHeldError) {
        return this.o.persistState(record, error.obsolete ? "cancelled" : "queued", { holdReason: error.holdReason });
      }
      if (record.wake?.attentionEpoch !== undefined && error instanceof AttentionError) {
        return this.o.persistState(record, "cancelled", { holdReason: error.code });
      }
      if (error instanceof WakeHeldError) {
        return this.o.persistState(record, "queued", { holdReason: error.holdReason });
      }
      const code = typeof error === "object" && error !== null && "code" in error
        ? error.code
        : undefined;
      if (typeof code === "string" && (code.startsWith("STRIGOI_") || code === "CAPABILITY_DENIED" || code === "ACTOR_NOT_AUTHORIZED" || code === "OWNERSHIP_LOST")) {
        return this.o.persistState(record, "queued", { holdReason: code });
      }
      if (code === "SESSION_BUSY") {
        return this.o.persistState(record, "queued", { holdReason: "human-controller" });
      }
      // The thread is gone, not busy. Rethrowing left the record `accepted`, and an `accepted`
      // record is both retried forever and deduplicated against the retry that would replace it.
      if (code === "SESSION_NOT_FOUND") {
        return this.o.persistState(record, "undelivered", { holdReason: "worker-terminal" });
      }
      if (code === "WORKER_BUDGET_EXHAUSTED") {
        return this.o.persistState(record, "undelivered", {
          holdReason: "worker-budget-exhausted",
        });
      }
      if (attemptAt === undefined) throw error;
      return this.o.persistState(record, "queued", { deliveryAttemptAt: attemptAt,
        holdReason: "delivery-outcome-unknown",
        holdDetail: "Delivery attempt failed with uncertain write outcome. Inspect the retained instruction ID and provider transcript before retrying; text will not be resent automatically" });
    }
    // `rendered` is the strongest thing an enqueue can honestly claim: the bytes are in the
    // provider's input surface. Whether the provider took them is observed later, or never.
    if (delivery.state === "undelivered") {
      return this.o.persistState(record, "undelivered", {
        holdDetail: delivery.detail,
        ...(delivery.hold === undefined ? {} : { holdReason: record.submissionKind === "wake" ? `wake-${delivery.hold}` : delivery.hold }),
      });
    }
    return delivery.state === "queued"
      ? this.o.persistState(record, "queued", { holdDetail: delivery.detail, ...(delivery.hold === undefined ? {} : { holdReason: record.submissionKind === "wake" ? `wake-${delivery.hold}` : delivery.hold }) })
      : this.o.persistState(record, "rendered", {
          holdReason: undefined,
          holdDetail: undefined,
          renderedAt: delivery.at,
          ...(delivery.expectedTurn === undefined ? {} : { expectedTurn: delivery.expectedTurn }),
        });
  }

}
