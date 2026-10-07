import { z } from "zod";

/**
 * The two small files that carry a notice from the broker to a provider hook without a socket.
 *
 * `notice.json` is rewritten by the broker on every inbox change for the controller bound to an
 * orchestrator session, and removed when nothing is pending. `notice-shown.json` is written by the
 * hook command after it printed a notice, so the same notice is not printed again on the next tool
 * call, and so the broker's tool-result piggyback can see that a hook already showed it. Both are
 * read by a hook that must never block or fail: any missing, stale or unreadable file means
 * "nothing to say".
 */
export const NOTICE_FILE_NAME = "notice.json";
export const NOTICE_SHOWN_FILE_NAME = "notice-shown.json";

export const NoticeFileSchema = z.object({
  schemaVersion: z.literal(1),
  controllerId: z.string().min(1),
  sessionId: z.uuid(),
  /** The inbox head cursor this notice describes. Monotonic per controller. */
  cursor: z.number().int().nonnegative(),
  /** The head cursor the broker last showed through a tool result, so a hook can skip it. */
  noticedCursor: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  dropped: z.number().int().nonnegative(),
  /** The rendered one-line notice, already bounded by the domain renderer. */
  text: z.string().min(1).max(400),
  writtenAt: z.iso.datetime(),
  /** The controller's quiet interval: a hook may repeat an unchanged notice after this long. */
  quietMinutes: z.number().int().min(1).max(120).optional(),
});

export const NoticeShownFileSchema = z.object({
  schemaVersion: z.literal(1),
  cursor: z.number().int().nonnegative(),
  shownAt: z.iso.datetime(),
  /** Which hook showed it, for diagnostics only. */
  via: z.enum(["claude", "codex", "cursor"]).optional(),
});

export type NoticeFile = z.infer<typeof NoticeFileSchema>;
export type NoticeShownFile = z.infer<typeof NoticeShownFileSchema>;

export const NoticeHookFormatSchema = z.enum(["claude", "codex", "cursor"]);
export type NoticeHookFormat = z.infer<typeof NoticeHookFormatSchema>;

/**
 * True when the file holds something a hook should print: a newer head than the hook itself last
 * showed and newer than the broker last piggybacked.
 */
export function noticeIsUnseen(
  file: NoticeFile,
  shown: NoticeShownFile | undefined,
  now?: string,
): boolean {
  if (file.pending === 0 && file.dropped === 0) return false;
  if (file.cursor <= file.noticedCursor) return false;
  if (shown === undefined || file.cursor > shown.cursor) return true;
  if (file.quietMinutes === undefined || now === undefined) return false;
  const quietMs = file.quietMinutes * 60_000;
  const elapsed = Date.parse(now) - Date.parse(shown.shownAt);
  return Number.isFinite(elapsed) && elapsed >= quietMs;
}

/**
 * The exact JSON each provider's hook protocol expects on stdout for an in-turn context injection.
 *
 * Claude and Codex read `hookSpecificOutput.additionalContext`; Cursor reads `additional_context`.
 * The event name is part of Claude's envelope and is harmless to the others, so it is set from
 * the caller's hook event rather than guessed.
 */
export function renderNoticeHookOutput(
  format: NoticeHookFormat,
  text: string,
  hookEventName = "PostToolUse",
): string {
  if (format === "cursor") return JSON.stringify({ additional_context: text });
  return JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: text } });
}
