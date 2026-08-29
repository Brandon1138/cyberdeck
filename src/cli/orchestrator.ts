import { Command, Option } from "commander";
import { resolve } from "node:path";
import type { CliProgramContext } from "./program.js";

export function registerOrchestratorCommands(program: Command, context: CliProgramContext): void {
  const { resetOrchestrator, fableWorkers, cavemanWorkers } = context;
  const orchestrator = program.command("orchestrator").description("manage durable orchestrator bindings");
  orchestrator.command("reset")
    .description("invalidate an inactive fleet or workspace orchestrator binding")
    .option("--cwd <absolute-path>", "workspace path (defaults to the current directory)")
    .addOption(new Option("--scope <scope>").choices(["workspace", "fleet"]).default("fleet"))
    .action(async (options: { cwd?: string; scope: "workspace" | "fleet"; }) => {
      const result = await resetOrchestrator({
        cwd: resolve(options.cwd ?? process.cwd()),
        scope: options.scope,
      });
      if (result.reset) {
        process.stdout.write(`Reset orchestrator binding ${result.key} (${result.sessionId ?? "unknown session"})\n`);
      } else {
        process.stdout.write(`No orchestrator binding exists for ${result.key}\n`);
      }
    });

  orchestrator.command("fable-workers")
    .description("inspect or change delegated Fable access for one orchestrator binding")
    .argument("[mode]", "status, on, or off", "status")
    .option("--cwd <absolute-path>", "workspace path (defaults to the current directory)")
    .addOption(new Option("--scope <scope>").choices(["workspace", "fleet"]).default("fleet"))
    .action(async (mode: string, options: { cwd?: string; scope: "workspace" | "fleet"; }) => {
      if (mode !== "status" && mode !== "on" && mode !== "off") {
        throw new Error("mode must be status, on, or off");
      }
      const result = await fableWorkers({
        cwd: resolve(options.cwd ?? process.cwd()),
        scope: options.scope,
        ...(mode === "status" ? {} : { enabled: mode === "on" }),
      });
      if (!result.configured) {
        process.stdout.write(`Fable workers: OFF · no orchestrator bound for ${result.key}\n`);
        return;
      }
      process.stdout.write(
        `Fable workers: ${result.enabled ? "ON" : "OFF"} · ${result.key} · ${result.sessionId}\n`,
      );
    });

  orchestrator.command("caveman-workers")
    .description("inspect or change the box default for subsequently started orchestrator-spawned workers")
    .argument("[mode]", "status, on, or off", "status")
    .action(async (mode: string) => {
      if (mode !== "status" && mode !== "on" && mode !== "off") {
        throw new Error("mode must be status, on, or off");
      }
      const result = await cavemanWorkers({
        ...(mode === "status" ? {} : { enabled: mode === "on" }),
      });
      process.stdout.write(
        `Caveman workers: ${result.enabled ? "ON" : "OFF"} · box default · orchestrator-spawned workers\n`,
      );
    });

}


