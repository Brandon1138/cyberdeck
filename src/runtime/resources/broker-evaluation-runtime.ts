import { join } from "node:path";
import type { AgentActivityPort } from "../../orchestration/agent-activity-port.js";
import { TaskEvaluationStore } from "../../persistence/task-evaluation-store.js";
import { TaskEvaluationService } from "../../orchestration/task-evaluation-service.js";
import { auditTerminalInstructions, repairTerminalInstructionProjections, TaskEvaluationReconciliationService } from "../../orchestration/task-evaluation-reconciliation.js";
import type { InstructionRecord } from "../../domain/instruction.js";

/** Capture is independent of evaluator availability. Missing objective evidence stays unverified. */
export async function brokerEvaluationRuntime(options: {
  directory: string; activity: AgentActivityPort; instructions(): Promise<InstructionRecord[]>;
}) {
  const store = new TaskEvaluationStore(join(options.directory, "task-evaluations.sqlite"));
  const service = new TaskEvaluationService(store, { capture: async event => {
    if (!event.generation) throw new Error("EVALUATION_GENERATION_UNKNOWN");
    return { generation: event.generation, manifest: { schemaVersion: 1, terminalEvent: event,
      complete: false, checks: [], metadata: { ...(event.provider ? { provider: event.provider } : {}),
        ...(event.model ? { model: event.model } : {}), modelSource: event.model ? "observed" : "unknown" } } };
  } }, { id: "production-attempt", version: "1" });
  const replay = new TaskEvaluationReconciliationService(options.activity, store, service, {
    consumer: "production-attempt-v1", pageSize: 100, maxPages: 4,
    auditCanonicalCoverage: async () => {
      const records = await options.instructions();
      await repairTerminalInstructionProjections(store, options.activity, records);
      return auditTerminalInstructions(store, records);
    },
  });
  await replay.reconcile();
  let pending: Promise<unknown> | undefined;
  const timer = setInterval(() => {
    if (!pending) pending = replay.reconcile().finally(() => { pending = undefined; });
  }, 1000).unref();
  return { store, service, replay,
    admissionHold: () => ["gap", "backpressure"].includes(replay.health().state) ? "evaluation-capture-gap" : null,
    health: () => ({ capture: replay.health(), outbox: store.health(), evaluator: "not-configured" }),
    close: async () => { clearInterval(timer); await pending; await replay.reconcile(); store.close(); },
  };
}
