import {
  noticeHookCommandLine,
  NOTICE_HOOK_TIMEOUT_SECONDS,
  type NoticeHookCommand,
} from "../notice-hook-command.js";

export type ClaudeNoticeHookCommand = Omit<NoticeHookCommand, "format" | "event">;

interface ClaudeNoticeHookGroup {
  hooks: Array<{ type: "command"; command: string; timeout: number }>;
}

export interface ClaudeNoticeHooks {
  PostToolUse: Array<ClaudeNoticeHookGroup & { matcher: string }>;
  PostToolUseFailure: Array<ClaudeNoticeHookGroup & { matcher: string }>;
  Stop: ClaudeNoticeHookGroup[];
}

/** Launch-scoped notice delivery for orchestrators, composed with the transcript hook. */
export function claudeNoticeHooks(command: ClaudeNoticeHookCommand): ClaudeNoticeHooks {
  const hooks = (event: string): ClaudeNoticeHookGroup["hooks"] => [{
    type: "command",
    command: noticeHookCommandLine({ ...command, format: "claude", event }),
    timeout: NOTICE_HOOK_TIMEOUT_SECONDS,
  }];
  return {
    PostToolUse: [{ matcher: ".*", hooks: hooks("PostToolUse") }],
    PostToolUseFailure: [{ matcher: ".*", hooks: hooks("PostToolUseFailure") }],
    Stop: [{ hooks: hooks("Stop") }],
  };
}
