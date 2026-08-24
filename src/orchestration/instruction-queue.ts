import { randomUUID } from "node:crypto";
import { z } from "zod";
import { grantAllows } from "../domain/capability.js";
import { InstructionRecordSchema, type InstructionRecord } from "../domain/instruction.js";
import { instructionReachedProvider, type InstructionLifecycleState } from "../domain/worker-truth.js";
import type {
  InstructionRepository,
  InstructionStateUpdate,
  OrchestratorBindingReader,
  SessionInstructionPort,
} from "./session/session-ports.js";

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
    const existing = await this.store.list(request.targetSessionId);
    const duplicate = existing.find((record) => record.messageId === request.messageId);
    if (duplicate !== undefined) return duplicate;
    const now = new Date().toISOString();
    const record = InstructionRecordSchema.parse({
      id: randomUUID(),
      actorSessionId: request.actorSessionId,
      targetSessionId: request.targetSessionId,
      message: request.message,
      status: "accepted",
      createdAt: now,
      updatedAt: now,
      messageId: request.messageId,
      hop: 0,
      brokerOwned: true,
    });
    await this.store.put(record);
    await this.flush(record.targetSessionId);
    return (await this.store.list(record.targetSessionId)).find(({ id }) => id === record.id) ?? record;
  }

  flush(targetSessionId: string): Promise<InstructionRecord[]> {
    return this.serialize(targetSessionId, async () => {
      const pending = (await this.store.list(targetSessionId))
        .filter((record) => record.status === "accepted" || record.status === "queued");
      const results: InstructionRecord[] = [];
      for (const [index, record] of pending.entries()) {
        const attempted = await this.tryDeliver(record);
        results.push(attempted);
        // Still held: the boundary that stopped this one stops everything behind it, and order is
        // the whole point of a queue. Everything behind it is held for a reason it can be told —
        // leaving it `accepted` would read as "the broker has not looked at this yet".
        if (instructionReachedProvider(attempted.status)) continue;
        // A terminal worker holds nothing back: the next record hits the same dead session and
        // resolves itself the same way, each with its own honest terminal state.
        if (attempted.status === "undelivered") continue;
        const holdReason = attempted.status === "rendered"
          ? "composer-occupied"
          : attempted.holdReason ?? "composer-occupied";
        for (const behind of pending.slice(index + 1)) {
          results.push(await this.persistState(behind, "queued", { holdReason }));
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
   * Carry a broker-observed lifecycle step onto the durable record.
   *
   * The broker is the only thing that can see submission and completion, and it reports them long
   * after `enqueue` returned. Writing them here is what makes `thread_read` able to walk an
   * instruction from accepted through to the turn that answered it with no gap in between.
   */
  private async applyState(update: InstructionStateUpdate): Promise<void> {
    await this.serialize(update.sessionId, async () => {
      const record = (await this.store.list(update.sessionId)).find(({ id }) => id === update.instructionId);
      if (record === undefined || record.status === update.state) return;
      await this.store.put(InstructionRecordSchema.parse({
        ...record,
        status: update.state,
        updatedAt: update.at,
        // A provider can be seen to have taken the payload only once, and the broker may report that
        // as `acknowledged` or straight through to `completed` if the turn was faster than a poll.
        // The stamp is about the fact, not about which frame carried the news.
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
    const source = record.brokerOwned === true
      ? "broker"
      : record.senderSessionId !== undefined && record.senderSessionId !== record.actorSessionId
        ? "worker"
        : "orchestrator";
    let delivery;
    try {
      delivery = await this.registry.submitInstruction(record.targetSessionId, record.message, source, {
        actorSessionId: record.actorSessionId,
        senderSessionId: record.senderSessionId ?? record.actorSessionId,
        messageId: record.messageId,
        workflowRunId: record.workflowRunId ?? null,
        brokerOwned: record.brokerOwned === true,
      }, record.id);
    } catch (error) {
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
        ...(delivery.hold === undefined ? {} : { holdReason: delivery.hold }),
      });
    }
    return delivery.state === "queued"
      ? this.persistState(record, "queued", { ...(delivery.hold === undefined ? {} : { holdReason: delivery.hold }) })
      : this.persistState(record, "rendered", {
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
      status,
      updatedAt: new Date().toISOString(),
    });
    await this.store.put(updated);
    return updated;
  }
}
