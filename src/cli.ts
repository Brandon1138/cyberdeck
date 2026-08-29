#!/usr/bin/env node

import { Command } from "commander";
import { spawnSync as processSpawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appStateDirectory } from "./broker/app-paths.js";
import type { FleetProjectAddResult, FleetProjectRemoveResult } from "./broker/fleet-project-service.js";
import {
  createCliToolkit,
  createFleetRuntimeDeps,
} from "./broker/main.js";
import { CYBERDECK_VERSION } from "./broker/version.js";
import type { CavemanWorkersResult, FableWorkersResult } from "./domain/orchestrator.js";
import type { EventAck } from "./domain/worker-coordination.js";
import type { OrchestratorManagerResult, OrchestratorResetResult } from "./orchestration/orchestrator-manager.js";
import { registerBrokerCommands } from "./cli/broker.js";
import { registerCockpitCommands } from "./cli/cockpit.js";
import { registerEventCommands } from "./cli/event.js";
import { registerMcpCommands } from "./cli/mcp.js";
import { registerNvimLayoutCommands } from "./cli/nvim-layout.js";
import { registerOrchestratorCommands } from "./cli/orchestrator.js";
import type { CliProgramContext, CreateProgramOptions } from "./cli/program.js";
import { registerProjectCommands } from "./cli/project.js";
import { readAllStdin, restartDetachedBroker, runCyberdeck, withClient } from "./cli/runtime.js";
import { registerScoutEgressCommands } from "./cli/scout-egress.js";
import { registerSessionCommands } from "./cli/session.js";
import type { ScoutEgressStatus, SpawnSyncLike } from "./cli/toolkit.js";
import { registerTranscriptCommands } from "./cli/transcript.js";
import { registerWorkflowCommands } from "./cli/workflow.js";
import { registerWorktreeCommands } from "./cli/worktree.js";
import { RpcError } from "./client/rpc-client.js";

export {
  openFleetCockpit,
  type FleetCockpitServices,
} from "./cli/runtime.js";

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
    cavemanWorkers,
    pruneLegacyTranscript,
    rebindClaudeTranscript,
    submitWorkerEvent,
    scoutEgress,
    rebalanceNvimLayout,
    listProjects,
    addProject,
    removeProject,
    toolkit,
    fleetRuntimeDeps,
  };
  registerBrokerCommands(program, context);
  registerNvimLayoutCommands(program, context);
  registerProjectCommands(program, context);
  registerWorktreeCommands(program, context);
  registerScoutEgressCommands(program, context);
  registerEventCommands(program, context);
  registerTranscriptCommands(program, context);
  registerSessionCommands(program, context);
  registerMcpCommands(program, context);
  registerCockpitCommands(program, context);
  registerOrchestratorCommands(program, context);
  registerWorkflowCommands(program, context);
  return program;
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
const isMainModule = invokedPath !== undefined
  && realpathSync(invokedPath) === realpathSync(fileURLToPath(import.meta.url));
if (isMainModule) {
  await createProgram().parseAsync().catch((error) => {
    const prefix = error instanceof RpcError ? `${error.code}: ` : "";
    process.stderr.write(`${prefix}${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
