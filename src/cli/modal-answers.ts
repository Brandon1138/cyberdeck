import { Command } from "commander";
import { resolve } from "node:path";
import type { CliProgramContext } from "./program.js";

/**
 * The operator surface for the modal-answer grant ledger. Deliberately CLI-only, like Scout
 * egress: no MCP tool can mutate the grants that decide whether an orchestrator may answer a
 * worker's trust or approval dialog.
 */
export function registerModalAnswerCommands(program: Command, context: CliProgramContext): void {
  const { modalAnswers } = context;
  const modalAnswersCommand = program.command("modal-answers")
    .description("manage durable per-repository grants for automated provider modal answering");
  modalAnswersCommand.command("status")
    .option("--root <absolute-path>", "exact Git repository root (defaults to current directory)")
    .action(async (options: { root?: string }) => {
      const result = await modalAnswers({ root: resolve(options.root ?? process.cwd()) });
      process.stdout.write(
        `Modal answers: ${result.enabled ? "ON" : "OFF"} · trust + policy-permitted prompts · ${result.root}\n`,
      );
    });
  for (const enabled of [true, false] as const) {
    modalAnswersCommand.command(enabled ? "on" : "off")
      .requiredOption("--root <absolute-path>", "exact Git repository root")
      .action(async (options: { root: string }) => {
        const result = await modalAnswers({
          root: resolve(options.root),
          enabled,
        });
        process.stdout.write(
          `Modal answers: ${result.enabled ? "ON" : "OFF"} · trust + policy-permitted prompts · ${result.root}\n`,
        );
      });
  }
}
