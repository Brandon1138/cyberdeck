import { join } from "node:path";
import type { BrokerRuntimeConfig } from "../../config.js";
import type { SessionRecord } from "../../domain/session.js";
import type { ProviderAdapter } from "../../orchestration/session/provider-ports.js";
import { WorkerExecutionService } from "../../orchestration/worker-execution-service.js";
import { reconcileExecutions } from "../../orchestration/execution-reconciler.js";
import { WorkerExecutionStore } from "../../persistence/worker-execution-store.js";
import { WorkerGateway } from "../../broker/worker-gateway.js";
import type { WorkerEventChannel } from "../../broker/worker-event-channel.js";
import { createSessionRuntime } from "../session-runtime-adapter.js";
import { HostExecutor } from "./host-executor.js";
import { OrbStackClient } from "./orbstack-client.js";
import { OrbStackExecutor } from "./orbstack-executor.js";
import { BrokerContainerContexts } from "./broker-container-contexts.js";
import { ContainerProviderAdapter } from "./container-provider-adapter.js";
import { activityExecutionStore } from "../../orchestration/activity-execution-store.js";
import type { AgentActivityPort } from "../../orchestration/agent-activity-port.js";
import type { WorkerExecutor } from "../../domain/worker-execution.js";
import type { WorkerExecutionPort } from "../../orchestration/session/execution-ports.js";

export async function brokerExecutionRuntime(options: {
  stateDirectory: string; config: BrokerRuntimeConfig; adapters: Record<string, ProviderAdapter>;
  lookupSession(id: string): SessionRecord | undefined;
  submitEvent: WorkerEventChannel["submit"];
  activity?: AgentActivityPort;
}) {
  const localStore = await WorkerExecutionStore.open(options.stateDirectory);
  const store = options.activity === undefined ? localStore : activityExecutionStore(localStore, options.activity);
  const host = new HostExecutor(createSessionRuntime), config = options.config.containerRuntime;
  const root = join(options.stateDirectory, "containers");
  let gateway: WorkerGateway | undefined, container: OrbStackExecutor | undefined;
  let reachable = true;
  const backends: Partial<Record<WorkerExecutor, WorkerExecutionPort>> = { host };
  let recoveryTimer: ReturnType<typeof setInterval> | undefined;
  let recoveryPending = false;
  let failures = 0;
  if (config !== undefined) {
    gateway = new WorkerGateway({ submit: options.submitEvent }, (binding) => {
      const execution = store.get(binding.workerId), session = options.lookupSession(binding.workerId);
      return execution?.ref.executionId === binding.executionId && execution.ref.generation === binding.generation
        && session?.executionState === "active";
    });
    const port = await gateway.listen();
    container = new OrbStackExecutor({ client: new OrbStackClient(config.endpoint), profile: config,
      contexts: new BrokerContainerContexts(root, config.credentialFiles, gateway, port), attach: createSessionRuntime,
      evidenceDirectory: join(root, "evidence"), onFailure: () => { failures++; },
    });
    const recover = async () => {
      if (recoveryPending) return;
      recoveryPending = true;
      try {
        const recovered = await reconcileExecutions(store, { host, "orbstack-container": container! });
        reachable = recovered.unreachable.length === 0;
        if (reachable) { backends["orbstack-container"] = container!; clearInterval(recoveryTimer); }
      } catch { reachable = false; failures++; }
      finally { recoveryPending = false; }
    };
    await recover();
    // Retry only the closed-admission startup set. Once new workers are admitted this
    // reconciler must not mistake their live executions for abandoned crash survivors.
    if (!reachable) recoveryTimer = setInterval(() => { void recover(); }, 15_000).unref();
  }
  const executions = new WorkerExecutionService(store, backends, options.config.workerExecution, (config?.attemptTimeoutMinutes ?? 60) * 60000);
  // Background work in flight at shutdown is awaited, never abandoned mid-stop or mid-destroy:
  // a half-finished retirement would otherwise be re-run only at the next start.
  let timeoutWork: Promise<void> | undefined, cleanupWork: Promise<void> | undefined, closing = false;
  const timeoutTimer = setInterval(() => {
    if (timeoutWork || closing) return;
    timeoutWork = executions.expireAttempts().catch(() => { failures++; }).finally(() => { timeoutWork = undefined; });
  }, 1000).unref();
  const cleanupTimer = setInterval(() => {
    if (cleanupWork || closing) return;
    cleanupWork = (async () => {
      for (const record of store.list()) {
        if (closing) return;
        // Only failed acquisitions with no registered session. Live/resumable workers retain
        // their environment; explicit session retirement owns their deletion boundary.
        if (record.phase !== "failed" || record.ref.executor !== "orbstack-container"
          || options.lookupSession(record.ref.sessionId) !== undefined || Date.now() < Date.parse(record.cleanupEligibleAt ?? record.updatedAt) + (record.cleanupEligibleAt ? 0 : 24 * 3600000)) continue;
        await executions.retire(record.ref.sessionId).catch(() => { failures++; });
      }
    })().catch(() => { failures++; }).finally(() => { cleanupWork = undefined; });
  }, 60000).unref();
  return {
    executions, closeAdmission: () => executions.closeAdmission(),
    adapters: config === undefined ? options.adapters : Object.fromEntries(Object.entries(options.adapters).map(([id, adapter]) => [id, new ContainerProviderAdapter(adapter, root)])),
    health: () => ({ configured: config !== undefined, reachable, failures, slots: container?.slots.snapshot(), profile: container?.support(),
      retainedFailures: store.list().filter((record) => record.phase === "failed" && record.ref.executor === "orbstack-container").map((record) => ({
        sessionId: record.ref.sessionId, failure: record.failure, cleanupFailed: record.cleanupFailed === true, cleanupEligibleAt: record.cleanupEligibleAt,
        registered: options.lookupSession(record.ref.sessionId) !== undefined })),
      records: store.list() }),
    close: async () => {
      closing = true;
      clearInterval(recoveryTimer); clearInterval(cleanupTimer); clearInterval(timeoutTimer);
      await executions.closeAdmission();
      await Promise.all([timeoutWork, cleanupWork]);
      await gateway?.close();
    },
  };
}
