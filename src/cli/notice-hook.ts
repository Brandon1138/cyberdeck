import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  NOTICE_FILE_NAME,
  NOTICE_SHOWN_FILE_NAME,
  NoticeFileSchema,
  NoticeShownFileSchema,
  noticeIsUnseen,
  renderNoticeHookOutput,
  type NoticeHookFormat,
} from "../domain/orchestrator-notice-file.js";

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
  const now = request.now?.() ?? new Date().toISOString();
  if (!noticeIsUnseen(notice, shown, now)) return undefined;
  const output = renderNoticeHookOutput(request.format, notice.text, request.hookEventName);
  try {
    await writeFile(join(directory, NOTICE_SHOWN_FILE_NAME), JSON.stringify({
      schemaVersion: 1,
      cursor: notice.cursor,
      shownAt: now,
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

