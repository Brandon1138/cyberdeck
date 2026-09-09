import { randomUUID } from "node:crypto";
import type { ExecutionStorePort } from "./session/execution-ports.js";
import type { AgentActivityPort } from "./agent-activity-port.js";

/** This projection follows durable execution transitions; it never decides lifecycle state. */
export function activityExecutionStore(store: ExecutionStorePort, activity: AgentActivityPort): ExecutionStorePort {
  return { brokerId: store.brokerId, get: (id) => store.get(id), list: () => store.list(),
    put: async (record) => {
      await store.put(record);
      await activity.append({ schemaVersion: 1, eventId: randomUUID(),
        sourceKey: `execution:${record.ref.executionId}:${record.ref.generation}:${record.phase}:${record.updatedAt}`,
        runId: record.ref.workerId, workerId: record.ref.workerId, sessionId: record.ref.sessionId,
        generation: record.ref.generation, executionId: record.ref.executionId,
        occurredAt: record.updatedAt, observedAt: new Date().toISOString(),
        kind: "execution.lifecycle", executionPhase: record.phase, operation: "lifecycle",
        outcome: record.phase === "failed" ? "failed" : "observed", provenance: "broker", coverage: "complete-for-source",
      }).catch(() => undefined);
    },
  };
}
