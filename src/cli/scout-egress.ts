import { Command } from "commander";
import { resolve } from "node:path";
import type { CliProgramContext } from "./program.js";

export function registerScoutEgressCommands(program: Command, context: CliProgramContext): void {
  const { scoutEgress } = context;
  const scoutEgressCommand = program.command("scout-egress")
    .description("manage durable exact-repository Cursor Scout source egress");
  scoutEgressCommand.command("status")
    .option("--root <absolute-path>", "exact Git repository root (defaults to current directory)")
    .action(async (options: { root?: string; }) => {
      const result = await scoutEgress({ root: resolve(options.root ?? process.cwd()) });
      process.stdout.write(
        `Scout egress: ${result.enabled ? "ON" : "OFF"} · Cursor Composer · read-only · ${result.root}\n`,
      );
    });
  for (const enabled of [true, false] as const) {
    scoutEgressCommand.command(enabled ? "on" : "off")
      .requiredOption("--root <absolute-path>", "exact Git repository root")
      .action(async (options: { root: string; }) => {
        const result = await scoutEgress({
          root: resolve(options.root),
          enabled,
        });
        process.stdout.write(
          `Scout egress: ${result.enabled ? "ON" : "OFF"} · Cursor Composer · read-only · ${result.root}\n`,
        );
      });
  }

}


