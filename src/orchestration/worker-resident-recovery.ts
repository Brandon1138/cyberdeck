import { randomUUID } from "node:crypto";
import { grantAllows } from "../domain/capability.js";
import { orchestratorController } from "../domain/orchestrator.js";
import type { StrigoiHold, StrigoiIdentity } from "../domain/strigoi.js";
import { TERMINAL_WORKER_LIFECYCLES, type OwnershipSubject } from "../domain/worker-coordination.js";
import type { WorkerLeaseCredentialCustodian } from "../broker/worker-lease-credential-custodian.js";
import type { WorkerControlOptions } from "./worker-control-service.js";
import { admitted } from "./strigoi-admission.js";

/** Internal WorkerControlService operation. No token or idempotency receipt is packet authority. */
export function recoverResidentWorkers(options: WorkerControlOptions, credentials: WorkerLeaseCredentialCustodian,
  serial: <T>(work: () => Promise<T>) => Promise<T>, identity: StrigoiIdentity, inventory: OwnershipSubject[],
  validate: () => Promise<void>): Promise<StrigoiHold[]> {
  const actor = identity.sessionId;
  const revalidate = async () => {
    await validate();
    const record = options.registry.get(actor);
    if (record.generation !== identity.generation || record.exitCode !== null || !options.registry.ownsProcess(actor)) throw new Error("STRIGOI_STALE_RECOVERY");
  };
  return admitted(options.strigoi, actor, () => serial(async () => {
    if (!options.orchestrators.withAuthority) throw new Error("AUTHORITY_UNAVAILABLE");
    return options.orchestrators.withAuthority(async () => {
      await revalidate();
      const resident = await options.orchestrators.findBySessionId(actor);
      if (resident?.kind !== "resident" || !options.residentLiveness) throw new Error("STRIGOI_LIVENESS_REQUIRED");
      // Finish the current-binding observation before adoption. If a prior disconnect is
      // already beyond grace, connecting now banks expiry of OLD tokens, not the fresh
      // credentials about to be issued. Before grace, absent custody keeps it disconnected.
      await options.residentLiveness.bindingSession(resident, options.registry.get(actor));
      const holds: StrigoiHold[] = [];
      const hold = (id: string, code: string, detail: string) => holds.push({ code, detail, sourceIds: [id] });
      for (const prior of inventory) {
        await revalidate();
        const binding = await options.orchestrators.findBySessionId(actor);
        if (binding?.kind !== "resident") throw new Error("STRIGOI_STALE_INCARNATION");
        const controller = orchestratorController(binding), id = prior.subjectId;
        if (prior.lease.controller?.controllerId !== controller.controllerId) continue;
        const subject = options.coordination.getSubject(id);
        if (!subject || subject.lease.controller?.controllerId !== controller.controllerId
          || subject.lease.version < prior.lease.version || subject.lease.state === "released") {
          hold(id, "worker-ownership-changed", "Captured ownership is no longer current; no recovery attempted."); continue;
        }
        let worker;
        try { worker = options.registry.get(id); }
        catch (error) { if ((error as { code?: string }).code !== "SESSION_NOT_FOUND") throw error; }
        if (!worker || worker.exitCode !== null || worker.attentionState === "interrupted") {
          hold(id, "worker-interrupted", "Worker process is unavailable. Retained results remain readable; work was not re-dispatched."); continue;
        }
        if (!grantAllows(binding.grant, "worker.start", worker) || !grantAllows(binding.grant, "thread.read", worker)
          || !grantAllows(binding.grant, "thread.enqueue", worker)) {
          hold(id, "worker-grant-changed", "Current grant does not authorize recovery of this worker."); continue;
        }
        if (TERMINAL_WORKER_LIFECYCLES.has(subject.lifecycle)) continue;
        const token = credentials.get(controller.controllerId, id);
        if (token && token.leaseVersion === subject.lease.version) {
          const result = await options.coordination.renew({ mutationId: `strigoi:renew:${randomUUID()}`, actor: controller,
            controller, selector: { scope: "single", subjectId: id }, leaseToken: token.leaseToken,
            leaseVersion: token.leaseVersion, reason: "Strigoi succession retains usable custody" });
          if (result.outcomes[0]?.code === "ALREADY_CONTROLLED") continue;
          credentials.delete(controller.controllerId, id);
        }
        await revalidate();
        const latest = options.coordination.getSubject(id);
        if (!latest || latest.lease.controller?.controllerId !== controller.controllerId
          || !["orphaned", "expired"].includes(latest.lease.state)) {
          hold(id, "worker-custody-unavailable", "No usable credential and no currently eligible prior lease; retry after existing liveness recovery."); continue;
        }
        // A fresh attempt is essential: recovery receipts intentionally contain no token.
        // The substrate compares ownership/version inside its serializer, including a transfer
        // to an already-dead controller between this read and adoption.
        const result = await options.coordination.adoptBatch({ mutationId: `strigoi:adopt:${randomUUID()}`,
          actor: controller, newController: controller, reason: "Recover eligible prior Strigoi ownership", credentialDelivery: "ephemeral",
          members: [{ subjectId: id, mode: "adopt", expectedLease: { controllerId: controller.controllerId, version: latest.lease.version } }] });
        const outcome = result.outcomes[0];
        if (result.committed && outcome?.leaseToken && outcome.leaseVersion) {
          credentials.set(controller.controllerId, id, { leaseToken: outcome.leaseToken, leaseVersion: outcome.leaseVersion });
        } else hold(id, "worker-recovery-conflict", "Latest ownership refused adoption; no receipt-only authority was accepted.");
      }
      await revalidate();
      return holds;
    });
  }), "recovery");
}
