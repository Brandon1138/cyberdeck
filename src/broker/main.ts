import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ControlPlaneRuntime } from "../control-plane/runtime.js";
import type { WorktreeLeaseManager } from "../control-plane/worktree-lease-manager.js";
import type { ArtifactStore } from "../persistence/artifact-store.js";
import { AppServerJobDispatchAdapter } from "../app-server/dispatch-adapter.js";
import type { JobDispatchAdapter } from "../domain/dispatch.js";
import type { BrokerEvent } from "../domain/events.js";
import { appStateDirectory, brokerSocketPath } from "../paths.js";
import { AntigravityJobDispatchAdapter } from "../providers/antigravity/dispatch-adapter.js";
import { AntigravityProviderAdapter } from "../providers/antigravity/session-adapter.js";
import { ClaudeProviderAdapter } from "../providers/claude.js";
import { ClaudeJobDispatchAdapter } from "../providers/claude/dispatch-adapter.js";
import { CodexProviderAdapter } from "../providers/codex.js";
import { CursorJobDispatchAdapter } from "../providers/cursor/dispatch-adapter.js";
import { CursorProviderAdapter } from "../providers/cursor/session-adapter.js";
import { PtyProcess } from "../runtime/pty-process.js";
import { PipeProcess } from "../runtime/pipe-process.js";
import { Journal } from "./journal.js";
import { NvimBindingService } from "./nvim-binding-service.js";
import { BrokerServer } from "./server.js";
import { FleetProjectService } from "./fleet-project-service.js";
import { SessionRegistry } from "./session-registry.js";
import { ThreadTranscriptStore } from "../persistence/thread-transcript-store.js";
import { OrchestratorStore } from "../persistence/orchestrator-store.js";
import { SessionStore } from "../persistence/session-store.js";
import { FleetPreferenceStore } from "../persistence/fleet-preference-store.js";
import { FleetDetachStore } from "../persistence/fleet-detach-store.js";
import { WorkerPreferenceStore } from "../persistence/worker-preference-store.js";
import { ProviderPermissionPreferenceStore } from "../persistence/provider-permission-preference-store.js";
import { ensurePrivateDirectory } from "../persistence/private-files.js";
import { OrchestratorManager } from "../orchestration/orchestrator-manager.js";
import { AgentControlService } from "../orchestration/agent-control-service.js";
import { InstructionQueue } from "../orchestration/instruction-queue.js";
import { WorkerControlService } from "../orchestration/worker-control-service.js";
import { InstructionStore } from "../persistence/instruction-store.js";
import { WorkflowStore } from "../persistence/workflow-store.js";
import { WorkflowService } from "../orchestration/workflow-service.js";
import { loadBrokerRuntimeConfig } from "../runtime-config.js";
import { selectExpiredThreads, type ThreadRetentionPolicy } from "../domain/thread-retention.js";
import type { SessionRecord } from "../domain/session.js";
import { ScoutReportStore } from "../persistence/scout-report-store.js";
import { ScoutEgressGrantStore } from "../persistence/scout-egress-grant-store.js";
import { CustodyColorStore } from "../persistence/custody-color-store.js";
import { CustodyColorService } from "./custody-color-service.js";
import { WorkerCoordinationRuntime } from "./worker-coordination-runtime.js";
import { WorkerEventChannel } from "./worker-event-channel.js";
import { BrokerWorkerLeaseCredentialCustodian } from "./worker-lease-credential-custodian.js";

function brokerEvent(type: "broker.started" | "broker.shutdown", data: Record<string, unknown>): BrokerEvent {
  return {
    id: randomUUID(),
    type,
    occurredAt: new Date().toISOString(),
    data,
  };
}

/**
 * The neutral backend composition for the job plane: one dispatch adapter per canonical provider id,
 * each selected only when a request names it explicitly. Registration order carries no ranking,
 * priority, or preference, and nothing here routes, substitutes, or falls back between providers.
 * The Agent B adapter implementations are consumed as-is through the frozen dispatch port.
 */
export function composeJobDispatchAdapters(context: {
  leases: WorktreeLeaseManager;
  artifacts: ArtifactStore;
}): JobDispatchAdapter[] {
  return [
    new AppServerJobDispatchAdapter({
      leaseManager: context.leases,
      artifactStore: context.artifacts,
    }),
    new ClaudeJobDispatchAdapter(),
    new CursorJobDispatchAdapter(),
    new AntigravityJobDispatchAdapter(),
  ];
}

/**
 * Load the durable thread catalog and apply the retention policy before anything else reads it.
 *
 * Doing this at startup rather than only while running means an operator who left the broker down
 * for a week does not come back to an unbounded catalog. Compaction is what makes retention real
 * on disk: deletions are tombstones, so the file only shrinks when it is rewritten.
 */
export async function retainThreads(
  store: SessionStore,
  policy: ThreadRetentionPolicy,
  now: number = Date.now(),
  onExpired?: (record: SessionRecord) => Promise<void>,
): Promise<SessionRecord[]> {
  const loaded = await store.load();
  const expired = new Set(selectExpiredThreads(loaded, policy, now));
  if (expired.size === 0) return loaded;
  if (onExpired !== undefined) {
    await Promise.allSettled(
      loaded.filter((record) => expired.has(record.id)).map((record) => onExpired(record)),
    );
  }
  const retained = loaded.filter((record) => !expired.has(record.id));
  await store.compact(retained);
  return retained;
}

export async function runBroker(
  socketPath = brokerSocketPath,
  stateDirectory = appStateDirectory,
): Promise<BrokerServer> {
  await ensurePrivateDirectory(stateDirectory);
  const journal = new Journal(stateDirectory);
  const transcripts = new ThreadTranscriptStore(stateDirectory);
  await transcripts.init();
  const cliPath = resolve(dirname(fileURLToPath(import.meta.url)), "../cli.js");
  const mcp = { nodePath: process.execPath, cliPath };
  const config = loadBrokerRuntimeConfig(resolve(stateDirectory, "config.json"));
  const sessionStore = new SessionStore(stateDirectory);
  const fleetDetaches = new FleetDetachStore(stateDirectory);
  const fleetPreferences = new FleetPreferenceStore(stateDirectory);
  const fleetProjects = new FleetProjectService({ store: fleetPreferences });
  const workerPreferences = new WorkerPreferenceStore(stateDirectory);
  const providerPermissions = new ProviderPermissionPreferenceStore(stateDirectory);
  const scoutReports = new ScoutReportStore(stateDirectory);
  const scoutEgress = new ScoutEgressGrantStore(stateDirectory);
  const recoveredSessions = await retainThreads(
    sessionStore,
    config.threadRetention,
    Date.now(),
    async (record) => {
      if (record.profile === "scout") await scoutReports.remove(record.id);
    },
  );
  const registry = new SessionRegistry({
    adapters: {
      codex: new CodexProviderAdapter({ mcp }),
      claude: new ClaudeProviderAdapter({ mcp }),
      cursor: new CursorProviderAdapter({ mcp }),
      antigravity: new AntigravityProviderAdapter(),
    },
    ptyFactory: (spec, replayBytes) => spec.transport === "pipe"
      ? new PipeProcess(spec, replayBytes)
      : new PtyProcess(spec, replayBytes),
    journal,
    transcripts,
    store: sessionStore,
    recoveredSessions,
    scoutReports,
    config,
  });
  await registry.ready();
  // One pass, on the first broker start that has this code: the directories threads already live
  // in are the only evidence of the operator's projects that predates the registry. It runs before
  // the socket is listening so the first Fleet render never sees a half-seeded list.
  await fleetProjects.seed(recoveredSessions.map((record) => record.cwd)).catch(() => {
    // A machine without git, or with none of these directories left on disk, starts empty. The
    // operator registers projects by hand from there; refusing to boot over it would be worse.
  });
  const orchestratorStore = new OrchestratorStore(stateDirectory);
  const workerCoordination = new WorkerCoordinationRuntime({
    stateDirectory,
    recoveredSessions,
    orchestrators: orchestratorStore,
  });
  await workerCoordination.start();
  // Custody hues read live subjects to decide which slots are still fading, so they are
  // composed after coordination has replayed its durable state.
  const custodyColors = new CustodyColorService({
    store: new CustodyColorStore(stateDirectory),
    subjects: workerCoordination.service,
  });
  const orchestrators = new OrchestratorManager(
    registry,
    orchestratorStore,
    workerPreferences,
    custodyColors,
    providerPermissions,
  );
  const agentControl = new AgentControlService(
    registry,
    orchestratorStore,
    transcripts,
    workerPreferences,
    {
      audit: journal,
      providerPermissions,
      workerCoordination: workerCoordination.service,
      scoutEgress,
    },
  );
  const instructions = new InstructionQueue(registry, orchestratorStore, new InstructionStore(stateDirectory));
  instructions.start();
  const workerLeaseCredentials = new BrokerWorkerLeaseCredentialCustodian();
  const workerControl = new WorkerControlService({
    coordination: workerCoordination.service,
    credentials: workerLeaseCredentials,
    registry,
    orchestrators: orchestratorStore,
    instructions,
  });
  const workerEvents = new WorkerEventChannel(
    workerCoordination.service,
    registry,
    orchestratorStore,
    instructions,
    undefined,
    workerLeaseCredentials,
  );
  const workflows = new WorkflowService(
    registry,
    orchestratorStore,
    new WorkflowStore(stateDirectory),
    instructions,
  );
  // Nothing durable is composed here on purpose: an nvim address only means anything while the
  // nvim that owns the pane it was derived from is still running, which a restarted broker cannot
  // know. It subscribes to session updates so a worker going terminal is a push, not a poll.
  const nvimBindings = new NvimBindingService({
    sessions: registry,
    onSessionUpdate: (listener) => registry.onSessionUpdate(listener),
  });
  nvimBindings.start();

  // The control plane owns durable job state, admission, budgets, leases, and reconciliation. Its
  // runtime enforces the ordering: persistence, then recovery, then reconciliation, and only then is
  // admission opened. The B-owned dispatch adapters are composed in without being modified.
  const runtime = new ControlPlaneRuntime({
    stateDirectory,
    config,
    journal,
    adapters: composeJobDispatchAdapters,
  });
  await runtime.start();

  let shuttingDown = false;
  let server: BrokerServer;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Admission stops first, then in-flight jobs drain and persist, then live sessions stop.
    await runtime.shutdown(reason);
    instructions.stop();
    nvimBindings.stop();
    await registry.stopAll();
    await journal.append(brokerEvent("broker.shutdown", { reason, pid: process.pid }));
    await server.close();
  };

  server = new BrokerServer({
    socketPath,
    registry,
    transcripts,
    orchestrators,
    agentControl,
    instructions,
    workflows,
    controlPlane: runtime.controlPlane,
    controlPlaneRuntime: runtime,
    fleetDetaches,
    fleetPreferences,
    fleetProjects,
    workerPreferences,
    scoutEgress,
    custodyColors,
    orchestratorBindings: orchestratorStore,
    workerCoordination: workerCoordination.service,
    workerControl,
    workerEvents,
    nvimBindings,
    onShutdown: () => { void shutdown("request"); },
  });
  await server.listen();
  await journal.append(brokerEvent("broker.started", { socketPath, pid: process.pid }));

  process.once("SIGINT", () => { void shutdown("SIGINT"); });
  process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
  return server;
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  await runBroker().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
