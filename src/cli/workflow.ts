import { Command } from "commander";
import type { CliProgramContext } from "./program.js";
import { withClient } from "./runtime.js";

export function registerWorkflowCommands(program: Command, _context: CliProgramContext): void {
  const workflow = program.command("workflow").description("inspect or stop bounded orchestration workflows");
  workflow.command("list").action(async () => {
    const runs = await withClient((client) => client.request("workflow.list", {}));
    process.stdout.write(`${JSON.stringify(runs, null, 2)}\n`);
  });
  workflow.command("cancel")
    .argument("<run-id>", "workflow UUID")
    .option("--reason <reason>", "operator cancellation reason")
    .action(async (runId: string, options: { reason?: string; }) => {
      await withClient((client) => client.request("workflow.cancel", {
        runId,
        ...(options.reason === undefined ? {} : { reason: options.reason }),
      }));
    });
}

