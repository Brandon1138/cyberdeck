import { Command } from "commander";
import { resolve } from "node:path";
import { GitWorktreeInventory, retentionVerdict } from "../orchestration/worktree-inventory.js";
import type { CliProgramContext } from "./program.js";
import { liveSessionCwds } from "./runtime.js";

export function registerWorktreeCommands(program: Command, _context: CliProgramContext): void {
  const worktreeCommand = program.command("worktree")
    .description("inspect and reclaim the worktrees Cyberdeck provisioned for workers");
  worktreeCommand.command("list")
    .description("list Cyberdeck-provisioned worktrees of a repository and their retention verdict")
    .argument("[path]", "path inside the repository (defaults to current directory)")
    .option("--json", "print machine-readable JSON")
    .action(async (path: string | undefined, options: { json?: boolean; }) => {
      const inventory = new GitWorktreeInventory({ liveSessions: await liveSessionCwds() });
      const worktrees = await inventory.list(resolve(path ?? process.cwd()));
      const rows = worktrees.map((worktree) => ({ worktree, verdict: retentionVerdict(worktree) }));
      if (options.json === true) {
        process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
        return;
      }
      if (rows.length === 0) {
        process.stdout.write("No Cyberdeck-provisioned worktrees\n");
        return;
      }
      for (const { worktree, verdict } of rows) {
        process.stdout.write(
          `${verdict.keep ? "keep " : "prune"} ${worktree.path} ${worktree.branch ?? "detached"} (${verdict.reason})\n`,
        );
      }
    });
  worktreeCommand.command("prune")
    .description("remove Cyberdeck-provisioned worktrees that the retention policy clears")
    .argument("[path]", "path inside the repository (defaults to current directory)")
    .option("--yes", "actually remove; without it this prints the plan and changes nothing")
    .action(async (path: string | undefined, options: { yes?: boolean; }) => {
      const inventory = new GitWorktreeInventory({ liveSessions: await liveSessionCwds() });
      const worktrees = await inventory.list(resolve(path ?? process.cwd()));
      let removable = 0;
      for (const worktree of worktrees) {
        const verdict = retentionVerdict(worktree);
        if (verdict.keep) {
          process.stdout.write(`kept    ${worktree.path} (${verdict.reason})\n`);
          continue;
        }
        removable += 1;
        if (options.yes !== true) {
          process.stdout.write(
            `would remove ${worktree.path}${verdict.removeBranch ? ` and branch ${worktree.branch ?? ""}` : ""} (${verdict.reason})\n`,
          );
          continue;
        }
        try {
          await inventory.remove(worktree, verdict.removeBranch);
          process.stdout.write(`removed ${worktree.path}\n`);
        } catch (error) {
          process.stdout.write(`failed  ${worktree.path}: ${(error as Error).message}\n`);
          process.exitCode = 1;
        }
      }
      if (removable > 0 && options.yes !== true) {
        process.stdout.write(`Nothing was removed. Re-run with --yes to reclaim ${removable}.\n`);
      }
    });

}


