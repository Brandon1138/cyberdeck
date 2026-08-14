import type { ApprovalMode, Sandbox } from "../../domain/session.js";
import { resolveProviderPermissionPlan } from "../../domain/permission-resolution.js";

export { CLAUDE_PERMISSION_MODES } from "../../domain/permission-resolution.js";

/**
 * Sandbox-to-Claude permission mapping, shared by the interactive and headless paths so one sandbox
 * cannot mean two different things depending on how a job happens to be presented.
 *
 * The mapping itself now lives with the other three providers in
 * `src/domain/permission-resolution.ts`, because the drift this guarded against turned out to be
 * between providers rather than between Claude's own two paths. `--permission-mode auto` used to be
 * emitted for any `approvalMode: "auto"` request, which answered the approval question by granting
 * writes a `read-only` request had explicitly refused — the same stored request that reached Codex
 * as `-s read-only -a never`. A read-only request now resolves to `plan` regardless of approval
 * mode. `bypassPermissions` and `dontAsk` are still never emitted.
 */
export function claudePermissionMode(
  sandbox: Sandbox,
  approvalMode: ApprovalMode = "prompt",
): string {
  return claudePermissionArgs(sandbox, approvalMode)[1]!;
}

/** Every Claude permission flag for one request, including writable-root grants. */
export function claudePermissionArgs(
  sandbox: Sandbox,
  approvalMode: ApprovalMode = "prompt",
  writableRoots: readonly string[] = [],
): string[] {
  const plan = resolveProviderPermissionPlan("claude", { sandbox, approvalMode, writableRoots });
  if (!plan.ok) throw Object.assign(new Error(plan.message), { code: plan.code });
  return [...plan.value.args];
}
