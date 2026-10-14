import { Command } from "commander";
import { resolve } from "node:path";
import type { CliProgramContext } from "./program.js";

/**
 * The operator surface for the modal-answer ledger. Automated answering is on by default; `off`
 * switches one repository off and `on` switches it back. Deliberately CLI-only, like Scout egress:
 * no MCP tool can mutate the switch that decides whether an orchestrator may answer a worker's
 * trust or approval dialog.
 */
export function registerModalAnswerCommands(program: Command, context: CliProgramContext): void {
  const { modalAnswers } = context;
  const modalAnswersCommand = program.command("modal-answers")
    .description("switch automated provider modal answering off or back on per repository (on by default)");
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
