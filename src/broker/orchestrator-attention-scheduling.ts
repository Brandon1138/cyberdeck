import type { InstructionRecord } from "../domain/instruction.js";
import type { OrchestratorAttention } from "../domain/orchestrator-attention.js";
import { stableUuid } from "../domain/stable-uuid.js";
import type { WorkerTruth } from "../domain/worker-truth.js";
import type { OrchestratorAttentionControlPlane } from "../orchestration/orchestrator-attention-control.js";
import {
  attentionInputId, attentionLivenessFloor, coverageContains, groupWaitDecision,
  type AttentionDecision, type AttentionDecisionInput,
} from "../orchestration/orchestrator-attention-policy.js";
import type { InstructionQueue } from "../orchestration/instruction-queue.js";
import type { NotificationInboxPort } from "../orchestration/orchestrator-notification-ports.js";

export interface AttentionSchedulingOptions {
  attention: OrchestratorAttentionControlPlane;
  instructions: Pick<InstructionQueue, "enqueueBroker" | "withdraw" | "list" | "flush">;
  inbox: NotificationInboxPort;
  registry: { workerTruth(sessionId: string): WorkerTruth };
  /** Slice 2 uses deterministic local fixtures only; no network/model adapter exists here. */
  decide?: (input: AttentionDecisionInput) => AttentionDecision | Promise<AttentionDecision>;
  now?: () => number;
  onError?: (error: unknown) => void;
}

/** Policy and durable intent reconciliation. All delivery uses the existing instruction queue. */
export class OrchestratorAttentionScheduling {
  private readonly coalescing = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly deadlines = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly dirty = new Set<string>();
  private unsubscribe?: () => void;
  private started = false;
  private generation = 0;
  private readonly instructionStates = new Map<string, string>();
  constructor(private readonly options: AttentionSchedulingOptions) {}
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private stamp(): string { return new Date(this.now()).toISOString(); }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.generation += 1;
    const attention = this.options.attention.onChange((id) => this.changed(id));
    const inbox = this.options.inbox.onChange((id) => this.changed(id));
    this.unsubscribe = () => { attention(); inbox(); };
    try {
      for (const record of await this.options.attention.schedulingRecords()) await this.reconcile(record.controllerId);
    } catch (error) { this.stop(); throw error; }
  }

  stop(): void {
    this.started = false;
    this.generation += 1;
    this.unsubscribe?.();
    for (const timer of [...this.coalescing.values(), ...this.deadlines.values()]) clearTimeout(timer);
    this.coalescing.clear(); this.deadlines.clear(); this.dirty.clear();
  }

  async manages(controllerId: string): Promise<boolean> {
    // A cancellation tombstone remains opted into explicit-wait semantics; idle cannot re-arm it.
    return await this.options.attention.schedulingRecord(controllerId) !== undefined;
  }

  changed(controllerId: string): void {
    if (!this.started) return;
    this.dirty.add(controllerId);
    if (this.coalescing.has(controllerId) || this.running.has(controllerId)) return;
    const generation = this.generation;
    const timer = setTimeout(() => {
      this.coalescing.delete(controllerId);
      if (this.started && generation === this.generation) this.background(controllerId);
    }, this.options.inbox.policy(controllerId).coalesceMs);
    timer.unref(); this.coalescing.set(controllerId, timer);
  }

  observeInstruction(record: InstructionRecord): void {
    if (record.wake?.attentionEpoch === undefined) return;
    const state = JSON.stringify([record.status, record.holdReason, record.expectedTurn, record.renderedAt, record.submittedAt, record.completedAt]);
    if (this.instructionStates.get(record.id) === state) return;
    this.instructionStates.set(record.id, state);
    if (this.instructionStates.size > 4_096) this.instructionStates.delete(this.instructionStates.keys().next().value!);
    this.changed(record.wake.controllerId);
  }

  async flush(): Promise<void> {
    for (const [id, timer] of this.coalescing) { clearTimeout(timer); this.coalescing.delete(id); this.background(id); }
    while (this.running.size > 0) await Promise.all(this.running.values());
  }

  private background(controllerId: string): void {
    void this.reconcile(controllerId).catch((error: unknown) => {
      if (this.options.onError !== undefined) this.options.onError(error);
      else process.emitWarning("Attention scheduling held; durable obligations remain pending", { code: "ATTENTION_SCHEDULING_FAILED" });
    });
  }

  reconcile(controllerId: string): Promise<void> {
    const prior = this.running.get(controllerId);
    if (prior !== undefined) { this.dirty.add(controllerId); return prior; }
    const task = Promise.resolve().then(async () => {
      do {
        this.dirty.delete(controllerId);
        if (this.started) await this.tick(controllerId);
      } while (this.started && this.dirty.has(controllerId));
    }).finally(() => this.running.delete(controllerId));
    this.running.set(controllerId, task);
    return task;
  }

  private deadline(record: OrchestratorAttention, at?: number): void {
    const previous = this.deadlines.get(record.controllerId);
    if (previous !== undefined) clearTimeout(previous);
    this.deadlines.delete(record.controllerId);
    const target = at ?? (record.status === "armed" && record.reviewNotifiedAt === undefined && record.statement.reviewAt !== undefined
      ? Date.parse(record.statement.reviewAt) : undefined);
    if (!this.started || target === undefined || target <= this.now()) return;
    const generation = this.generation;
    const timer = setTimeout(() => {
      this.deadlines.delete(record.controllerId);
      if (this.started && generation === this.generation) this.background(record.controllerId);
    }, Math.min(target - this.now(), 2_147_483_647));
    timer.unref(); this.deadlines.set(record.controllerId, timer);
  }

  private async tick(controllerId: string): Promise<void> {
    const generation = this.generation;
    let record = await this.options.attention.reconcile(controllerId, undefined, false);
    if (record === undefined) return;
    this.deadline(record);
    // Withdraw only unrendered attention/legacy wakes. Ordinary instructions are never touched.
    const instructions = await this.options.instructions.list(record.actorSessionId);
    for (const instruction of instructions) if (instruction.wake?.controllerId === controllerId
      && ["accepted", "queued"].includes(instruction.status)
      && (record.status !== "armed" || instruction.wake.attentionEpoch !== record.epoch
        || instruction.messageId !== record.pendingIntent?.messageId)) {
      await this.options.instructions.withdraw(record.actorSessionId, instruction.messageId);
    }
    if (record.status !== "armed" || !this.started) return;

    if (record.pendingIntent !== undefined) {
      const intent = record.pendingIntent;
      const receipt = record.consumption;
      if (receipt !== undefined
        && coverageContains(record.coverage.consumed, intent.coverage, receipt.sequence <= (intent.readSequenceFloor ?? 0))) {
        await this.options.instructions.withdraw(record.actorSessionId, intent.messageId);
        record = await this.options.attention.schedulingUpdate(controllerId, (current) => {
          if (current.pendingIntent?.messageId !== intent.messageId) return current;
          const { pendingIntent: _intent, ...rest } = current;
          return { ...rest, updatedAt: this.stamp(),
            ...(current.statement.reviewAt !== undefined && Date.parse(receipt.at) >= Date.parse(current.statement.reviewAt)
              ? { reviewNotifiedAt: receipt.at } : {}),
            ...(current.lastWake === undefined ? {} : { lastWake: { ...current.lastWake, consumedAt: receipt.at } }) };
        });
        if (record?.status !== "armed") return;
      } else {
        if (record.recovery !== "ready") { await this.hold(record, "attention-missing-process"); return; }
        let instruction = instructions.find((entry) => entry.messageId === intent.messageId);
        if (instruction === undefined) instruction = await this.enqueue(record);
        else if (["accepted", "queued"].includes(instruction.status)) {
          await this.options.instructions.flush(record.actorSessionId);
          instruction = (await this.options.instructions.list(record.actorSessionId)).find((entry) => entry.messageId === intent.messageId);
        }
        if (instruction !== undefined) await this.observe(record, instruction);
        return;
      }
    }

    // Continue recording attributed progress/dormancy after explicit consumption cleared the slot.
    if (record.lastWake !== undefined) {
      const previous = instructions.find((entry) => entry.messageId === record!.lastWake!.messageId);
      if (previous !== undefined) await this.observe(record, previous);
    }
    const snapshot = await this.options.attention.schedulingSnapshot(controllerId);
    if (snapshot === undefined || !this.started) return;
    const input: AttentionDecisionInput = { ...snapshot, now: this.stamp() };
    const inputId = attentionInputId(input.record, input.now);
    if (input.record.decision?.inputId === inputId) return;
    let decision = attentionLivenessFloor(input);
    if (decision === undefined) {
      if (coverageContains(input.record.coverage.consumed, input.record.coverage.captured)) {
        decision = { outcome: "DO_NOT_WAKE", reason: "sources-consumed" };
      } else for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const answer = await (this.options.decide ?? groupWaitDecision)(input);
          if (!["WAKE", "DO_NOT_WAKE", "FALLBACK_WAKE"].includes(answer.outcome)
            || typeof answer.reason !== "string" || answer.reason.length === 0 || answer.reason.length > 128) throw new Error("Invalid decision fixture");
          decision = answer; break;
        } catch { /* Two local attempts, then deterministic fail-open attention; never consume sources. */ }
      }
    }
    decision ??= { outcome: "FALLBACK_WAKE", reason: "decision-unavailable" };
    const chosen = decision;
    const banked = await this.options.attention.schedulingUpdate(controllerId, (current) => {
      if (!this.started || generation !== this.generation || current.epoch !== input.record.epoch
        || current.pendingIntent !== undefined || attentionInputId(current, this.stamp()) !== inputId) return current;
      const at = this.stamp();
      const next = { ...current, updatedAt: at, coverage: { ...current.coverage, evaluated: current.coverage.captured },
        decision: { snapshotId: current.snapshotId, inputId, outcome: chosen.outcome, reason: chosen.reason, coverage: current.coverage.captured, at } };
      if (chosen.outcome === "DO_NOT_WAKE") return next;
      const messageId = stableUuid(`attention:${controllerId}:${current.epoch}:${inputId}`);
      return { ...next,
        ...(chosen.reason === "review-deadline" ? { reviewNotifiedAt: at } : {}),
        pendingIntent: { epoch: current.epoch, messageId, coverage: current.coverage.captured, createdAt: at, readSequenceFloor: current.readSequence },
        lastWake: { epoch: current.epoch, messageId, intendedAt: at } };
    });
    if (banked?.status !== "armed" || banked.pendingIntent === undefined || !this.started) return;
    if (banked.recovery !== "ready") { await this.hold(banked, "attention-missing-process"); return; }
    const instruction = await this.enqueue(banked);
    if (instruction !== undefined) await this.observe(banked, instruction);
  }

  private async hold(record: OrchestratorAttention, reason: string): Promise<void> {
    await this.options.attention.schedulingUpdate(record.controllerId, (current) => current.lastWake?.messageId !== record.pendingIntent?.messageId
      ? current : { ...current, lastWake: { ...current.lastWake!, holdReason: reason } });
  }

  private async enqueue(record: OrchestratorAttention): Promise<InstructionRecord | undefined> {
    const intent = record.pendingIntent!;
    const policy = this.options.inbox.policy(record.controllerId);
    if (policy.wake === "off") { await this.hold(record, "notification-wake-off"); return; }
    // Count the existing durable queue rather than resetting the attention allowance on restart.
    const recent = (await this.options.instructions.list(record.actorSessionId)).filter((entry) => entry.submissionKind === "wake"
      && entry.wake?.controllerId === record.controllerId && Date.parse(entry.createdAt) > this.now() - 3_600_000)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (recent.length >= policy.maxWakesPerHour) {
      await this.hold(record, "notification-wake-budget");
      if (policy.maxWakesPerHour > 0) this.deadline(record, Date.parse(recent[recent.length - policy.maxWakesPerHour]!.createdAt) + 3_600_000);
      return;
    }
    const notificationIds = this.options.inbox.listPending(record.controllerId, 0, 50).map((notification) => notification.id);
    return this.options.instructions.enqueueBroker({ actorSessionId: record.actorSessionId, targetSessionId: record.actorSessionId,
      messageId: intent.messageId, submissionKind: "wake", wake: { controllerId: record.controllerId,
        attentionEpoch: record.epoch, cursor: this.options.inbox.headCursor(record.controllerId), notificationIds },
      message: `[cyberdeck attention] Wait epoch ${record.epoch} has outstanding developments. Read cyberdeck_notifications_read with attentionEpoch="${record.epoch}". ${record.statement.nextAction}. Acknowledge only the exact attentionReceiptId you actually process, then explicitly re-arm when waiting again.` });
  }

  private async observe(record: OrchestratorAttention, instruction: InstructionRecord): Promise<void> {
    await this.options.attention.schedulingUpdate(record.controllerId, (current) => {
      if (current.lastWake?.messageId !== instruction.messageId) return current;
      const intent = current.pendingIntent?.messageId === instruction.messageId ? current.pendingIntent : undefined;
      const { holdReason: _hold, ...prior } = current.lastWake;
      const reached = ["submitted", "acknowledged", "completed"].includes(instruction.status);
      const initiated = ["acknowledged", "completed"].includes(instruction.status);
      const actorTruth = this.options.registry.workerTruth(current.actorSessionId);
      const evidence = { ...prior, instructionId: instruction.id, scheduledAt: instruction.createdAt,
        ...(instruction.renderedAt === undefined ? {} : { renderedAt: instruction.renderedAt }),
        ...(instruction.submittedAt === undefined ? {} : { submittedAt: instruction.submittedAt }),
        ...(instruction.expectedTurn === undefined ? {} : { expectedTurn: instruction.expectedTurn }),
        ...(initiated ? { initiatedAt: prior.initiatedAt ?? instruction.updatedAt } : {}),
        ...(instruction.status === "completed" ? { progressAt: prior.progressAt ?? instruction.completedAt ?? instruction.updatedAt } : {}),
        ...(instruction.holdReason === undefined ? {} : { holdReason: instruction.holdReason }) };
      if (!reached && actorTruth.terminal) evidence.holdReason = `attention-provider-${actorTruth.state}`;
      if (evidence.consumedAt !== undefined && evidence.progressAt !== undefined
        && actorTruth.state === "idle") evidence.dormantAt ??= this.stamp();
      return { ...current, lastWake: evidence,
        ...(intent === undefined ? {} : { pendingIntent: { ...intent, instructionId: instruction.id },
          coverage: { ...current.coverage, scheduled: intent.coverage,
            ...(instruction.renderedAt === undefined ? {} : { rendered: intent.coverage, noticed: intent.coverage }),
            ...(reached ? { submitted: intent.coverage } : {}), ...(initiated ? { initiated: intent.coverage } : {}) } }) };
    });
  }
}
