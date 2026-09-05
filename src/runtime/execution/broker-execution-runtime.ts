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
  return {
    executions: new WorkerExecutionService(store, backends, options.config.workerExecution),
    adapters: config === undefined ? options.adapters : Object.fromEntries(Object.entries(options.adapters).map(([id, adapter]) => [id, new ContainerProviderAdapter(adapter, root)])),
    health: () => ({ configured: config !== undefined, reachable, failures, slots: container?.slots.snapshot() }),
    close: async () => { clearInterval(recoveryTimer); await gateway?.close(); },
  };
}
