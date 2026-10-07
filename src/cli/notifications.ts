import { Command, Option } from "commander";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { appStateDirectory } from "../broker/app-paths.js";
import {
  NOTICE_FILE_NAME,
  NOTICE_SHOWN_FILE_NAME,
  NoticeFileSchema,
  NoticeHookFormatSchema,
  NoticeShownFileSchema,
  noticeIsUnseen,
  renderNoticeHookOutput,
  type NoticeHookFormat,
} from "../domain/orchestrator-notice-file.js";
import type { CliProgramContext } from "./program.js";

/** Where delivery writes an orchestrator session's notice files. One directory per session. */
export function orchestratorNoticeDirectory(stateDirectory: string, sessionId: string): string {
  return join(stateDirectory, "orchestrators", sessionId);
}

export interface NoticeHookRequest {
  sessionId: string;
  stateDirectory: string;
  format: NoticeHookFormat;
  hookEventName?: string;
  now?: () => string;
}

/**
 * The whole provider hook: read two small files, print at most one line, never fail.
 *
 * This runs inside the orchestrator's own provider process on every tool call, so its contract is
 * the fault-case table in the acceptance doc: a missing, stale, unreadable or malformed file is
 * "nothing to say", exit 0, empty stdout. It opens no socket. When it prints, it records the head
 * cursor it showed so the next call, and the broker's tool-result piggyback, do not repeat it.
 */
export async function runNoticeHook(request: NoticeHookRequest): Promise<string | undefined> {
  const directory = orchestratorNoticeDirectory(request.stateDirectory, request.sessionId);
  const notice = await readJson(join(directory, NOTICE_FILE_NAME), NoticeFileSchema);
  if (notice === undefined || notice.sessionId !== request.sessionId) return undefined;
  const shown = await readJson(join(directory, NOTICE_SHOWN_FILE_NAME), NoticeShownFileSchema);
  if (!noticeIsUnseen(notice, shown)) return undefined;
  const output = renderNoticeHookOutput(request.format, notice.text, request.hookEventName);
  try {
    await writeFile(join(directory, NOTICE_SHOWN_FILE_NAME), JSON.stringify({
      schemaVersion: 1,
      cursor: notice.cursor,
      shownAt: request.now?.() ?? new Date().toISOString(),
      via: request.format,
    }), { encoding: "utf8", mode: 0o600 });
  } catch {
    // The sidecar is a courtesy to the next call; failing to write it must not fail this one.
  }
  return output;
}

async function readJson<T>(
  path: string,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
): Promise<T | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

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
