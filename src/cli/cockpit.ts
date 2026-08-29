import { Command, Option } from "commander";
import { brokerSocketPath } from "../broker/app-paths.js";
import { runDashboard } from "../client/dashboard.js";
import { RpcClient } from "../client/rpc-client.js";
import { type ProviderId } from "../domain/provider-registration.js";
import type { ReasoningEffort } from "../domain/session.js";
import type { CliProgramContext } from "./program.js";
import { openCockpit, parseOrchestratorProvider } from "./runtime.js";

export function registerCockpitCommands(program: Command, context: CliProgramContext): void {
  const { runDefault, runCockpitPreflight, presentCockpit, ensureOrchestrator, stopSession } = context;
  program.command("dashboard").action(runDefault);

  program.command("diagnostics").action(async () => {
    const client = await RpcClient.connect(brokerSocketPath);
    await runDashboard(client);
  });

  program.command("cockpit")
    .option("--orchestrator <provider>", "explicit orchestrator provider", parseOrchestratorProvider)
    .option("--model <model>", "explicit orchestrator model")
    .addOption(new Option("--effort <effort>", "explicit orchestrator reasoning effort")
      .choices(["low", "medium", "high", "xhigh", "max", "ultra"]))
    .addOption(new Option("--scope <scope>").choices(["workspace", "fleet"]).default("fleet"))
    .action(async (options: { orchestrator?: ProviderId; model?: string; effort?: ReasoningEffort; scope: "workspace" | "fleet"; }) => {
      const cwd = process.cwd();
      await openCockpit({
        cwd,
        scope: options.scope,
        ...(options.orchestrator === undefined ? {} : { provider: options.orchestrator }),
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.effort === undefined ? {} : { effort: options.effort }),
      }, {
        preflight: runCockpitPreflight,
        ensure: ensureOrchestrator,
        stop: stopSession,
        present: presentCockpit,
      });
    });

}

