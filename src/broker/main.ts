import { brokerEvaluationRuntime } from "../runtime/resources/broker-evaluation-runtime.js";
import { brokerParkingRuntime } from "../runtime/resources/broker-parking-runtime.js";
import { brokerResourceActivity } from "../runtime/resources/broker-resource-activity.js";
import { InstructionParkingReadModel } from "../orchestration/instruction-parking-read-model.js";
import { brokerAuxiliaryRuntime } from "../runtime/resources/broker-auxiliary-runtime.js";
import { auxiliaryProfileAuthorizer } from "./auxiliary-profile-authority.js";
import { brokerResourceRuntime } from "../runtime/resources/broker-resource-runtime.js";
import { orchestratorController } from "../domain/orchestrator.js";
import { ContainerNativeSource } from "../runtime/activity/container-native-source.js";
import { TurnNativeCapture } from "../runtime/activity/turn-native-capture.js";
import { ExecutionTranscriptStore } from "../persistence/execution-transcript-store.js";
import { brokerExecutionRuntime } from "../runtime/execution/broker-execution-runtime.js";
import { SentrySink } from "../observability/sentry-sink.js";
import { withActivitySink, type ActivitySinkPort } from "../orchestration/activity-sink.js";
import { openActivityRecorder } from "../persistence/agent-activity-store.js";
import { activityInstructionStore } from "../orchestration/activity-instruction-store.js";
import { composeJobDispatchAdapters as composeRuntimeJobAdapters } from "../runtime/job-dispatch-composition.js";
import { AppServerJobDispatchAdapter } from "../app-server/dispatch-adapter.js";
import type { WorktreeLeaseManager } from "../control-plane/worktree-lease-manager.js";
import { jobLaunchEnvironment } from "../providers/launch-environment.js";
import { applyWorkerMode } from "../providers/worker-mode.js";
import { ResourceJobLaunch } from "../orchestration/resource-job-launch.js";
import { resourceJobRecord } from "../orchestration/resource-job-record.js";
import { createHash, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ControlPlaneRuntime } from "../control-plane/runtime.js";
import { ArtifactStore } from "../persistence/artifact-store.js";
import { JobStore } from "../persistence/job-store.js";
import { LeaseStore } from "../persistence/lease-store.js";
import type { BrokerEvent } from "../domain/events.js";
import { appStateDirectory, brokerSocketPath } from "../paths.js";
import { AntigravityProviderAdapter } from "../providers/antigravity/session-adapter.js";
import { ClaudeProviderAdapter } from "../providers/claude.js";
import { ClaudeWorkspaceTrust } from "../providers/claude/workspace-trust.js";
import { CodexProviderAdapter } from "../providers/codex.js";
import { CodexWorkspaceTrust } from "../providers/codex/workspace-trust.js";
import { CursorProviderAdapter } from "../providers/cursor/session-adapter.js";
import { captureScoutWorkspaceStateHash } from "../providers/cursor/workspace-state.js";
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
import { CodexOrchestratorModelProbe } from "../providers/codex-orchestrator-model-probe.js";
import { InstructionQueue } from "../orchestration/instruction-queue.js";
import { LocalWorkerControlService } from "../orchestration/local-worker-control-service.js";
import { WorkerBudgetEnforcer } from "./worker-budget-enforcer.js";
import { WorkerControlService } from "../orchestration/worker-control-service.js";
import { WorkerHandoffService } from "../orchestration/worker-handoff-service.js";
import { activityCoordinationStore } from "../orchestration/activity-coordination-store.js";
import { InstructionStore } from "../persistence/instruction-store.js";
import { WorkflowStore } from "../persistence/workflow-store.js";
import { WorkflowService } from "../orchestration/workflow-service.js";
import { loadBrokerRuntimeConfig } from "../runtime-config.js";
import { retainStartupThreads } from "../orchestration/startup-thread-retention.js";
import { ScoutReportStore } from "../persistence/scout-report-store.js";
import { ScoutEgressGrantStore } from "../persistence/scout-egress-grant-store.js";
import { ModalAnswerGrantStore } from "../persistence/modal-answer-grant-store.js";
import { ModalAnswerPolicy } from "../orchestration/modal-answer-policy.js";
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

export function composeJobDispatchAdapters(context: Omit<Parameters<typeof composeRuntimeJobAdapters>[0], "codex"> & {
  leases: WorktreeLeaseManager; artifacts: ArtifactStore;
}) {
  return composeRuntimeJobAdapters({ ...context, codex: new AppServerJobDispatchAdapter({
    leaseManager: context.leases, artifactStore: context.artifacts,
    launchEnvironment: jobLaunchEnvironment, workerMode: applyWorkerMode,
    ...(context.resourceLaunch ? { resourceLaunch: context.resourceLaunch } : {}),
  }) });
}

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

export async function runBroker(
  socketPath = brokerSocketPath,
  stateDirectory = appStateDirectory,
): Promise<BrokerServer> {
  await ensurePrivateDirectory(stateDirectory);
  const journal = new Journal(stateDirectory);
  const localActivity = await openActivityRecorder(resolve(stateDirectory, "activity"));
  const claudeConversations = new ClaudeConversationBindingStore(stateDirectory);
  let registry: SessionRegistry;
  const containerNativeSource = new ContainerNativeSource(resolve(stateDirectory, "containers"));
  const transcripts = new ExecutionTranscriptStore(stateDirectory, { claudeConversations }, containerNativeSource, (id) => {
    try { return registry?.get(id); } catch { return undefined; }
  });
  await transcripts.init();
  const cliPath = resolve(dirname(fileURLToPath(import.meta.url)), "../cli.js");
  const mcp = { nodePath: process.execPath, cliPath };
  const config = loadBrokerRuntimeConfig(resolve(stateDirectory, "config.json"));
  let sentry: SentrySink | undefined;
  let telemetry: ActivitySinkPort | undefined;
  if (config.sentry?.enabled === true) {
    try {
      sentry = new SentrySink({ enabled: true, dsn: config.sentry.dsn!, dailyCap: config.sentry.dailyEnvelopeCap!,
        sampleRate: config.sentry.sampleRate, budgetStateFile: resolve(stateDirectory, "activity", "telemetry-budget.json") });
      telemetry = sentry;
    } catch {
      telemetry = { record: () => {}, health: () => ({ enabled: false, degraded: true, code: "TELEMETRY_INITIALIZATION_FAILED" }) };
    }
  }
  const activity = withActivitySink(localActivity, telemetry);
  const instructionStore = new InstructionStore(stateDirectory);
  const jobStore = new JobStore(stateDirectory);
  let evaluationRuntime: Awaited<ReturnType<typeof brokerEvaluationRuntime>> | undefined;
  let auxiliaryRuntime: Awaited<ReturnType<typeof brokerAuxiliaryRuntime>> | undefined;
  let parkingRuntime: Awaited<ReturnType<typeof brokerParkingRuntime>> | undefined;
  const instructionFacts = config.resourceManagement ? new InstructionParkingReadModel(await instructionStore.list()) : undefined;
  const sessionStore = new SessionStore(stateDirectory);
  const fleetDetaches = new FleetDetachStore(stateDirectory);
  const fleetPreferences = new FleetPreferenceStore(stateDirectory);
  const fleetProjects = new FleetProjectService({ store: fleetPreferences, gitIn: gitOutputIn });
  const workerPreferences = new WorkerPreferenceStore(stateDirectory);
  const providerPermissions = new ProviderPermissionPreferenceStore(stateDirectory);
  const scoutReports = new ScoutReportStore(stateDirectory);
  const scoutEgress = new ScoutEgressGrantStore(stateDirectory);
  const modalAnswerGrants = new ModalAnswerGrantStore(stateDirectory);
  const modalAnswerPolicy = new ModalAnswerPolicy({
    grants: modalAnswerGrants,
    probe: new GitWorkspaceProbe(),
    resolveSessionCwd: (id, cwd) => executionRuntime.modalCwd(id, cwd),
  });
  // Provision-time avoidance: a worker spawned into a granted repository (or one of its linked
  // worktrees) has its cwd written into the provider's own trust store before the process exists,
  // so the folder-trust dialog never appears. Ungranted repositories keep today's behavior.
  const claudeTrust = new ClaudeWorkspaceTrust();
  const codexTrust = new CodexWorkspaceTrust();
  const grantGatedTrust = (writer: { trust(cwd: string): Promise<string> }) =>
    async (cwd: string): Promise<void> => {
      if (await modalAnswerPolicy.allowsWorkspaceTrust(cwd)) await writer.trust(cwd);
    };
  const recoveredSessions = await retainStartupThreads(
    {
      catalog: sessionStore,
      scoutReports,
      claudeBindings: transcripts,
    },
    config.threadRetention,
    Date.now(),
  );
  const orchestratorStore = new OrchestratorStore(stateDirectory);
  let workerCoordination: WorkerCoordinationRuntime<WorkerCoordinationService>;
  let resourceRuntime: Awaited<ReturnType<typeof brokerResourceRuntime>>;
  let workerEvents: WorkerEventChannel;
  const executionRuntime = await brokerExecutionRuntime({ stateDirectory, config, activity,
    ...(config.resourceManagement?.auxiliaryProfiles ? { profileRequest: async (binding, request) => {
      if (!auxiliaryRuntime) throw new Error("AUXILIARY_RUNTIME_UNAVAILABLE");
      return auxiliaryRuntime.request(binding, request);
    } } : {}),
    ...(config.resourceManagement ? { grantedEnvelope: (input) => {
      if (!resourceRuntime) throw new Error("RESOURCE_RUNTIME_UNAVAILABLE");
      return resourceRuntime.envelope(input.record, input.identity.generation);
    } } : {}),
    allowsWorkspaceTrust: (source) => modalAnswerPolicy.allowsWorkspaceTrust(source),
    adapters: { codex: new CodexProviderAdapter({ mcp, workspaceTrust: grantGatedTrust(codexTrust) }),
      claude: new ClaudeProviderAdapter({ mcp, stateDirectory, workspaceTrust: grantGatedTrust(claudeTrust) }),
      cursor: new CursorProviderAdapter({ mcp }), antigravity: new AntigravityProviderAdapter() },
    lookupSession: (id) => { try { return registry?.get(id); } catch { return undefined; } },
    submitEvent: (input) => workerEvents.submit(input),
  });
  resourceRuntime = await brokerResourceRuntime({ config, brokerId: executionRuntime.brokerId,
    execution: executionRuntime.execution,
    captureHold: () => auxiliaryRuntime?.admissionHold() ?? (evaluationRuntime ? evaluationRuntime.admissionHold() : "evaluation-capture-gap"),
    resolveFamily: async (record) => {
      const lease = workerCoordination?.service.getSubject(record.id)?.lease
        ?? (record.parentSessionId ? workerCoordination?.service.getSubject(record.parentSessionId)?.lease : undefined);
      if (lease?.controller) return lease.controller.familyId;
      const binding = await orchestratorStore.findBySessionId(record.kind === "orchestrator" ? record.id : record.parentSessionId ?? record.id);
      if (binding) return orchestratorController(binding).familyId;
      if (record.kind === "orchestrator" || record.parentSessionId) throw new Error("RESOURCE_CANONICAL_FAMILY_UNAVAILABLE");
      // Operator-launched sessions have no controller grant; this is a scheduling bucket only.
      return "operator";
    },
  });
  // The installation owner lock precedes every evaluation-store mutation and replay timer.
  if (config.resourceManagement) {
    try {
      evaluationRuntime = await brokerEvaluationRuntime({ directory: config.resourceManagement.directory,
        instructionSourceId: createHash("sha256").update(config.resourceManagement.installationId + "\0" + instructionStore.path).digest("hex"), activity, instructions: () => instructionStore.list(), instructionVersion: () => instructionStore.version(), jobs: jobStore,
        ...(resourceRuntime ? { execution: { config, resource: resourceRuntime } } : {}) });
    } catch (error) {
      await resourceRuntime?.close();
      throw error;
    }
  }
  registry = new SessionRegistry({
    ...(resourceRuntime ? { resourceExecution: resourceRuntime.gate } : {}),
    adapters: executionRuntime.adapters,
    sessionRuntimeFactory: createSessionRuntime,
    executions: executionRuntime.executions,
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
  workerCoordination = new WorkerCoordinationRuntime({
    stateDirectory,
    recoveredSessions,
    orchestrators: orchestratorStore,
    createService: (store) => new WorkerCoordinationService({ store: activityCoordinationStore(store, activity) }),
  });
  await workerCoordination.start();
  // Each launch context has its own cached catalog; orchestrators force first-party Codex.
  const workerCapabilities = new WorkerCapabilityCatalog();
  const orchestratorCapabilities = new WorkerCapabilityCatalog({ probe: new CodexOrchestratorModelProbe() });
  const orchestrators = new OrchestratorManager(
    registry,
    orchestratorStore,
    workerPreferences,
    providerPermissions,
    (provider) => orchestratorCapabilities.resolve(provider),
  );
  const nativeCapture = new TurnNativeCapture(resolve(stateDirectory, "activity", "native-cursors"), activity, transcripts, instructionStore);
  transcripts.attachNativeCapture(nativeCapture);
  const instructions = new InstructionQueue(registry, orchestratorStore, activityInstructionStore(instructionStore, activity, (id) => {
    try { return registry.get(id); } catch { return undefined; }
  }, (record, worker) => nativeCapture.captureInstruction(record, worker), instructionFacts));
  const workerLeaseCredentials = new BrokerWorkerLeaseCredentialCustodian();
  const workerBudgets = new WorkerBudgetEnforcer({
    registry,
    coordination: workerCoordination.service,
    instructions,
    transcripts,
    credentials: workerLeaseCredentials,
  });
  registry.setWorkerBudgetGate(workerBudgets);
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
    modalPolicy: modalAnswerPolicy,
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
  workerEvents = new WorkerEventChannel(
    workerCoordination.service,
    registry,
    orchestratorStore,
    instructions,
    undefined,
    workerLeaseCredentials,
  );
  if (resourceRuntime && config.resourceManagement && instructionFacts) {
    parkingRuntime = await brokerParkingRuntime({ directory: resolve(config.resourceManagement.directory, "parking"),
      assertOwner: resourceRuntime.assertOwner, registry, transcripts, coordination: workerCoordination.service,
      instructions, instructionFacts, inFlightReports: id => workerEvents.inFlightReports(id), ...config.resourceManagement.parking });
  }
  if (resourceRuntime && config.resourceManagement?.auxiliaryProfiles) {
    auxiliaryRuntime = await brokerAuxiliaryRuntime({ config, resource: resourceRuntime, activity,
      authorize: auxiliaryProfileAuthorizer({ brokerId: executionRuntime.brokerId, session: id => registry.get(id),
        coordination: workerCoordination.service, credentials: workerLeaseCredentials,
        instructions: id => instructionStore.list(id) }) });
  }
  await resourceRuntime?.completeRecovery();
  instructions.start();
  await workerBudgets.start();
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
  const resourceLaunch = resourceRuntime ? new ResourceJobLaunch({ gate: resourceRuntime.gate,
    resolveRecord: request => resourceJobRecord(runtime.controlPlane.dispatchContext(request.jobId), request) }) : undefined;
  const runtime: ControlPlaneRuntime = new ControlPlaneRuntime({
    stateDirectory,
    config,
    journal,
    jobStore,
    artifacts: artifactStore,
    leaseStore: new LeaseStore(stateDirectory),
    adapters: (context) =>
      composeJobDispatchAdapters({ leases: context.leases, artifacts: artifactStore, executionPolicy: config.workerExecution,
        resourceManaged: resourceRuntime !== undefined, ...(resourceLaunch ? { resourceLaunch } : {}) }),
  });
  await runtime.start();
  const resourceActivity = resourceRuntime && config.resourceManagement ? await brokerResourceActivity({
    directory: config.resourceManagement.directory, installationId: config.resourceManagement.installationId,
    brokerId: executionRuntime.brokerId, activity, resource: resourceRuntime,
    parked: () => parkingRuntime?.health().records.filter(r => r.phase === "parked").length ?? 0 }) : undefined;

  let shuttingDown = false;
  let server: BrokerServer;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Admission stops first, then in-flight jobs drain and persist, then live sessions stop.
    resourceRuntime?.drain();
    await runtime.shutdown(reason);
    await Promise.all([resourceRuntime?.closeAdmission(), executionRuntime.closeAdmission()]);
    await parkingRuntime?.close();
    localWorkerControl.close();
    workerBudgets.close();
    instructions.stop();
    nvimBindings.stop();
    await executionRuntime.closeAdmission();
    await registry.stopAll();
    await executionRuntime.close();
    await auxiliaryRuntime?.close();
    await resourceActivity?.close();
    await evaluationRuntime?.close();
    await resourceRuntime?.close();
    await sentry?.close().catch(() => undefined);
    await journal.append(brokerEvent("broker.shutdown", { reason, pid: process.pid }));
    await server.close();
  };

  server = new BrokerServer({
    activity, executionHealth: executionRuntime.health,
    ...(resourceRuntime ? { resourceHealth: () => ({ ...resourceRuntime.health(), activity: resourceActivity?.health() }),
      resourceDrain: () => { resourceRuntime!.drain(); runtime.scheduler.closeAdmission(); return resourceRuntime!.health(); } } : {}),
    ...(auxiliaryRuntime ? { auxiliaryHealth: auxiliaryRuntime.health } : {}),
    ...(parkingRuntime ? { parkingHealth: parkingRuntime.health } : {}),
    ...(evaluationRuntime ? { evaluationHealth: evaluationRuntime.health } : {}),
    renewExecutionAttempt: async (input) => {
      const lease = workerCoordination.service.getSubject(input.sessionId)?.lease;
      if (lease?.state !== "active" || lease.version !== input.leaseVersion || lease.expiresAt !== input.leaseExpiresAt
        || lease.controller?.controllerId !== input.controllerId || Date.parse(lease.expiresAt) <= Date.now()) return "not-running";
      return executionRuntime.executions.renewAttempt(input.sessionId, input.leaseExpiresAt);
    },
    ...(telemetry === undefined ? {} : { telemetry }),
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
    modalAnswerGrants,
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
