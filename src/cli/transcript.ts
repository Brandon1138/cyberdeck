import { Command } from "commander";
import { appStateDirectory } from "../broker/app-paths.js";
import type { CliProgramContext } from "./program.js";
import type { ClaudeTranscriptRebindOutcome } from "./toolkit.js";

export function registerTranscriptCommands(program: Command, context: CliProgramContext): void {
  const { pruneLegacyTranscript, rebindClaudeTranscript } = context;
  const transcript = program.command("transcript").description("manage local transcript retention");
  transcript.command("prune-legacy")
    .description("permanently delete the pre-semantic raw PTY transcript")
    .requiredOption(
      "--confirm-delete-legacy-transcript",
      "confirm permanent deletion of threads/transcript.jsonl",
    )
    .action(async () => {
      const result = await pruneLegacyTranscript();
      process.stdout.write(result.removed
        ? `Deleted legacy transcript ${result.path}\n`
        : `No legacy transcript exists at ${result.path}\n`);
    });
  transcript.command("rebind")
    .description("record where a Claude session's conversation moved (SessionStart hook)")
    .requiredOption("--actor-session <session-id>", "Cyberdeck session UUID fixed at launch")
    .option("--state-directory <path>", "Cyberdeck state directory", appStateDirectory)
    .action(async (rebindOptions: { actorSession: string; stateDirectory: string; }) => {
      // Runs inside the operator's own session. A hook that throws is a hook that interrupts a
      // worker, and a rebind that never lands already fails closed in the transcript store.
      const outcome = await rebindClaudeTranscript({
        sessionId: rebindOptions.actorSession,
        stateDirectory: rebindOptions.stateDirectory,
      }).catch((error: unknown) => {
        process.stderr.write(`cyberdeck transcript rebind: ${String(error)}\n`);
        return { recorded: false, reason: "unreadable-payload" } as ClaudeTranscriptRebindOutcome;
      });
      if (!outcome.recorded) {
        process.stderr.write(`cyberdeck transcript rebind: ${outcome.reason}\n`);
      }
    });

}

