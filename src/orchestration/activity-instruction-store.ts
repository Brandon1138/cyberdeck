import { randomUUID } from "node:crypto";
import type { InstructionRecord } from "../domain/instruction.js";
import type { SessionRecord } from "../domain/session.js";
import type { AgentActivityPort } from "./agent-activity-port.js";

interface Instructions { put(record: InstructionRecord): Promise<void>; list(targetSessionId?: string): Promise<InstructionRecord[]> }
/** Activity follows the acknowledged instruction write; recorder failure cannot rewrite its outcome. */
export function activityInstructionStore(store: Instructions, recorder: AgentActivityPort,
  session: (id: string) => SessionRecord | undefined,
): Instructions {
  return {
    list: (id) => store.list(id),
    put: async (record) => {
      await store.put(record);
      const worker = session(record.targetSessionId);
      const kind = record.status === "completed" ? "instruction.settled" : `instruction.${record.status}` as const;
      await recorder.append({ schemaVersion: 1, eventId: randomUUID(), sourceKey: `instruction:${record.id}:${record.status}:${record.updatedAt}`,
        runId: record.workflowRunId ?? record.id, workerId: record.targetSessionId, sessionId: record.targetSessionId,
        instructionId: record.id, ...(worker?.generation === undefined ? {} : { generation: worker.generation }),
        ...(worker?.execution === undefined ? {} : { executionId: worker.execution.executionId }),
        ...(record.causationId === undefined ? {} : { causationId: record.causationId }),
        kind, operation: "instruction", provenance: "broker", coverage: worker === undefined ? "partial" : "complete-for-source",
        occurredAt: record.updatedAt, observedAt: new Date().toISOString(), outcome: "observed",
      }).catch(() => undefined);
      if (record.status === "accepted") {
        await recorder.append({ schemaVersion: 1, eventId: randomUUID(), sourceKey: `native-capture-unwired:${record.id}`,
          runId: record.workflowRunId ?? record.id, workerId: record.targetSessionId, sessionId: record.targetSessionId,
          instructionId: record.id, observedAt: new Date().toISOString(), kind: "capture.gap", operation: "capture",
          provenance: "broker", coverage: "unavailable", outcome: "unknown", gap: "unsupported-source",
        }).catch(() => undefined);
      }
    },
  };
}
