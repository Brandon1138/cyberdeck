import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionRegistry } from "../../src/broker/session-registry.js";
import { BrokerServer } from "../../src/broker/server.js";
import { RpcClient } from "../../src/client/rpc-client.js";
import { BrokerRuntimeConfigSchema } from "../../src/config.js";
import { WorkerTurnObservationAdapter } from "../../src/runtime/worker-turn-observation-adapter.js";
import { createSessionRuntime } from "../../src/runtime/session-runtime-adapter.js";
import { Journal } from "../../src/persistence/journal.js";
import { SessionStore } from "../../src/persistence/session-store.js";
import { InstructionStore } from "../../src/persistence/instruction-store.js";
import { InstructionQueue } from "../../src/orchestration/instruction-queue.js";
import { OrchestratorStore } from "../../src/persistence/orchestrator-store.js";
import { ORCHESTRATOR_GRANT_CAPABILITIES } from "../../src/domain/orchestrator.js";
import { WorkerExecutionStore } from "../../src/persistence/worker-execution-store.js";
import { WorkerExecutionService } from "../../src/orchestration/worker-execution-service.js";
import { HostExecutor } from "../../src/runtime/execution/host-executor.js";
import { AgentActivityStore } from "../../src/persistence/agent-activity-store.js";
import { activityInstructionStore } from "../../src/orchestration/activity-instruction-store.js";
import { withActivitySink, type ActivitySinkPort } from "../../src/orchestration/activity-sink.js";
import type { WorkerTurnTranscriptPort } from "../../src/orchestration/session/worker-turn-ports.js";
import { WorkerCoordinationService } from "../../src/broker/worker-coordination.js";
import { WorkerCoordinationStore } from "../../src/persistence/worker-coordination-store.js";
import { WorkerHandoffService } from "../../src/orchestration/worker-handoff-service.js";
import { BrokerWorkerLeaseCredentialCustodian } from "../../src/broker/worker-lease-credential-custodian.js";

export async function eventually(check: () => boolean | Promise<boolean>, message: string, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error(message);
}
export async function brokerFixture(root: string, options: { cwd?: string; sink?: ActivitySinkPort; transcripts?: WorkerTurnTranscriptPort } = {}) {
  const state = join(root, "broker"), cwd = options.cwd ?? join(root, "workspace"); await mkdir(cwd, { recursive: true });
  const local = await AgentActivityStore.open(join(state, "activity")), activity = withActivitySink(local, options.sink);
  const executions = await WorkerExecutionStore.open(state);
  const adapter = { id: "claude", buildLaunchSpec: () => ({ executable: process.execPath,
    args: [fileURLToPath(new URL("./scripted-provider.mjs", import.meta.url))], cwd, env: {}, transport: "pty" as const }),
    buildResumeSpec: () => { throw new Error("EVAL_RESUME_NOT_REQUESTED"); } };
  const registry = new SessionRegistry({ adapters: { claude: adapter }, sessionRuntimeFactory: createSessionRuntime,
    executions: new WorkerExecutionService(executions, { host: new HostExecutor(createSessionRuntime) }),
    workerTurnObservation: new WorkerTurnObservationAdapter(), journal: new Journal(state), store: new SessionStore(state),
    config: BrokerRuntimeConfigSchema.parse({}), ...(options.transcripts === undefined ? {} : { transcripts: options.transcripts }),
  });
  let unwind: () => Promise<void> = () => registry.stopAll();
  try {
  await registry.ready();
  const actorRecord = await registry.start({ provider: "claude", kind: "orchestrator", model: "scripted-fixture", executor: "host", cwd, sandbox: "read-only", detached: true });
  const orchestrators = new OrchestratorStore(state), actor = actorRecord.id, now = new Date().toISOString(), scope = { kind: "fleet" as const };
  await orchestrators.put({ key: "fleet", kind: "primary", sessionId: actor, provider: "claude", cwd, sandbox: "read-only", scope,
    grant: { subjectSessionId: actor, capabilities: [...ORCHESTRATOR_GRANT_CAPABILITIES], scope }, createdAt: now, updatedAt: now });
  const instructionStore = new InstructionStore(state);
  const queue = new InstructionQueue(registry, orchestrators, activityInstructionStore(instructionStore, activity, (id) => registry.get(id)));
  queue.start();
  unwind = async () => { queue.stop(); await registry.stopAll(); };
  const coordination = new WorkerCoordinationService({ store: new WorkerCoordinationStore(state) }); await coordination.initialize();
  const credentials = new BrokerWorkerLeaseCredentialCustodian();
  const workerHandoff = new WorkerHandoffService({ coordination, registry, orchestrators, credentials });
  const socketPath = join(root, "broker.sock"), server = new BrokerServer({ registry, socketPath, instructions: queue, activity, workerHandoff });
  unwind = async () => { queue.stop(); await registry.stopAll(); await server.close(); };
  await server.listen();
  const rpc = await RpcClient.connect(socketPath);
  unwind = async () => { queue.stop(); await registry.stopAll(); rpc.close(); await server.close(); };
  const worker = await registry.start({ provider: "claude", model: "scripted-fixture", kind: "worker", executor: "host", cwd, sandbox: "workspace-write", detached: true });
  await eventually(() => registry.snapshot(worker.id).includes("SCRIPT_READY"), "SCRIPT_START_TIMEOUT");
  return { registry, rpc, queue, worker, actor, cwd, state, activity, coordination, credentials, orchestrators, executions, brokerId: executions.brokerId,
    emit: (frame: string) => rpc.request("session.send", { sessionId: worker.id, data: Buffer.from(`emit:${JSON.stringify(frame)}\n`).toString("base64") }),
    instruct: (message: string) => queue.enqueue({ actorSessionId: actor, targetSessionId: worker.id, message }),
    close: async () => {
      try {
        queue.stop(); await registry.stopAll();
        await eventually(() => registry.get(worker.id).exitCode !== null && registry.get(actor).exitCode !== null, "SCRIPT_CLEANUP_UNCONFIRMED");
      } finally { rpc.close(); await server.close(); }
    },
  };
  } catch (error) { await unwind(); throw error; }
}
export type BrokerFixture = Awaited<ReturnType<typeof brokerFixture>>;
