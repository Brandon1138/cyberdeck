import {
  claudeTranscriptHooks,
  type ClaudeTranscriptHookCommand,
  type ClaudeTranscriptHooks,
} from "./transcript-hook.js";
import {
  claudeNoticeHooks,
  type ClaudeNoticeHookCommand,
  type ClaudeNoticeHooks,
} from "./notice-hooks.js";

/**
 * The endpoint Remote Control is gated to. Claude accepts a base URL whose host is exactly this
 * one as first party; anything else, including the operator's local compression proxy,
 * unregisters `/remote-control` before the session's first turn.
 */
export const CLAUDE_FIRST_PARTY_BASE_URL = "https://api.anthropic.com";

export interface ClaudeLaunchSettingsInput {
  /** Present when the broker can receive transcript rebinds; absent on a bare adapter. */
  transcriptHook?: ClaudeTranscriptHookCommand;
  /** Present only when an orchestrator can read the broker's notice files. */
  noticeHook?: ClaudeNoticeHookCommand;
  orchestrator: boolean;
}

export interface ClaudeLaunchSettings {
  hooks?: Partial<ClaudeTranscriptHooks & ClaudeNoticeHooks>;
  env?: { ANTHROPIC_BASE_URL: typeof CLAUDE_FIRST_PARTY_BASE_URL };
}

/**
 * The one `--settings` file a Claude session is launched with, or `undefined` when there is
 * nothing to put in it.
 *
 * Command-line settings outrank every scope `--setting-sources` admits, which is what the
 * orchestrator `env` pin relies on. `ORCHESTRATOR_WITHHELD_KEYS` already scrubs
 * `ANTHROPIC_BASE_URL` from the process environment, and `--setting-sources project,local` was
 * meant to keep the operator's user settings from putting it back. That holds only while the
 * session's cwd is not the operator's home directory: Claude resolves *project* settings as
 * `<cwd>/.claude/settings.json`, so an orchestrator spawned in `$HOME` reads the user file as its
 * project file, the proxy URL lands in `process.env` over the scrubbed value, and `/rc` answers
 * `Unknown command`. Pinning the first-party endpoint from the highest scope Cyberdeck controls
 * makes the guarantee total: it holds for any cwd and whatever that cwd's own settings declare.
 *
 * Orchestrator-only, deliberately. Workers and top-level sessions keep the operator's routing,
 * proxy included, exactly as `launch-environment.ts` copies it.
 */
export function claudeLaunchSettings(input: ClaudeLaunchSettingsInput): string | undefined {
  const settings: ClaudeLaunchSettings = {};
  if (input.transcriptHook !== undefined) {
    settings.hooks = claudeTranscriptHooks(input.transcriptHook);
  }
  if (input.orchestrator) {
    if (input.noticeHook !== undefined) {
      settings.hooks = { ...settings.hooks, ...claudeNoticeHooks(input.noticeHook) };
    }
    settings.env = { ANTHROPIC_BASE_URL: CLAUDE_FIRST_PARTY_BASE_URL };
  }
  if (settings.hooks === undefined && settings.env === undefined) return undefined;
  return JSON.stringify(settings);
}
