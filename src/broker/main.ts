import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ControlPlaneRuntime } from "../control-plane/runtime.js";
import type { WorktreeLeaseManager } from "../control-plane/worktree-lease-manager.js";
import { ArtifactStore } from "../persistence/artifact-store.js";
import { JobStore } from "../persistence/job-store.js";
import { LeaseStore } from "../persistence/lease-store.js";
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
import { captureScoutWorkspaceStateHash } from "../providers/cursor/workspace-state.js";
import { jobLaunchEnvironment } from "../providers/launch-environment.js";
import { applyWorkerMode } from "../providers/worker-mode.js";
import { createSessionRuntime } from "../runtime/session-runtime-adapter.js";
import { WorkerTurnObservationAdapter } from "../runtime/worker-turn-observation-adapter.js";
import { Journal } from "../persistence/journal.js";
import { callNvim } from "../nvim/bridge.js";
import { worktreeChanges, gitOutputIn } from "../nvim/worktree-changes.js";
import { NvimBindingService } from "./nvim-binding-service.js";
import { BrokerServer } from "./server.js";
import { FleetProjectService } from "./fleet-project-service.js";
import { SessionRegistry } from "./session-registry.js";
import {
  ThreadTranscriptStore,
  pruneLegacyTranscript,
} from "../persistence/thread-transcript-store.js";
import { ClaudeConversationBindingStore } from "../persistence/claude-conversation-bindings.js";
import { OrchestratorStore } from "../persistence/orchestrator-store.js";
import { SessionStore } from "../persistence/session-store.js";
import { FleetPreferenceStore } from "../persistence/fleet-preference-store.js";
import { FleetDetachStore } from "../persistence/fleet-detach-store.js";
import { WorkerPreferenceStore } from "../persistence/worker-preference-store.js";
import { ProviderPermissionPreferenceStore } from "../persistence/provider-permission-preference-store.js";
import { ensurePrivateDirectory } from "../persistence/private-files.js";
import { OrchestratorManager } from "../orchestration/orchestrator-manager.js";
import { AgentControlService } from "../orchestration/agent-control-service.js";
import { GitWorkspaceProbe } from "../orchestration/git-workspace-probe.js";
import { GitWorktreeProvisioner } from "../orchestration/git-worktree-provisioner.js";
import { WorkerCapabilityCatalog } from "../orchestration/worker-capability-catalog.js";
import { InstructionQueue } from "../orchestration/instruction-queue.js";
import { LocalWorkerControlService } from "../orchestration/local-worker-control-service.js";
import { WorkerBudgetEnforcer } from "./worker-budget-enforcer.js";
import { WorkerControlService } from "../orchestration/worker-control-service.js";
import { WorkerHandoffService } from "../orchestration/worker-handoff-service.js";
import { InstructionStore } from "../persistence/instruction-store.js";
import { WorkflowStore } from "../persistence/workflow-store.js";
import { WorkflowService } from "../orchestration/workflow-service.js";
import { loadBrokerRuntimeConfig } from "../runtime-config.js";
import { retainStartupThreads } from "../orchestration/startup-thread-retention.js";
import { ScoutReportStore } from "../persistence/scout-report-store.js";
import { ScoutEgressGrantStore } from "../persistence/scout-egress-grant-store.js";
import { WorkerCoordinationRuntime } from "../persistence/worker-coordination-runtime.js";
import { WorkerEventChannel } from "./worker-event-channel.js";
import { BrokerWorkerLeaseCredentialCustodian } from "./worker-lease-credential-custodian.js";
import { WorkerCoordinationService } from "./worker-coordination.js";
import {
  detachCockpit,
  launchCockpit,
  preflightCockpit,
} from "../tmux/cockpit.js";
import {
  openCheckoutInNvim,
  openWorktreeInNvim,
  selectSession,
  worktreeSubject,
} from "../nvim/open-worktree.js";
import {
  createFleetNvimLayoutHooks,
  rebalanceNvimLayoutFromHook,
} from "../nvim/layout-hook.js";
import { openInteractiveShell } from "../tmux/interactive-shell.js";
import { runShellCommand } from "../runtime/shell-command.js";
import { runClaudeTranscriptRebind } from "../providers/claude/transcript-hook.js";
import type { CliToolkit } from "../cli/toolkit.js";
import type { FleetRuntimeDeps } from "../client/fleet/deps.js";

function brokerEvent(type: "broker.started" | "broker.shutdown", data: Record<string, unknown>): BrokerEvent {
  return {
    id: randomUUID(),
    type,
    occurredAt: new Date().toISOString(),
    data,
  };
}

export function createFleetRuntimeDeps(
  stateDirectory = appStateDirectory,
): FleetRuntimeDeps {
  return {
    permissionPreferences: new ProviderPermissionPreferenceStore(stateDirectory),
    runShellCommand,
  };
}

export function createCliToolkit(): CliToolkit {
  return {
    runBroker,
    preflightCockpit,
    launchCockpit,
    detachCockpit,
    selectSession,
    worktreeSubject,
    openWorktreeInNvim,
    openCheckoutInNvim,
    createFleetNvimLayoutHooks,
    rebalanceNvimLayoutFromHook,
    openInteractiveShell,
    pruneLegacyTranscript,
    rebindClaudeTranscript: ({ sessionId, stateDirectory, payload }) =>
      runClaudeTranscriptRebind({
        sessionId,
        payload,
        store: new ClaudeConversationBindingStore(stateDirectory),
      }),
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
      launchEnvironment: jobLaunchEnvironment,
      workerMode: applyWorkerMode,
    }),
    new ClaudeJobDispatchAdapter(),
    new CursorJobDispatchAdapter(),
    new AntigravityJobDispatchAdapter(),
  ];
}

export async function runBroker(
  socketPath = brokerSocketPath,
  stateDirectory = appStateDirectory,
): Promise<BrokerServer> {
  await ensurePrivateDirectory(stateDirectory);
  const journal = new Journal(stateDirectory);
  const claudeConversations = new ClaudeConversationBindingStore(stateDirectory);
  const transcripts = new ThreadTranscriptStore(stateDirectory, { claudeConversations });
  await transcripts.init();
  const cliPath = resolve(dirname(fileURLToPath(import.meta.url)), "../cli.js");
  const mcp = { nodePath: process.execPath, cliPath };
  const config = loadBrokerRuntimeConfig(resolve(stateDirectory, "config.json"));
  const sessionStore = new SessionStore(stateDirectory);
  const fleetDetaches = new FleetDetachStore(stateDirectory);
  const fleetPreferences = new FleetPreferenceStore(stateDirectory);
  const fleetProjects = new FleetProjectService({ store: fleetPreferences, gitIn: gitOutputIn });
  const workerPreferences = new WorkerPreferenceStore(stateDirectory);
  const providerPermissions = new ProviderPermissionPreferenceStore(stateDirectory);
  const scoutReports = new ScoutReportStore(stateDirectory);
  const scoutEgress = new ScoutEgressGrantStore(stateDirectory);
  const recoveredSessions = await retainStartupThreads(
    {
      catalog: sessionStore,
      scoutReports,
      claudeBindings: transcripts,
    },
    config.threadRetention,
    Date.now(),
  );
  const registry = new SessionRegistry({
    adapters: {
      codex: new CodexProviderAdapter({ mcp }),
      claude: new ClaudeProviderAdapter({ mcp, stateDirectory }),
      cursor: new CursorProviderAdapter({ mcp }),
      antigravity: new AntigravityProviderAdapter(),
    },
    sessionRuntimeFactory: createSessionRuntime,
    workerTurnObservation: new WorkerTurnObservationAdapter(),
    journal,
    transcripts,
    store: sessionStore,
    recoveredSessions,
    scoutReports,
    worktreeProvisioner: new GitWorktreeProvisioner(),
    scoutWorkspaceState: captureScoutWorkspaceStateHash,
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
    createService: (store) => new WorkerCoordinationService({ store }),
  });
  await workerCoordination.start();
  // Shared discovery for worker launches, orchestrator creation, Fleet, and MCP capabilities.
  const workerCapabilities = new WorkerCapabilityCatalog();
  const orchestrators = new OrchestratorManager(
    registry,
    orchestratorStore,
    workerPreferences,
    providerPermissions,
    (provider) => workerCapabilities.resolve(provider),
  );
  const instructions = new InstructionQueue(registry, orchestratorStore, new InstructionStore(stateDirectory));
  instructions.start();
  const workerLeaseCredentials = new BrokerWorkerLeaseCredentialCustodian();
  const workerBudgets = new WorkerBudgetEnforcer({
    registry,
    coordination: workerCoordination.service,
    instructions,
    transcripts,
    credentials: workerLeaseCredentials,
  });
  registry.setWorkerBudgetGate(workerBudgets);
  await workerBudgets.start();
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
      workspaceProbe: new GitWorkspaceProbe(),
      workerCapabilities,
      workerBudgets,
    },
  );
  const workerControl = new WorkerControlService({
    coordination: workerCoordination.service,
    credentials: workerLeaseCredentials,
    registry,
    orchestrators: orchestratorStore,
    instructions,
  });
  // The same custodian the control service uses, so a handed-off lease is immediately usable by
  // the orchestrator that received it rather than reporting OWNERSHIP_LOST on its next call.
  const workerHandoff = new WorkerHandoffService({
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
    changes: worktreeChanges,
    notify: callNvim,
  });
  nvimBindings.start();
  const localWorkerControl = new LocalWorkerControlService({
    registry,
    budgets: workerCoordination.service,
  });

  // The control plane owns durable job state, admission, budgets, leases, and reconciliation. Its
  // runtime enforces the ordering: persistence, then recovery, then reconciliation, and only then is
  // admission opened. The B-owned dispatch adapters are composed in without being modified.
  const artifactStore = new ArtifactStore(stateDirectory);
  const runtime = new ControlPlaneRuntime({
    stateDirectory,
    config,
    journal,
    jobStore: new JobStore(stateDirectory),
    artifacts: artifactStore,
    leaseStore: new LeaseStore(stateDirectory),
    adapters: (context) =>
      composeJobDispatchAdapters({ leases: context.leases, artifacts: artifactStore }),
  });
  await runtime.start();

  let shuttingDown = false;
  let server: BrokerServer;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Admission stops first, then in-flight jobs drain and persist, then live sessions stop.
    await runtime.shutdown(reason);
    localWorkerControl.close();
    workerBudgets.close();
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
    workerCapabilities,
    scoutEgress,
    orchestratorBindings: orchestratorStore,
    workerCoordination: workerCoordination.service,
    workerControl,
    workerHandoff,
    workerEvents,
    nvimBindings,
    localWorkerControl,
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
