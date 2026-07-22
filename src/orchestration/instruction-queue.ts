import { randomUUID } from "node:crypto";
import { z } from "zod";
import { grantAllows } from "../domain/capability.js";
import { InstructionRecordSchema, type InstructionRecord } from "../domain/instruction.js";
import type { SessionRegistry } from "../broker/session-registry.js";
import type { InstructionStore } from "../persistence/instruction-store.js";
import type { OrchestratorStore } from "../persistence/orchestrator-store.js";

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

export class InstructionQueue {
  private unsubscribe: (() => void) | undefined;

  constructor(
    private readonly registry: SessionRegistry,
    private readonly orchestrators: OrchestratorStore,
    private readonly store: InstructionStore,
  ) {}

  start(): void {
    this.unsubscribe ??= this.registry.onControllerReleased((sessionId) => {
      void this.flush(sessionId);
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
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
      status: "queued",
      createdAt: now,
      updatedAt: now,
      ...(request.workflowRunId === undefined ? {} : { workflowRunId: request.workflowRunId }),
      messageId,
      ...(request.causationId === undefined ? {} : { causationId: request.causationId }),
      hop: request.hop,
    });
    await this.store.put(record);
    return this.tryDeliver(record);
  }

  async flush(targetSessionId: string): Promise<InstructionRecord[]> {
    const queued = (await this.store.list(targetSessionId)).filter((record) => record.status === "queued");
    const results: InstructionRecord[] = [];
    for (const record of queued) {
      const delivered = await this.tryDeliver(record);
      results.push(delivered);
      if (delivered.status === "queued") break;
    }
    return results;
  }

  list(targetSessionId?: string): Promise<InstructionRecord[]> {
    return this.store.list(targetSessionId);
  }

  private async tryDeliver(record: InstructionRecord): Promise<InstructionRecord> {
    try {
      const source = record.senderSessionId !== undefined && record.senderSessionId !== record.actorSessionId
        ? "worker"
        : "orchestrator";
      await this.registry.submitInstruction(record.targetSessionId, record.message, source, {
        actorSessionId: record.actorSessionId,
        senderSessionId: record.senderSessionId ?? record.actorSessionId,
        messageId: record.messageId,
        workflowRunId: record.workflowRunId ?? null,
      });
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "SESSION_BUSY") {
        return record;
      }
      throw error;
    }
    const now = new Date().toISOString();
    const delivered = InstructionRecordSchema.parse({
      ...record,
      status: "delivered",
      updatedAt: now,
      deliveredAt: now,
    });
    await this.store.put(delivered);
    return delivered;
  }
}
