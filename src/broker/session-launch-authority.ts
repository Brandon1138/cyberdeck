import { isFableModel } from "../domain/policy.js";
import { grantAllows } from "../domain/capability.js";
import { orchestratorController } from "../domain/orchestrator.js";
import type { SessionRecord } from "../domain/session.js";
import type { WorkerLeaseCredentialCustodian } from "./worker-lease-credential-custodian.js";
import type { WorkerCoordinationService } from "./worker-coordination.js";
import type { OrchestratorStore } from "../persistence/orchestrator-store.js";

/** Launch permission, distinct from the resource scheduler's family classification. */
export function sessionLaunchAuthority(options: {
  orchestrators: OrchestratorStore;
  coordination(): WorkerCoordinationService | undefined;
  credentials: WorkerLeaseCredentialCustodian;
  session?(id: string): SessionRecord | undefined;
}) {
  return async (record: SessionRecord): Promise<void> => {
    if (!record.pendingLaunch) return; // Existing job/resume authority stays with its own owner.
    if (record.parentSessionId && options.session?.(record.parentSessionId)?.executionState !== "active")
      throw new Error("RESOURCE_PARENT_AUTHORITY_UNAVAILABLE");
    const coordination = options.coordination();
    if (!coordination) throw new Error("RESOURCE_CANONICAL_AUTHORITY_UNAVAILABLE");
    const subject = coordination.getSubject(record.id);
    let binding;
    if (subject) {
      const controller = subject.lease.controller;
      const credential = controller && options.credentials.get(controller.controllerId, record.id);
      if (!controller || !credential) throw new Error("RESOURCE_CANONICAL_AUTHORITY_UNAVAILABLE");
      coordination.authenticateCurrentLease({ workerId: record.id, controller,
        leaseToken: credential.leaseToken, leaseVersion: credential.leaseVersion });
      binding = (await options.orchestrators.list()).find(candidate =>
        orchestratorController(candidate).controllerId === controller.controllerId);
    } else if (record.kind === "orchestrator" || record.parentSessionId) {
      binding = await options.orchestrators.findBySessionId(record.kind === "orchestrator" ? record.id : record.parentSessionId!);
    } else return; // Operator-created sessions have no controller grant.
    if (!binding || !grantAllows(binding.grant, "worker.start", { cwd: record.workspace?.repositoryPath ?? record.cwd })
      || isFableModel(record.model) && !grantAllows(binding.grant, "worker.start.fable", { cwd: record.workspace?.repositoryPath ?? record.cwd }))
      throw new Error("RESOURCE_CANONICAL_AUTHORITY_UNAVAILABLE");
  };
}
