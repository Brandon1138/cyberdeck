import { ContainerNativeSource } from "../../src/runtime/activity/container-native-source.js";
import { ExecutionTranscriptStore } from "../../src/persistence/execution-transcript-store.js";
import { TurnNativeCapture } from "../../src/runtime/activity/turn-native-capture.js";
import { mkdir, writeFile } from "node:fs/promises";
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
import type { ProviderAdapter } from "../../src/orchestration/session/provider-ports.js";
import { WorkerCoordinationService } from "../../src/broker/worker-coordination.js";
import { WorkerCoordinationStore } from "../../src/persistence/worker-coordination-store.js";
import { WorkerEventChannel } from "../../src/broker/worker-event-channel.js";
import { WorkerHandoffService } from "../../src/orchestration/worker-handoff-service.js";
import { BrokerWorkerLeaseCredentialCustodian } from "../../src/broker/worker-lease-credential-custodian.js";
import { trustedGit } from "../../src/runtime/execution/trusted-git.js";
import type { WorkspaceInputSelection } from "../../src/domain/workspace-input.js";
import type { SessionRecord } from "../../src/domain/session.js";
import { containerRuntime, type ContainerRuntimeFixture } from "./container-runtime.js";
import type { LiveEvalConfig } from "./live-config.js";

export type EvalMode = "offline-scripted" | "container-scripted" | "live-container";
export const isContainerMode = (mode: EvalMode): boolean => mode !== "offline-scripted";
/** Host fixtures answer in milliseconds; a container start is seconds; a live model is minutes. */
export const timeoutFor = (mode: EvalMode, live?: LiveEvalConfig): number => mode === "offline-scripted" ? 5000 : mode === "container-scripted" ? 90_000 : live?.scenarioTimeoutMs ?? 600_000;
export async function eventually(check: () => boolean | Promise<boolean>, message: string, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error(message);
}
/** A committed baseline every container worker is cloned from; the eval never mounts this tree. */
export async function fixtureRepository(source: string, files: Record<string, string> = { "answer.txt": "before\n", "unrelated.txt": "committed\n" }): Promise<string> {
  await mkdir(source, { recursive: true });
  await trustedGit(source, ["init", "-b", "main"]);
  await trustedGit(source, ["config", "user.email", "eval@example.invalid"]);
  await trustedGit(source, ["config", "user.name", "Evaluation fixture"]);
  for (const [name, body] of Object.entries(files)) await writeFile(join(source, name), body);
  await trustedGit(source, ["add", "."]); await trustedGit(source, ["commit", "-m", "fixture baseline"]);
  return source;
}
export interface FixtureOptions {
  scriptedProvider?: "claude" | "codex"; allowsWorkspaceTrust?: (source: string) => Promise<boolean>;
  cwd?: string; sink?: ActivitySinkPort; transcripts?: WorkerTurnTranscriptPort; mode?: EvalMode; live?: LiveEvalConfig;
  selectedInputs?: WorkspaceInputSelection[]; workerPrompt?: string;
}
export interface AcknowledgedReport { workerId: string; eventId?: string; facts: Record<string, unknown> | undefined; code: string }
export async function brokerFixture(root: string, options: FixtureOptions = {}) {
  const mode = options.mode ?? "offline-scripted", live = options.live;
  if (mode === "live-container" && live === undefined) throw new Error("LIVE_EVAL_REQUIRES_AUTHORIZED_CONFIG_AND_NATIVE_CAPTURE");
  const state = join(root, "broker"); await mkdir(state, { recursive: true, mode: 0o700 });
  const local = await AgentActivityStore.open(join(state, "activity")), activity = withActivitySink(local, options.sink);
  let source = options.cwd ?? join(root, "workspace");
  let container: ContainerRuntimeFixture | undefined;
  if (isContainerMode(mode)) {
    container = await containerRuntime(root, mode === "live-container" ? { kind: "provider", live: live! }
      : { kind: "scripted", ...(options.scriptedProvider ? { provider: options.scriptedProvider } : {}) }, activity, options.allowsWorkspaceTrust ?? (mode === "live-container" ? async (path) => path === source : undefined));
    if (options.cwd === undefined) source = await fixtureRepository(join(root, "source"));
  } else await mkdir(source, { recursive: true });
  const provider = container?.provider ?? "claude";
  const hostScript = fileURLToPath(new URL("./scripted-provider.mjs", import.meta.url));
  const hostSpec = (cwd: string) => ({ executable: process.execPath, args: [hostScript], cwd, env: {}, transport: "pty" as const });
  const guest = container?.adapters[provider];
  // Orchestrators stay scripted host processes in every mode; only the worker changes executor.
  const adapter: ProviderAdapter = { id: provider,
    buildLaunchSpec: (session, prompt) => session.kind === "orchestrator" || guest === undefined ? hostSpec(session.cwd) : guest.buildLaunchSpec(session, prompt),
    buildResumeSpec: (session) => { if (guest === undefined) throw new Error("EVAL_RESUME_NOT_REQUESTED"); return guest.buildResumeSpec(session); },
    prepareLaunch: async (session, spec) => { if (session.kind !== "orchestrator" && container) { await container.stageGuest(session); await guest?.prepareLaunch?.(session, spec); } },
    cleanupLaunch: async (session) => { if (session.kind !== "orchestrator") await guest?.cleanupLaunch?.(session); },
    submitInput: (message, session) => guest?.submitInput?.(message, session) ?? Buffer.from(`${message}\n`),
    deferInitialPrompt: (session) => guest?.deferInitialPrompt?.(session) ?? false,
    initializeSession: async (session, terminal) => { if (session.kind !== "orchestrator") await guest?.initializeSession?.(session, terminal); },
    submitInputToTerminal: async (message, terminal) => { if (guest?.submitInputToTerminal) await guest.submitInputToTerminal(message, terminal); else terminal.write(guest?.submitInput?.(message) ?? Buffer.from(`${message}\n`)); },
  };
  const hostExecutions = container ? undefined : await WorkerExecutionStore.open(state);
  const executions = container ? container.executions : new WorkerExecutionService(hostExecutions!, { host: new HostExecutor(createSessionRuntime) });
  const brokerId = container ? container.runtime.brokerId : hostExecutions!.brokerId;
  const nativeTranscripts = mode === "live-container" ? new ExecutionTranscriptStore(state, {},
    new ContainerNativeSource(join(state, "containers")), (id) => { try { return registry.get(id); } catch { return undefined; } }) : undefined;
  await nativeTranscripts?.init();
  const registry: SessionRegistry = new SessionRegistry({ adapters: { [provider]: adapter }, sessionRuntimeFactory: createSessionRuntime, executions,
    workerTurnObservation: new WorkerTurnObservationAdapter(), journal: new Journal(state), store: new SessionStore(state),
    config: BrokerRuntimeConfigSchema.parse({}), ...((options.transcripts ?? nativeTranscripts) === undefined ? {} : { transcripts: options.transcripts ?? nativeTranscripts! }),
  });
  const workers: SessionRecord[] = [], reports: AcknowledgedReport[] = [];
  let unwind: () => Promise<void> = async () => { await registry.stopAll(); await container?.close(); };
  try {
  await registry.ready();
  const actorRecord = await registry.start({ provider, kind: "orchestrator", model: "scripted-fixture", executor: "host", cwd: source, sandbox: "read-only", detached: true });
  const orchestrators = new OrchestratorStore(state), actor = actorRecord.id, now = new Date().toISOString(), scope = { kind: "fleet" as const };
  await orchestrators.put({ key: "fleet", kind: "primary", sessionId: actor, provider, cwd: source, sandbox: "read-only", scope,
    grant: { subjectSessionId: actor, capabilities: [...ORCHESTRATOR_GRANT_CAPABILITIES], scope }, createdAt: now, updatedAt: now });
  const instructionStore = new InstructionStore(state);
  const nativeCapture = nativeTranscripts ? new TurnNativeCapture(join(state, "activity", "native-cursors"), activity, nativeTranscripts, instructionStore) : undefined;
  if (nativeCapture) nativeTranscripts!.attachNativeCapture(nativeCapture);
  const queue = new InstructionQueue(registry, orchestrators, activityInstructionStore(instructionStore, activity, (id) => registry.get(id),
    nativeCapture ? (record, worker) => nativeCapture.captureInstruction(record, worker) : undefined));
  queue.start();
  unwind = async () => { queue.stop(); await registry.stopAll(); await container?.close(); };
  const coordination = new WorkerCoordinationService({ store: new WorkerCoordinationStore(state) }); await coordination.initialize();
  const credentials = new BrokerWorkerLeaseCredentialCustodian();
  const workerHandoff = new WorkerHandoffService({ coordination, registry, orchestrators, credentials });
  const channel = new WorkerEventChannel(coordination, registry, orchestrators, queue);
  container?.bind((id) => { try { return registry.get(id); } catch { return undefined; } }, async (input) => {
    const ack = await channel.submit(input);
    reports.push({ workerId: input.workerId, ...(input.eventId === undefined ? {} : { eventId: input.eventId }), facts: input.structuredFacts, code: (ack as { code: string }).code });
    return ack;
  });
  const socketPath = join(root, "broker.sock"), server = new BrokerServer({ registry, socketPath, instructions: queue, activity, ...(nativeTranscripts ? { transcripts: nativeTranscripts } : {}), workerHandoff, workerEvents: channel });
  unwind = async () => { queue.stop(); await registry.stopAll(); await server.close(); await container?.close(); };
  await server.listen();
  const rpc = await RpcClient.connect(socketPath);
  unwind = async () => { queue.stop(); await registry.stopAll(); rpc.close(); await server.close(); await container?.close(); };
  const startWorker = async (prompt?: string): Promise<SessionRecord> => {
    const record = await registry.start({ provider, model: live?.model ?? "scripted-fixture", ...(live?.effort ? { effort: live.effort } : {}), kind: "worker", executor: container ? "orbstack-container" : "host", cwd: source, sandbox: "workspace-write", ...(live ? { approvalMode: "auto" as const } : {}), detached: true,
      ...(container && options.selectedInputs ? { workspace: { provisioning: "pre-provisioned" as const, worktreePath: source, branch: "eval/scoped", baseRef: "main", writableRoots: [], selectedInputs: options.selectedInputs } } : {}),
    }, prompt ?? (mode === "live-container" ? "Reply with READY. Do not use tools or change any files." : undefined));
    workers.push(record);
    if (mode === "live-container") await eventually(async () => (await nativeTranscripts!.read(record.id, 0, 100)).events
      .some((event) => event.kind === "turn" && event.data.transport === "provider-native") && registry.workerTruth(record.id).state === "idle", "LIVE_WORKER_START_TIMEOUT", timeoutFor(mode, live));
    else await eventually(() => registry.snapshot(record.id).includes("SCRIPT_READY"), "SCRIPT_START_TIMEOUT", timeoutFor(mode));
    return registry.get(record.id);
  };
  const worker = await startWorker(options.workerPrompt);
  return { registry, rpc, queue, worker, actor, cwd: worker.cwd, source, state, activity, coordination, credentials, orchestrators, brokerId, mode, live, container, reports, channel,
    emit: (frame: string) => rpc.request("session.send", { sessionId: worker.id, data: Buffer.from(`emit:${JSON.stringify(frame)}\n`).toString("base64") }),
    instruct: (message: string, target = worker.id) => queue.enqueue({ actorSessionId: actor, targetSessionId: target, message }),
    startWorker, timeout: timeoutFor(mode, live),
    close: async () => {
      try {
        queue.stop(); await registry.stopAll();
        await eventually(() => workers.every((item) => registry.get(item.id).exitCode !== null) && registry.get(actor).exitCode !== null, "SCRIPT_CLEANUP_UNCONFIRMED", timeoutFor(mode, live));
        // Container workers are retired through the production path: stop, collect, destroy.
        if (container) for (const item of workers) await container.executions.retire(item.id);
      } finally { rpc.close(); await server.close(); await container?.close(); }
    },
  };
  } catch (error) { await unwind(); throw error; }
}
export type BrokerFixture = Awaited<ReturnType<typeof brokerFixture>>;
