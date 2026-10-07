import { dirname, extname, join } from "node:path";
import type { NoticeHookFormat } from "../domain/orchestrator-notice-file.js";
import { shellQuote } from "./shell-quote.js";

/** Seconds a provider waits for the notice hook. The hook reads two files; it measured well under 0.5 s. */
export const NOTICE_HOOK_TIMEOUT_SECONDS = 2;

export interface NoticeHookCommand {
  nodePath: string;
  /** The `cyberdeck` entry (`dist/src/cli.js`); the hook entry sits beside it under `cli/`. */
  cliPath: string;
  sessionId: string;
  stateDirectory: string;
  format: NoticeHookFormat;
  event: string;
}

/** `cli/notice-hook-entry.<ext>` next to the CLI entry, in whatever layout the broker runs from. */
export function noticeHookEntryPath(cliPath: string): string {
  return join(dirname(cliPath), "cli", `notice-hook-entry${extname(cliPath)}`);
}

/**
 * The exact command a provider runs after a tool call. Every argument is fixed at launch, as the
 * transcript hook's are: the session id is what makes the notice land in the right orchestrator
 * and nothing inside the conversation can change it.
 */
export function noticeHookCommandLine(command: NoticeHookCommand): string {
  return [
    command.nodePath,
    noticeHookEntryPath(command.cliPath),
    "--actor-session",
    command.sessionId,
    "--state-directory",
    command.stateDirectory,
    "--format",
    command.format,
    "--event",
    command.event,
  ].map(shellQuote).join(" ");
}
