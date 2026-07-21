import type { Sandbox } from "../../domain/session.js";

/**
 * Sandbox-to-Claude permission mapping, shared by the interactive and headless paths so one sandbox
 * cannot mean two different things depending on how a job happens to be presented.
 *
 * Grounded in Phase 1 behaviour and confirmed against the installed CLI's help, which enumerates
 * `--permission-mode` as `acceptEdits | auto | bypassPermissions | manual | dontAsk | plan`. Only
 * `plan` and `manual` are used. `bypassPermissions` and `dontAsk` are deliberately never emitted:
 * Cyberdeck does not widen a caller's sandbox on the provider's behalf.
 */
export const CLAUDE_PERMISSION_MODES = {
  "read-only": "plan",
  "workspace-write": "manual",
} as const satisfies Record<Sandbox, string>;

export function claudePermissionMode(sandbox: Sandbox): string {
  return CLAUDE_PERMISSION_MODES[sandbox];
}
