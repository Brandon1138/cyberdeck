import type { AuxiliaryProfileRequest } from "../domain/auxiliary-profile.js";
import type { InstructionRecord } from "../domain/instruction.js";
import type { SessionRecord } from "../domain/session.js";
import type { GatewayBinding } from "./worker-gateway.js";
import type { WorkerCoordinationService } from "./worker-coordination.js";
import type { WorkerLeaseCredentialCustodian } from "./worker-lease-credential-custodian.js";

/** Canonical lease authentication remains in WorkerCoordinationService; this adds recipe scope. */
export function auxiliaryProfileAuthorizer(options: {
  brokerId: string; session(id: string): SessionRecord;
  coordination: Pick<WorkerCoordinationService, "getSubject" | "authenticateCurrentLease">;
  credentials: WorkerLeaseCredentialCustodian;
  instructions(id: string): Promise<InstructionRecord[]>;
}) {
  return async (binding: GatewayBinding, request: AuxiliaryProfileRequest, expectedLeaseVersion?: number) => {
    const check = () => {
      const session = options.session(binding.workerId), ref = session.execution;
      if (session.kind === "orchestrator" || session.executor !== "orbstack-container" || session.executionState !== "active"
        || session.generation !== binding.generation || ref?.generation !== binding.generation || ref.executionId !== binding.executionId
        || ref.brokerId !== options.brokerId || ref.sessionId !== session.id || ref.workerId !== session.id)
        throw new Error("AUXILIARY_EXECUTION_STALE");
      const subject = options.coordination.getSubject(session.id), controller = subject?.lease.controller;
      if (!subject || !controller || (expectedLeaseVersion !== undefined && subject.lease.version !== expectedLeaseVersion))
        throw new Error("AUXILIARY_LEASE_STALE");
      const credential = options.credentials.get(controller.controllerId, session.id);
      if (!credential || credential.leaseVersion !== subject.lease.version) throw new Error("AUXILIARY_CREDENTIAL_UNAVAILABLE");
      const canonical = options.coordination.authenticateCurrentLease({ workerId: session.id, controller,
        leaseToken: credential.leaseToken, leaseVersion: subject.lease.version });
      if (session.sandbox !== "workspace-write") throw new Error("AUXILIARY_WRITE_POLICY_REFUSED");
      return { session, ref, familyId: canonical.familyId, leaseVersion: subject.lease.version };
    };
    const first = check();
    const instructions = await options.instructions(binding.workerId);
    if (request.attemptId !== binding.workerId && !instructions.some(record => record.id === request.attemptId
      && record.attemptGeneration === binding.generation && record.attemptExecutionId === binding.executionId
      && ["rendered", "submitted", "acknowledged"].includes(record.status))) throw new Error("AUXILIARY_ATTEMPT_STALE");
    // Session-id attribution is permitted only when no broker instruction currently owns this turn.
    if (request.attemptId === binding.workerId && instructions.some(record => record.attemptGeneration === binding.generation
      && ["rendered", "submitted", "acknowledged"].includes(record.status))) throw new Error("AUXILIARY_ATTEMPT_AMBIGUOUS");
    const current = check();
    if (current.leaseVersion !== first.leaseVersion || current.familyId !== first.familyId) throw new Error("AUXILIARY_LEASE_STALE");
    const { brokerId, executionId, workerId, sessionId, generation } = current.ref;
    return { identity: { brokerId, executionId, workerId, sessionId, generation }, familyId: current.familyId,
      leaseVersion: current.leaseVersion, writeAllowed: true, workspaceRoot: current.session.cwd };
  };
}
