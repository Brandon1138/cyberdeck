import { randomUUID } from "node:crypto";
import type { InstructionRecord } from "../domain/instruction.js";
import type { SessionRecord } from "../domain/session.js";
import type { AgentActivityPort } from "./agent-activity-port.js";
import type { ActivityInput } from "../domain/agent-activity.js";

interface Instructions { put(record: InstructionRecord): Promise<void>; list(targetSessionId?: string): Promise<InstructionRecord[]> }
export interface InstructionCommitObserver {
  writing(record: InstructionRecord): void;
  committed(record: InstructionRecord): void;
  failed(record: InstructionRecord): void;
}
/** Activity follows the acknowledged instruction write; recorder failure cannot rewrite its outcome. */
export function activityInstructionStore(store: Instructions, recorder: AgentActivityPort,
  session: (id: string) => SessionRecord | undefined,
  capture?: (record: InstructionRecord, session: SessionRecord | undefined) => Promise<void>,
  observer?: InstructionCommitObserver,
): Instructions {
  return {
    list: (id) => store.list(id),
    put: async (record) => {
      const worker = session(record.targetSessionId);
      // Snapshot before the first await. A provider may exit or resume while fsync is pending.
      // Rendering rebinds a queued/parked instruction to its actual admitted generation.
      const pin = record.status === "rendered" || record.status === "accepted";
      const generation = pin ? worker?.generation : record.attemptGeneration;
      const executionId = pin ? worker?.execution?.executionId : record.attemptExecutionId;
      const persisted = { ...record, ...(generation === undefined ? {} : { attemptGeneration: generation }),
        ...(executionId === undefined ? {} : { attemptExecutionId: executionId }) };
      const kind = record.status === "completed" ? "instruction.settled" : `instruction.${record.status}` as const;
      const event: ActivityInput = { schemaVersion: 1, eventId: record.status === "accepted" ? record.id : randomUUID(),
        ...(record.status === "accepted" ? {} : { parentEventId: record.id }), sourceKey: `instruction:${record.id}:${record.status}:${record.updatedAt}`,
        runId: record.workflowRunId ?? record.id, workerId: record.targetSessionId, sessionId: record.targetSessionId,
        instructionId: record.id, ...(generation === undefined ? {} : { generation }),
        ...(executionId === undefined ? {} : { executionId }),
        ...(record.causationId === undefined ? {} : { causationId: record.causationId }),
        kind, operation: "instruction", provenance: "broker", coverage: worker === undefined ? "partial" : "complete-for-source",
        occurredAt: record.updatedAt, observedAt: new Date().toISOString(), outcome: "observed",
      };
      const terminal = ["completed", "cancelled", "undelivered"].includes(record.status);
      const durable = { ...persisted, ...(terminal ? { terminalActivity: event } : {}) };
      observer?.writing(durable);
      try { await store.put(durable); observer?.committed(durable); }
      catch (error) { observer?.failed(durable); throw error; }
      await recorder.append(event).catch(() => undefined);
      await capture?.(persisted, worker).catch(() => undefined);
      if (record.status === "accepted" && (capture === undefined || worker?.executor !== "orbstack-container")) {
        await recorder.append({ schemaVersion: 1, eventId: randomUUID(), sourceKey: `native-capture-unwired:${record.id}`,
          runId: record.workflowRunId ?? record.id, workerId: record.targetSessionId, sessionId: record.targetSessionId,
          instructionId: record.id, observedAt: new Date().toISOString(), kind: "capture.gap", operation: "capture",
          provenance: "broker", coverage: "unavailable", outcome: "unknown", gap: "unsupported-source",
        }).catch(() => undefined);
      }
    },
  };
}
