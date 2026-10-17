import { randomUUID } from "node:crypto";
import { z } from "zod";
import { grantAllows } from "../domain/capability.js";
import { InstructionRecordSchema, WakeContextSchema, WakeHeldError, type InstructionRecord, type InstructionAdmission } from "../domain/instruction.js";
import { AttentionError, AttentionWakeHeldError } from "../domain/orchestrator-attention.js";
import { instructionReachedProvider, type InstructionLifecycleState } from "../domain/worker-truth.js";
import type { SessionRecord } from "../domain/session.js";
import type {
  InstructionRepository,
  InstructionStateUpdate,
  OrchestratorBindingReader,
  SessionInstructionPort,
} from "./session/session-ports.js";

/** Every receipt writer shares the same monotonic lifecycle, including recovery-only holds. */
function instructionProgress(current: InstructionLifecycleState, next: InstructionLifecycleState): InstructionLifecycleState {
  const progress = ["accepted", "queued", "rendered", "submitted", "acknowledged", "completed"];
  return ["completed", "undelivered", "cancelled"].includes(current)
    || progress.indexOf(next) >= 0 && progress.indexOf(next) < progress.indexOf(current) ? current : next;
}

export const EnqueueInstructionParamsSchema = z.object({
  actorSessionId: z.uuid(),
  targetSessionId: z.uuid(),
  senderSessionId: z.uuid().optional(),
  message: z.string().trim().min(1),
  workflowRunId: z.uuid().optional(),
  messageId: z.uuid().optional(),
  causationId: z.uuid().optional(),
  hop: z.number().int().nonnegative().default(0),
});

/** Internal-only policy instruction. No broker RPC routes to this schema. */
export const EnqueueBrokerInstructionParamsSchema = z.object({
  actorSessionId: z.uuid(),
  targetSessionId: z.uuid(),
  message: z.string().trim().min(1),
  messageId: z.uuid(),
  submissionKind: z.literal("wake").optional(),
  wake: WakeContextSchema.optional(),
}).refine((request) => (request.submissionKind === "wake") === (request.wake !== undefined), {
  message: "Wake submissions require durable notification context",
}).refine((request) => request.submissionKind !== "wake" || request.actorSessionId === request.targetSessionId, {
  message: "A broker wake must target its own orchestrator",
});

export class InstructionQueue {
  private subscriptions: Array<() => void> = [];
  /**
   * One writer per target at a time.
   *
   * A boundary observation and a lifecycle observation can arrive from the same PTY frame, and both
   * want to act. Without this, two of them read the same record before either has written, and the
   * later write silently discards the earlier one — a payload delivered twice, or a `submittedAt`
   * that never appears because `acknowledged` was computed from a pre-submission read.
   */
  private readonly writers = new Map<string, Promise<unknown>>();

  constructor(
    private readonly registry: SessionInstructionPort,
    private readonly orchestrators: OrchestratorBindingReader,
    private readonly store: InstructionRepository,
    private readonly wakeAdmission?: (record: InstructionRecord) => InstructionAdmission,
  ) {}

  start(): void {
    if (this.subscriptions.length > 0) return;
    this.subscriptions = [
      this.registry.onControllerReleased((sessionId) => {
        void this.flush(sessionId);
      }),
      // A held instruction is only held because the boundary was unsafe. When the worker leaves the
      // modal or empties its composer, that is the moment to try again — nothing else will.
      this.registry.onDeliveryBoundary((sessionId) => {
        void this.flush(sessionId);
      }),
      this.registry.onInstructionState((update) => {
        void this.applyState(update);
      }),
    ];
  }

  stop(): void {
    for (const unsubscribe of this.subscriptions) unsubscribe();
    this.subscriptions = [];
  }

  /** Persist the first instruction during activation, before the target is in the live catalog. */
  async prepareLaunch(input: {
    actorSessionId: string;
    target: SessionRecord;
    message: string;
    instructionId: string;
    native?: boolean;
  }): Promise<InstructionRecord> {
    const request = EnqueueInstructionParamsSchema.parse({
      actorSessionId: input.actorSessionId, targetSessionId: input.target.id,
      message: input.message, messageId: input.instructionId,
    });
    const binding = await this.orchestrators.findBySessionId(request.actorSessionId);
    if (binding === undefined) throw Object.assign(new Error("Actor is not a bound orchestrator"), { code: "ACTOR_NOT_AUTHORIZED" });
    if (!grantAllows(binding.grant, "thread.enqueue", input.target)) {
      throw Object.assign(new Error("Target thread is outside this orchestrator's enqueue grant"), { code: "CAPABILITY_DENIED" });
    }
    return this.serialize(input.target.id, async () => {
      const existing = (await this.store.list(input.target.id)).find((record) => record.messageId === request.messageId);
      if (existing !== undefined) return existing;
      const at = new Date().toISOString();
      const record = InstructionRecordSchema.parse({
        id: input.instructionId, actorSessionId: request.actorSessionId,
        targetSessionId: input.target.id, message: request.message, messageId: request.messageId,
        status: "accepted", createdAt: at, updatedAt: at,
        ...(input.native === false ? { launch: false } : { expectedTurn: 1, launch: true }),
      });
      await this.store.put(record);
      return record;
    });
  }

  /**
   * Account for a startup brief after restart without ever resending its prompt. A native launch
   * receipt (Claude, Codex) settles from the provider's own transcript. A non-native one (Cursor)
   * was persisted before the spawn and is flushed only after the create returns, so a broker that
   * exits in between leaves it `accepted` with no later boundary obliged to deliver it: recovery
   * delivers it to a live target or retires it as undelivered.
   */
  async recoverLaunchInstructions(readCanonicalTurns: (sessionId: string) => Promise<number | { canonicalTurns: number; cancelled?: boolean | undefined; pending?: string | undefined }>): Promise<void> {
    for (const record of await this.store.list()) {
      if (record.launch === undefined || ["completed", "undelivered", "cancelled"].includes(record.status)) continue;
      await this.serialize(record.targetSessionId, async () => {
        const current = (await this.store.list(record.targetSessionId)).find(({ id }) => id === record.id)!;
        if (["completed", "undelivered", "cancelled"].includes(current.status)) return;
        if (record.launch === true) {
          const recovery = await readCanonicalTurns(record.targetSessionId);
          const canonicalTurns = typeof recovery === "number" ? recovery : recovery.canonicalTurns;
          if (typeof recovery !== "number" && recovery.cancelled === true) {
            await this.persistState(current, "cancelled", { holdReason: undefined });
            return;
          }
          if (canonicalTurns >= (record.expectedTurn ?? 1)) {
            const at = new Date().toISOString();
            await this.persistState(current, "completed", { submittedAt: current.submittedAt ?? at, completedAt: at, holdReason: undefined });
            return;
          }
          if (typeof recovery !== "number" && recovery.pending !== undefined) {
            await this.persistState(current, "queued", { holdReason: "native-recovery-unavailable" });
            return;
          }
        }
        let target: SessionRecord | undefined;
        try { target = this.registry.get(record.targetSessionId); } catch { /* Missing launch attempt. */ }
        if (target === undefined || !["starting", "active"].includes(target.executionState)) {
          await this.persistState(current, "undelivered", { holdReason: "worker-terminal" });
        } else if (current.status === "accepted" || current.status === "queued") {
          await this.tryDeliver(current);
        }
      });
    }
  }

  async enqueue(input: z.input<typeof EnqueueInstructionParamsSchema>): Promise<InstructionRecord> {
    const request = EnqueueInstructionParamsSchema.parse(input);
    const binding = await this.orchestrators.findBySessionId(request.actorSessionId);
    if (binding === undefined) throw Object.assign(new Error("Actor is not a bound orchestrator"), { code: "ACTOR_NOT_AUTHORIZED" });
    const target = this.registry.get(request.targetSessionId);
    if (!grantAllows(binding.grant, "thread.enqueue", target)) {
      throw Object.assign(new Error("Target thread is outside this orchestrator's enqueue grant"), { code: "CAPABILITY_DENIED" });
    }
    const existing = await this.store.list(request.targetSessionId);
    const messageId = request.messageId ?? randomUUID();
    const duplicate = existing.find((record) => record.messageId === messageId);
    if (duplicate !== undefined) return duplicate;
    const now = new Date().toISOString();
    const record = InstructionRecordSchema.parse({
      id: randomUUID(),
      actorSessionId: request.actorSessionId,
      ...(request.senderSessionId === undefined ? {} : { senderSessionId: request.senderSessionId }),
      targetSessionId: request.targetSessionId,
      message: request.message,
      // The broker has the instruction and nothing more has happened to it yet. `queued` below means
      // something stronger and narrower: the broker tried to deliver and the boundary was unsafe.
      status: "accepted",
      createdAt: now,
      updatedAt: now,
      ...(request.workflowRunId === undefined ? {} : { workflowRunId: request.workflowRunId }),
      messageId,
      ...(request.causationId === undefined ? {} : { causationId: request.causationId }),
      hop: request.hop,
    });
    await this.store.put(record);
    // Delivered through the same serialized flush as everything else: an instruction written while
    // an older one is still held would arrive out of order, and two composers' worth of text in one
    // input surface is one corrupted payload.
    await this.flush(record.targetSessionId);
    return (await this.store.list(record.targetSessionId)).find(({ id }) => id === record.id) ?? record;
  }

  /**
   * Persist one broker-owned policy instruction through the same FIFO/delivery truth path.
   *
   * Authorization comes from broker composition, not an orchestrator lease. Deterministic
   * `messageId` makes a restart retry idempotent after policy state was persisted but before the
   * worker consumed the wrap-up nudge.
   */
  async enqueueBroker(
    input: z.input<typeof EnqueueBrokerInstructionParamsSchema>,
  ): Promise<InstructionRecord> {
    const request = EnqueueBrokerInstructionParamsSchema.parse(input);
    this.registry.get(request.targetSessionId);
    let wasCreated = false;
    const record = await this.serialize(request.targetSessionId, async () => {
      const existing = await this.store.list(request.targetSessionId);
      const duplicate = existing.find((entry) => entry.messageId === request.messageId);
      if (duplicate !== undefined) return duplicate;
      const now = new Date().toISOString();
      const created = InstructionRecordSchema.parse({
        id: randomUUID(), actorSessionId: request.actorSessionId, targetSessionId: request.targetSessionId,
        message: request.message, status: "accepted", createdAt: now, updatedAt: now,
        messageId: request.messageId, hop: 0, brokerOwned: true,
        ...(request.submissionKind === undefined ? {} : { submissionKind: request.submissionKind, wake: request.wake }),
      });
      await this.store.put(created);
      wasCreated = true;
      return created;
    });
    // Preserve ordinary broker-policy retries; only wake duplicates actively retry a hold.
    if (!wasCreated && record.submissionKind !== "wake") return record;
    if (!["accepted", "queued"].includes(record.status)) return record;
    await this.flush(record.targetSessionId);
    return (await this.store.list(record.targetSessionId)).find(({ id }) => id === record.id) ?? record;
  }

  flush(targetSessionId: string, verifyMessageId?: string): Promise<InstructionRecord[]> {
    return this.serialize(targetSessionId, async () => {
      const records = await this.store.list(targetSessionId);
      const rendered = records.find((record) => record.messageId === verifyMessageId && record.status === "rendered"
        && record.brokerOwned === true && record.wake?.attentionEpoch !== undefined);
      if (rendered !== undefined) this.registry.verifyInstructionSubmission?.(targetSessionId, rendered.id);
      const pending = records
        .filter((record) => record.status === "accepted" || record.status === "queued");
      const results: InstructionRecord[] = [];
      for (const [index, record] of pending.entries()) {
        const attempted = await this.tryDeliver(record);
        results.push(attempted);
        // Ordinary instructions preserve FIFO. A human-controller hold is the sole exception:
        // the distinct wake channel may pass it, using its own turn/composer/operator gate.
        // Everything else behind this head receives an explicit hold instead of staying accepted.
        if (instructionReachedProvider(attempted.status)) continue;
        // A terminal worker holds nothing back: the next record hits the same dead session and
        // resolves itself the same way, each with its own honest terminal state.
        if (attempted.status === "undelivered" || attempted.status === "cancelled") continue;
        const holdReason = attempted.status === "rendered"
          ? "composer-occupied"
          : attempted.holdReason ?? "composer-occupied";
        for (const behind of pending.slice(index + 1)) {
          if (behind.submissionKind === "wake" && holdReason === "human-controller") {
            results.push(await this.tryDeliver(behind));
          } else {
            results.push(await this.persistState(behind, "queued", {
              holdReason: behind.submissionKind === "wake" && !holdReason.startsWith("wake-") ? `wake-${holdReason}` : holdReason,
            }));
          }
        }
        break;
      }
      return results;
    });
  }

  private serialize<T>(targetSessionId: string, work: () => Promise<T>): Promise<T> {
    const next = (this.writers.get(targetSessionId) ?? Promise.resolve())
      .catch(() => undefined)
      .then(work);
    this.writers.set(targetSessionId, next);
    return next.finally(() => {
      if (this.writers.get(targetSessionId) === next) this.writers.delete(targetSessionId);
    });
  }

  list(targetSessionId?: string): Promise<InstructionRecord[]> {
    return this.store.list(targetSessionId);
  }

  /**
   * Withdraw one instruction that the provider has not been shown yet.
   *
   * `docs/architecture/worker-truth.md` allows `accepted|queued --withdrawn--> cancelled` and
   * nothing else: a rendered payload is bytes in a composer and cannot be unwritten. The broker's
   * notification wake uses this when the orchestrator started a turn on its own before the wake
   * was written, so the same notice never arrives twice. Any other state is returned unchanged.
   */
  withdraw(targetSessionId: string, messageId: string): Promise<InstructionRecord | undefined> {
    return this.serialize(targetSessionId, async () => {
      const record = (await this.store.list(targetSessionId))
        .find((candidate) => candidate.messageId === messageId);
      if (record === undefined) return undefined;
      if (record.status !== "accepted" && record.status !== "queued") return record;
      return this.persistState(record, "cancelled", {});
    });
  }

  /**
   * Carry a broker-observed lifecycle step onto the durable record.
   *
   * The broker is the only thing that can see submission and completion, and it reports them long
   * after `enqueue` returned. Writing them here is what makes `thread_read` able to walk an
   * instruction from accepted through to the turn that answered it with no gap in between.
   */
  private async applyState(update: InstructionStateUpdate): Promise<void> {
    await this.serialize(update.sessionId, async () => {
      const record = (await this.store.list(update.sessionId)).find(({ id }) => id === update.instructionId);
      // Recovered runtimes can emit stale generation-local observations. Durable terminal
      // receipts never regress, including when that old runtime later stops or resumes.
      if (record === undefined || record.status === update.state
        || ["completed", "undelivered", "cancelled"].includes(record.status)) return;
      if (instructionProgress(record.status, update.state) !== update.state) return;
      await this.store.put(InstructionRecordSchema.parse({
        ...record,
        status: update.state,
        updatedAt: update.at,
        // A provider can be seen to have taken the payload only once, and the broker may report that
        // as `acknowledged` or straight through to `completed` if the turn was faster than a poll.
        // The stamp is about the fact, not about which frame carried the news.
        ...(update.state === "rendered" ? { renderedAt: record.renderedAt ?? update.at, holdReason: undefined } : {}),
        ...(record.submittedAt === undefined && instructionReachedProvider(update.state)
          ? { submittedAt: update.at }
          : {}),
        ...(update.state === "completed" ? { completedAt: update.at } : {}),
      }));
    });
    // The composer this instruction was occupying is now empty, which is the boundary the next
    // instruction in line has been waiting for. Nothing else notices: the broker only announces a
    // boundary for a hold it knows about, and a queue entry behind a rendered one is not held.
    if (instructionReachedProvider(update.state)) await this.flush(update.sessionId);
  }

  private async tryDeliver(record: InstructionRecord): Promise<InstructionRecord> {
    if (record.launch === true) {
      let target: SessionRecord | undefined;
      try { target = this.registry.get(record.targetSessionId); } catch { /* Failed before catalog registration. */ }
      if (target === undefined || !["starting", "active"].includes(target.executionState)) {
        if (record.holdReason === "native-recovery-unavailable") return record;
        return this.persistState(record, "undelivered", { holdReason: "worker-terminal" });
      }
      if (target.initialInstructionId === record.id && target.pid > 0 && target.executionState === "active") {
        return this.persistState(record, "rendered", { renderedAt: target.updatedAt, expectedTurn: 1, holdReason: undefined });
      }
      return this.persistState(record, "queued", { holdReason: "provider-starting" });
    }
    const source = record.brokerOwned === true
      ? "broker"
      : record.senderSessionId !== undefined && record.senderSessionId !== record.actorSessionId
        ? "worker"
        : "orchestrator";
    let delivery;
    try {
      if (record.wake?.attentionEpoch !== undefined && this.wakeAdmission === undefined) {
        throw new AttentionWakeHeldError("attention-admission-unavailable");
      }
      const admission = record.submissionKind === "wake" ? this.wakeAdmission?.(record) : undefined;
      delivery = await this.registry.submitInstruction(record.targetSessionId, record.message, source, {
        actorSessionId: record.actorSessionId,
        senderSessionId: record.senderSessionId ?? record.actorSessionId,
        messageId: record.messageId,
        workflowRunId: record.workflowRunId ?? null,
        brokerOwned: record.brokerOwned === true,
        ...(record.submissionKind === undefined ? {} : { submissionKind: record.submissionKind }),
      }, record.id, ...(admission === undefined ? [] as const : [admission] as const));
    } catch (error) {
      if (error instanceof AttentionWakeHeldError) {
        return this.persistState(record, error.obsolete ? "cancelled" : "queued", { holdReason: error.holdReason });
      }
      if (record.wake?.attentionEpoch !== undefined && error instanceof AttentionError) {
        return this.persistState(record, "cancelled", { holdReason: error.code });
      }
      if (error instanceof WakeHeldError) {
        return this.persistState(record, "queued", { holdReason: error.holdReason });
      }
      const code = typeof error === "object" && error !== null && "code" in error
        ? error.code
        : undefined;
      if (code === "SESSION_BUSY") {
        return this.persistState(record, "queued", { holdReason: "human-controller" });
      }
      // The thread is gone, not busy. Rethrowing left the record `accepted`, and an `accepted`
      // record is both retried forever and deduplicated against the retry that would replace it.
      if (code === "SESSION_NOT_FOUND") {
        return this.persistState(record, "undelivered", { holdReason: "worker-terminal" });
      }
      if (code === "WORKER_BUDGET_EXHAUSTED") {
        return this.persistState(record, "undelivered", {
          holdReason: "worker-budget-exhausted",
        });
      }
      throw error;
    }
    // `rendered` is the strongest thing an enqueue can honestly claim: the bytes are in the
    // provider's input surface. Whether the provider took them is observed later, or never.
    if (delivery.state === "undelivered") {
      return this.persistState(record, "undelivered", {
        ...(delivery.hold === undefined ? {} : { holdReason: record.submissionKind === "wake" ? `wake-${delivery.hold}` : delivery.hold }),
      });
    }
    return delivery.state === "queued"
      ? this.persistState(record, "queued", { ...(delivery.hold === undefined ? {} : { holdReason: record.submissionKind === "wake" ? `wake-${delivery.hold}` : delivery.hold }) })
      : this.persistState(record, "rendered", {
          holdReason: undefined,
          renderedAt: delivery.at,
          ...(delivery.expectedTurn === undefined ? {} : { expectedTurn: delivery.expectedTurn }),
        });
  }

  private async persistState(
    record: InstructionRecord,
    status: InstructionLifecycleState,
    fields: Partial<InstructionRecord>,
  ): Promise<InstructionRecord> {
    const updated = InstructionRecordSchema.parse({
      ...record,
      ...fields,
      status: instructionProgress(record.status, status),
      updatedAt: new Date().toISOString(),
    });
    await this.store.put(updated);
    return updated;
  }
}
