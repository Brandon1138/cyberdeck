import { ORCHESTRATOR_GRANT_CAPABILITIES, type OrchestratorBinding, type OrchestratorScope } from "../domain/orchestrator.js";
import type { CyberdeckCapability } from "../domain/capability.js";
import type { ApprovalMode, ProviderId, SessionRecord, StartSessionRequest } from "../domain/session.js";
import { resolveProviderPermissionPlan } from "../domain/permission-resolution.js";
import type { ProviderPermissionPreferenceReader } from "./persistence-ports.js";
import { orchestratorSandbox, resolveProviderPermission } from "./permission-policy.js";
import { orchestratorPrompt } from "./orchestrator-prompt.js";

type Selection = { provider: ProviderId; model?: string | undefined; effort?: SessionRecord["effort"]; cwd: string; approvalMode?: ApprovalMode | undefined };

/** Ordinary and resident Orcs share permission resolution, native guidance, and grant construction. */
export async function prepareOrchestratorLaunch(selection: Selection, scope: OrchestratorScope,
  preferences?: ProviderPermissionPreferenceReader, capabilities: readonly CyberdeckCapability[] = ORCHESTRATOR_GRANT_CAPABILITIES,
  name = `Cyberdeck orchestrator (${selection.provider}${selection.model === undefined ? "" : `:${selection.model}`})`,
): Promise<{ request: StartSessionRequest; warnings: string[] }> {
  let approvalMode = selection.approvalMode;
  if (approvalMode === undefined) {
    const policy = (await preferences?.list())?.[selection.provider];
    if (policy !== undefined) {
      const resolution = resolveProviderPermission(selection.provider, policy, "read-only");
      if (!resolution.ok) throw Object.assign(new Error(resolution.message), { code: "APPROVAL_MODE_NOT_SUPPORTED" });
      approvalMode = resolution.value.application.kind === "post-launch-command" ? "auto" : resolution.value.application.value;
    }
  }
  approvalMode ??= selection.provider === "claude" ? "auto" : undefined;
  const sandbox = orchestratorSandbox(selection.provider);
  const plan = resolveProviderPermissionPlan(selection.provider, { sandbox, approvalMode, mcpInjected: true, codexApproveForMe: selection.provider === "codex" });
  if (!plan.ok) throw Object.assign(new Error(plan.message), { code: plan.code });
  return { request: { ...selection, ...(approvalMode === undefined ? {} : { approvalMode }), sandbox,
    detached: true, role: "orchestrator", kind: "orchestrator", orchestratorScope: scope.kind, name,
    providerInstructions: orchestratorPrompt(scope, capabilities) }, warnings: plan.value.shortfalls.map((s) => s.message) };
}

export function orchestratorLaunchBinding(request: StartSessionRequest, scope: OrchestratorScope,
  started: SessionRecord, key: string, kind: OrchestratorBinding["kind"],
  capabilities: readonly CyberdeckCapability[] = ORCHESTRATOR_GRANT_CAPABILITIES,
): OrchestratorBinding {
  const now = new Date().toISOString();
  return { key, kind, sessionId: started.id, provider: request.provider, cwd: request.cwd, sandbox: request.sandbox, scope,
    ...(request.model === undefined ? {} : { model: request.model }), ...(request.effort === undefined ? {} : { effort: request.effort }),
    grant: { subjectSessionId: started.id, capabilities: [...capabilities], scope }, createdAt: now, updatedAt: now };
}
