import {
  ClaudeConversationBindingStore,
  ClaudeSessionStartHookPayloadSchema,
  type ClaudeConversationBinding,
} from "../../persistence/claude-conversation-bindings.js";

/** Every SessionStart source, so a rebind is recorded whether the conversation moved or not. */
export const CLAUDE_TRANSCRIPT_HOOK_MATCHER = "startup|resume|clear|compact";

/** Seconds Claude waits for the hook. It writes one small file and exits. */
export const CLAUDE_TRANSCRIPT_HOOK_TIMEOUT_SECONDS = 5;

export interface ClaudeTranscriptHookCommand {
  nodePath: string;
  cliPath: string;
  sessionId: string;
  stateDirectory: string;
}

/**
 * The settings Claude is launched with so it reports where its conversation lives.
 *
 * The Cyberdeck session id is an argument of the command, fixed when the process is launched and
 * unreachable from inside the conversation. That is what keeps attribution exact when several
 * workers share a worktree: the payload says which *file*, the command line says which *worker*,
 * and neither is inferred from the other.
 */
export function claudeTranscriptHookSettings(command: ClaudeTranscriptHookCommand): string {
  return JSON.stringify({
    hooks: {
      SessionStart: [{
        matcher: CLAUDE_TRANSCRIPT_HOOK_MATCHER,
        hooks: [{
          type: "command",
          command: claudeTranscriptHookCommandLine(command),
          timeout: CLAUDE_TRANSCRIPT_HOOK_TIMEOUT_SECONDS,
        }],
      }],
    },
  });
}

export function claudeTranscriptHookCommandLine(command: ClaudeTranscriptHookCommand): string {
  return [
    command.nodePath,
    command.cliPath,
    "transcript",
    "rebind",
    "--actor-session",
    command.sessionId,
    "--state-directory",
    command.stateDirectory,
  ].map(shellQuote).join(" ");
}

export type ClaudeTranscriptRebindOutcome =
  | { recorded: true; binding: ClaudeConversationBinding }
  | { recorded: false; reason: "unreadable-payload" };

export interface ClaudeTranscriptRebindRequest {
  sessionId: string;
  payload: string;
  store: ClaudeConversationBindingStore;
}

/**
 * Record one SessionStart report.
 *
 * Never throws for a payload it cannot use. This runs inside the operator's session: a hook that
 * fails is a hook that interrupts the worker, and a missed rebind already fails closed downstream.
 */
export async function runClaudeTranscriptRebind(
  request: ClaudeTranscriptRebindRequest,
): Promise<ClaudeTranscriptRebindOutcome> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(request.payload);
  } catch {
    return { recorded: false, reason: "unreadable-payload" };
  }
  const payload = ClaudeSessionStartHookPayloadSchema.safeParse(parsed);
  if (!payload.success) return { recorded: false, reason: "unreadable-payload" };
  const binding = await request.store.record({
    sessionId: request.sessionId,
    payload: payload.data,
  });
  return { recorded: true, binding };
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}
