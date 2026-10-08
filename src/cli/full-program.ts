import { registerActivityCommands } from "./activity.js";
import { Command } from "commander";
import { spawnSync as processSpawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appStateDirectory } from "../broker/app-paths.js";
import type { FleetProjectAddResult, FleetProjectRemoveResult } from "../broker/fleet-project-service.js";
import {
  createCliToolkit,
  createFleetRuntimeDeps,
} from "../broker/main.js";
import { CYBERDECK_VERSION } from "../broker/version.js";
import type { ModalAnswerGrantStatus } from "../domain/modal-answer.js";
import type { CavemanWorkersResult, FableWorkersResult, PeerCreateResult } from "../domain/orchestrator.js";
import type { EventAck } from "../domain/worker-coordination.js";
import type { OrchestratorManagerResult, OrchestratorResetResult } from "../orchestration/orchestrator-manager.js";
import { registerBrokerCommands } from "./broker.js";
import { registerCockpitCommands } from "./cockpit.js";
import { registerEventCommands } from "./event.js";
import { registerMcpCommands } from "./mcp.js";
import { registerModalAnswerCommands } from "./modal-answers.js";
import { registerNotificationCommands } from "./notifications.js";
import { registerNvimLayoutCommands } from "./nvim-layout.js";
import { registerOrchestratorCommands } from "./orchestrator.js";
import type { CliProgramContext, CreateProgramOptions } from "./program.js";
import { registerProjectCommands } from "./project.js";
import { readAllStdin, restartDetachedBroker, runCyberdeck, withClient } from "./runtime.js";
import { registerScoutEgressCommands } from "./scout-egress.js";
import { registerSessionCommands } from "./session.js";
import type { ScoutEgressStatus, SpawnSyncLike } from "./toolkit.js";
import { registerTranscriptCommands } from "./transcript.js";
import { registerWorkflowCommands } from "./workflow.js";
import { registerWorktreeCommands } from "./worktree.js";
import { RpcError } from "../client/rpc-client.js";

export {
  openFleetCockpit,
  type FleetCockpitServices,
} from "./runtime.js";

export function createProgram(options: CreateProgramOptions = {}) {
  const toolkit = createCliToolkit();
  const fleetRuntimeDeps = createFleetRuntimeDeps();
  const runDefault = options.runDefault ?? (() => runCyberdeck(toolkit, fleetRuntimeDeps));
  const restartBroker = options.restartBroker ?? restartDetachedBroker;
  const runCockpitPreflight = options.preflightCockpit ?? toolkit.preflightCockpit;
  const presentCockpit = options.launchCockpit ?? toolkit.launchCockpit;
  const ensureOrchestrator = options.ensureOrchestrator ?? ((request) =>
    withClient((client) => client.request<OrchestratorManagerResult>("orchestrator.ensure", request)));
  const stopSession = options.stopSession ?? ((sessionId) =>
    withClient((client) => client.request<void>("session.stop", { sessionId })));
  const resetOrchestrator = options.resetOrchestrator ?? ((request) =>
    withClient((client) => client.request<OrchestratorResetResult>("orchestrator.reset", request)));
  const fableWorkers = options.fableWorkers ?? ((request) =>
    withClient((client) => client.request<FableWorkersResult>("orchestrator.fableWorkers", request)));
  const peerCreate = options.peerCreate ?? ((request) =>
    withClient((client) => client.request<PeerCreateResult>("orchestrator.peerCreate", request)));
  const cavemanWorkers = options.cavemanWorkers ?? ((request) =>
    withClient((client) => client.request<CavemanWorkersResult>("orchestrator.cavemanWorkers", request)));
  const pruneLegacyTranscript = options.pruneLegacyTranscript
    ?? (() => toolkit.pruneLegacyTranscript(appStateDirectory, true));
  const rebindClaudeTranscript = options.rebindClaudeTranscript
    ?? (async (request: { sessionId: string; stateDirectory: string }) =>
      toolkit.rebindClaudeTranscript({
        sessionId: request.sessionId,
        stateDirectory: request.stateDirectory,
        payload: await readAllStdin(),
      }));
  const submitWorkerEvent = options.submitWorkerEvent
    ?? ((request) => withClient((client) =>
      client.request<EventAck>("worker.event.submit", request)));
  const scoutEgress = options.scoutEgress
    ?? ((request: { root: string; enabled?: boolean }) =>
      withClient((client) => client.request<ScoutEgressStatus>("scout.egress", request)));
  const modalAnswers = options.modalAnswers
    ?? ((request: { root: string; enabled?: boolean }) =>
      withClient((client) => client.request<ModalAnswerGrantStatus>("modal.answers", request)));
  const rebalanceNvimLayout = options.rebalanceNvimLayout
    ?? ((windowId: string) => {
      toolkit.rebalanceNvimLayoutFromHook({
        spawnSync: processSpawnSync as SpawnSyncLike,
        windowId,
        cliPath: resolve(process.argv[1] ?? fileURLToPath(import.meta.url)),
      });
    });
  const listProjects = options.listProjects
    ?? (() => withClient((client) => client.request<string[]>("fleet.projects", {})));
  const addProject = options.addProject
    ?? ((request: { path: string; acceptParent?: boolean }) =>
      withClient((client) => client.request<FleetProjectAddResult>("fleet.project.add", request)));
  const removeProject = options.removeProject
    ?? ((request: { path: string }) =>
      withClient((client) => client.request<FleetProjectRemoveResult>("fleet.project.remove", request)));
  const readNotifications = options.readNotifications
    ?? ((request) => withClient((client) => client.request("agent.notifications.read", request)));
  const configureNotifications = options.configureNotifications
    ?? ((request) => withClient((client) => client.request("agent.notifications.configure", request)));
  const program = new Command()
    .name("cyberdeck")
    .version(CYBERDECK_VERSION)
    .description("Neutral broker for durable Claude and Codex terminal sessions")
    .addHelpText(
      "after",
      "\nExplicit operator-selected Fable starts are allowed. Autonomous Fable workers require the durable worker.start.fable grant."
      + "\nA Cursor Fable slug requires that same grant; every other Cursor model needs none.\n",
    )
    .action(runDefault);

  const context: CliProgramContext = {
    runDefault,
    restartBroker,
    runCockpitPreflight,
    presentCockpit,
    ensureOrchestrator,
    stopSession,
    resetOrchestrator,
    fableWorkers,
    peerCreate,
    cavemanWorkers,
    readNotifications,
    configureNotifications,
    pruneLegacyTranscript,
    rebindClaudeTranscript,
    submitWorkerEvent,
    scoutEgress,
    modalAnswers,
    rebalanceNvimLayout,
    listProjects,
    addProject,
    removeProject,
    toolkit,
    fleetRuntimeDeps,
  };
  registerActivityCommands(program);
  registerBrokerCommands(program, context);
  registerNvimLayoutCommands(program, context);
  registerProjectCommands(program, context);
  registerWorktreeCommands(program, context);
  registerScoutEgressCommands(program, context);
  registerModalAnswerCommands(program, context);
  registerNotificationCommands(program, context);
  registerEventCommands(program, context);
  registerTranscriptCommands(program, context);
  registerSessionCommands(program, context);
  registerMcpCommands(program, context);
  registerCockpitCommands(program, context);
  registerOrchestratorCommands(program, context);
  registerWorkflowCommands(program, context);
  return program;
}
