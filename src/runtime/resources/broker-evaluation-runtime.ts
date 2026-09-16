import { join } from "node:path";
import type { AgentActivityPort } from "../../orchestration/agent-activity-port.js";
import { TaskEvaluationStore } from "../../persistence/task-evaluation-store.js";
import { TaskEvaluationService } from "../../orchestration/task-evaluation-service.js";
import { auditTerminalInstructions, repairTerminalInstructionProjections, TaskEvaluationReconciliationService } from "../../orchestration/task-evaluation-reconciliation.js";
import type { InstructionRecord } from "../../domain/instruction.js";
import type { BrokerRuntimeConfig } from "../../config.js";
import type { brokerResourceRuntime } from "./broker-resource-runtime.js";
import { TaskEvaluationExecutor } from "../execution/task-evaluation-executor.js";
import { OrbStackClient } from "../execution/orbstack-client.js";
import type { PersistedJobState } from "../../control-plane/job-control-plane.js";
import { auditTerminalJobs, repairTerminalJobProjections } from "../../orchestration/job-terminal-activity.js";

/** Capture is independent of evaluator availability. Missing objective evidence stays unverified. */
export async function brokerEvaluationRuntime(options: {
  directory: string; activity: AgentActivityPort; instructions(): Promise<InstructionRecord[]>;
  instructionVersion?(): number;
  jobs?: { load(): Promise<PersistedJobState[]>; version(): number };
  execution?: { config: BrokerRuntimeConfig; resource: NonNullable<Awaited<ReturnType<typeof brokerResourceRuntime>>> };
}) {
  const store = new TaskEvaluationStore(join(options.directory, "task-evaluations.sqlite"));
  const service = new TaskEvaluationService(store, { capture: async event => {
    if (!event.generation) throw new Error("EVALUATION_GENERATION_UNKNOWN");
    return { generation: event.generation, manifest: { schemaVersion: 1, terminalEvent: event,
      complete: false, checks: [], metadata: { ...(event.provider ? { provider: event.provider } : {}),
        ...(event.model ? { model: event.model } : {}), modelSource: event.model ? "observed" : "unknown" } } };
  } }, { id: "production-attempt", version: "1" });
  let instructionRevision: number | undefined, jobRevision: number | undefined;
  let instructionSnapshot: InstructionRecord[] = [], jobSnapshot: PersistedJobState[] = [];
  const replay = new TaskEvaluationReconciliationService(options.activity, store, service, {
    consumer: "production-attempt-v1", pageSize: 100, maxPages: 4,
    auditCanonicalCoverage: async () => {
      const revision = options.instructionVersion?.();
      if (revision === undefined || instructionRevision !== revision) {
        instructionSnapshot = await options.instructions(); instructionRevision = revision;
      }
      const records = instructionSnapshot;
      await repairTerminalInstructionProjections(store, options.activity, records);
      const instructionAudit = await auditTerminalInstructions(store, records);
      if (instructionAudit.state !== "complete") return instructionAudit;
      if (!options.jobs) return { state: "gap", reason: "canonical-job-coverage-unavailable" };
      const version = options.jobs.version();
      if (jobRevision !== version) { jobSnapshot = await options.jobs.load(); jobRevision = version; }
      await repairTerminalJobProjections(store, options.activity, jobSnapshot);
      return auditTerminalJobs(store, jobSnapshot);
    },
  });
  await replay.reconcile();
  let executor: TaskEvaluationExecutor | undefined;
  const configured = options.execution?.config.resourceManagement?.evaluation;
  if (configured && options.execution) {
    const { config, resource } = options.execution;
    executor = new TaskEvaluationExecutor({ client: new OrbStackClient(config.containerRuntime!.endpoint), store,
      admission: resource.admission, ...configured, installationId: config.resourceManagement!.installationId,
      directory: join(options.directory, "evaluations"),
      // Explicit installation background bucket; never attribute history to a newer controller.
      resolveFamily: async () => "operator-evaluation", requiredChecks: () => [] });
    resource.registerVerifier("offline-promptfoo", (reservation, evidence) => executor!.verifyTermination(reservation, evidence));
    await executor.reconcile();
  }
  let pending: Promise<unknown> | undefined;
  let evaluation: Promise<unknown> | undefined;
  const abort = new AbortController();
  let lastSignature = "", auditedAt = 0, nextEvaluationAt = 0;
  const timer = setInterval(() => {
    const signature = JSON.stringify([options.activity.replayBounds?.(), options.instructionVersion?.(), options.jobs?.version()]);
    if (!pending && (signature !== lastSignature || Date.now() - auditedAt >= 60000)) {
      lastSignature = signature; auditedAt = Date.now();
      pending = replay.reconcile().finally(() => { pending = undefined; });
    }
    if (executor && !evaluation && !abort.signal.aborted && Date.now() >= nextEvaluationAt
      && (store.health().pending > 0 || executor.health().state === "blocked" || !executor.health().reconciled)) {
      nextEvaluationAt = Date.now() + (executor.health().state === "blocked" ? 30000 : 5000);
      evaluation = (executor.health().reconciled ? executor.runNext(abort.signal) : executor.reconcile())
        .finally(() => { evaluation = undefined; });
    }
  }, 1000).unref();
  return { store, service, replay,
    admissionHold: () => ["gap", "backpressure"].includes(replay.health().state) ? "evaluation-capture-gap" : null,
    health: () => ({ capture: replay.health(), outbox: store.health(), evaluator: executor?.health() ?? "not-configured" }),
    close: async () => { clearInterval(timer); abort.abort(); await Promise.all([pending, evaluation]); await replay.reconcile(); store.close(); },
  };
}
