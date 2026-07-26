import type { ApprovalMode, Sandbox } from "../../domain/session.js";

/**
 * Sandbox-to-Claude permission mapping, shared by the interactive and headless paths so one sandbox
 * cannot mean two different things depending on how a job happens to be presented.
 *
 * Grounded in Phase 1 behaviour and confirmed against the installed CLI's help, which enumerates
 * `--permission-mode` as `acceptEdits | auto | bypassPermissions | manual | dontAsk | plan`. Only
 * `plan` and `manual` remain the default. Provider-native `auto` is emitted only for an explicit
 * provider-neutral `approvalMode: "auto"` request. `bypassPermissions` and `dontAsk` are
 * deliberately never emitted.
 */
export const CLAUDE_PERMISSION_MODES = {
  "read-only": "plan",
  "workspace-write": "manual",
} as const satisfies Record<Sandbox, string>;

export function claudePermissionMode(sandbox: Sandbox, approvalMode: ApprovalMode = "prompt"): string {
  return approvalMode === "auto" ? "auto" : CLAUDE_PERMISSION_MODES[sandbox];
}
