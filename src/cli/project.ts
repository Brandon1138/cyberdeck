import { Command } from "commander";
import { resolve } from "node:path";
import type { CliProgramContext } from "./program.js";

export function registerProjectCommands(program: Command, context: CliProgramContext): void {
  const { listProjects, addProject, removeProject } = context;
  const projectCommand = program.command("project")
    .description("manage the repositories the Fleet list groups threads under");
  projectCommand.command("list")
    .description("list registered projects")
    .action(async () => {
      const roots = await listProjects();
      process.stdout.write(roots.length === 0 ? "No registered projects\n" : `${roots.join("\n")}\n`);
    });
  projectCommand.command("add")
    .description("register a repository as a project")
    .argument("[path]", "path inside the repository (defaults to current directory)")
    .option("--parent", "when the path is a linked worktree, register its repository")
    .action(async (path: string | undefined, commandOptions: { parent?: boolean; }) => {
      const result = await addProject({
        path: resolve(path ?? process.cwd()),
        ...(commandOptions.parent === true ? { acceptParent: true } : {}),
      });
      if (result.status === "worktree") {
        process.stdout.write(
          `${result.toplevel} is a linked worktree of ${result.root}\n`
          + `Nothing was registered. Re-run with --parent to register ${result.root}\n`,
        );
        process.exitCode = 1;
        return;
      }
      process.stdout.write(
        `${result.alreadyRegistered ? "Already a project" : "Registered project"}: ${result.root}\n`,
      );
    });
  projectCommand.command("rm")
    .description("unregister a project; its threads become unregistered, nothing is deleted")
    .argument("[path]", "registered project root (defaults to current directory)")
    .action(async (path: string | undefined) => {
      const result = await removeProject({ path: resolve(path ?? process.cwd()) });
      process.stdout.write(
        result.removed
          ? `Removed project: ${result.root}\n`
          : `Not a registered project: ${result.root}\n`,
      );
      if (!result.removed) process.exitCode = 1;
    });

  // Cyberdeck creates worktrees automatically and removes them only here, on an explicit command.
  // The asymmetry is the retention policy: `retentionVerdict` decides what may go, and `--yes`
  // decides whether anything actually does. See docs/architecture/worktree-provisioning.md.
}


