import { Command } from "commander";
import type { CliProgramContext } from "./program.js";

export function registerNvimLayoutCommands(program: Command, context: CliProgramContext): void {
  const { rebalanceNvimLayout } = context;
  const nvimLayout = program.command("nvim-layout")
    .description("internal tmux nvim layout maintenance");
  nvimLayout.command("rebalance")
    .description("quietly rebalance one Fleet window")
    .requiredOption("-w, --window <window-id>", "tmux window id")
    .action(async (options: { window: string; }) => {
      await rebalanceNvimLayout(options.window);
    });

  // The registry the Fleet list groups by. Paths are resolved against the shell's cwd here and
  // against git in the broker, so `cyberdeck project add .` inside a repository is the short form.
}


