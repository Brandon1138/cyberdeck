import { Command, Option } from "commander";
import { appStateDirectory } from "../broker/app-paths.js";
import { NoticeHookFormatSchema, type NoticeHookFormat } from "../domain/orchestrator-notice-file.js";
import { runNoticeHook } from "./notice-hook.js";
import type { CliProgramContext } from "./program.js";

export { orchestratorNoticeDirectory, runNoticeHook } from "./notice-hook.js";

export function registerNotificationCommands(program: Command, context: CliProgramContext): void {
  const { readNotifications, configureNotifications } = context;
  const notifications = program.command("notifications")
    .description("orchestrator notification feed: provider hook notice, drain, policy");
  notifications.command("notice")
    .description("print the pending notice for one orchestrator session as provider hook JSON (hook command)")
    .requiredOption("--actor-session <session-id>", "Cyberdeck orchestrator session UUID fixed at launch")
    .option("--state-directory <path>", "Cyberdeck state directory", appStateDirectory)
    .addOption(new Option("--format <format>").choices(NoticeHookFormatSchema.options).default("claude"))
    .option("--hook-event <name>", "hook event name echoed in the Claude/Codex envelope", "PostToolUse")
    .action(async (options: { actorSession: string; stateDirectory: string; format: NoticeHookFormat; hookEvent: string }) => {
      // Never throws and never exits non-zero: this runs inside the orchestrator's own session.
      const output = await runNoticeHook({
        sessionId: options.actorSession,
        stateDirectory: options.stateDirectory,
        format: options.format,
        hookEventName: options.hookEvent,
      }).catch(() => undefined);
      if (output !== undefined) process.stdout.write(`${output}\n`);
    });
  notifications.command("read")
    .description("drain pending notifications for an orchestrator (operator and debugging use)")
    .requiredOption("--actor-session <session-id>", "bound orchestrator session UUID")
    .option("--cursor <n>", "read records after this cursor", "0")
    .option("--limit <n>", "page size, at most 50", "50")
    .option("--acknowledge-through <n>", "acknowledge every record at or below this cursor")
    .action(async (options: { actorSession: string; cursor: string; limit: string; acknowledgeThrough?: string }) => {
      const result = await readNotifications({
        actorSessionId: options.actorSession,
        cursor: Number(options.cursor),
        limit: Number(options.limit),
        ...(options.acknowledgeThrough === undefined ? {} : { acknowledgeThrough: Number(options.acknowledgeThrough) }),
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    });
  notifications.command("configure")
    .description("read or change one orchestrator's wake policy")
    .requiredOption("--actor-session <session-id>", "bound orchestrator session UUID")
    .addOption(new Option("--wake <policy>").choices(["all", "steering-only", "off"]))
    .option("--quiet-minutes <n>", "repeat an unchanged notice after this many minutes")
    .option("--max-wakes-per-hour <n>", "wake ceiling per rolling hour")
    .option("--coalesce-ms <n>", "wait this long for more records before enqueueing a wake")
    .action(async (options: { actorSession: string; wake?: string; quietMinutes?: string; maxWakesPerHour?: string; coalesceMs?: string }) => {
      const result = await configureNotifications({
        actorSessionId: options.actorSession,
        policy: {
          ...(options.wake === undefined ? {} : { wake: options.wake }),
          ...(options.quietMinutes === undefined ? {} : { quietMinutes: Number(options.quietMinutes) }),
          ...(options.maxWakesPerHour === undefined ? {} : { maxWakesPerHour: Number(options.maxWakesPerHour) }),
          ...(options.coalesceMs === undefined ? {} : { coalesceMs: Number(options.coalesceMs) }),
        },
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    });
}
