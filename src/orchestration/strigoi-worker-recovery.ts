import { OwnershipSubjectSchema, type OwnershipSubject } from "../domain/worker-coordination.js";
import { OrchestratorAttentionSchema, type OrchestratorAttention } from "../domain/orchestrator-attention.js";
import type { StrigoiHold, StrigoiIdentity, StrigoiPacketRef, StrigoiSourceRef } from "../domain/strigoi.js";
import type { StrigoiAdmission } from "./strigoi-admission.js";
import type { StrigoiPacketPort, StrigoiReconciliationParticipant, StrigoiRepository } from "./strigoi-ports.js";
import type { WorkerControlService } from "./worker-control-service.js";
import type { OrchestratorAttentionControlPlane } from "./orchestrator-attention-control.js";

export interface StrigoiWorkerRecoveryOptions {
  repository: StrigoiRepository;
  packets: StrigoiPacketPort;
  admission: StrigoiAdmission;
  workers: Pick<WorkerControlService, "recoverResident">;
  attention: Pick<OrchestratorAttentionControlPlane, "resumeForSuccessor" | "schedulingRecord">;
}

/** Mechanical participant only: never launches a worker or infers authority from prose/receipts. */
export class StrigoiWorkerRecovery implements StrigoiReconciliationParticipant {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly options: StrigoiWorkerRecoveryOptions) {}
  reconcile(identity: StrigoiIdentity, packet: StrigoiPacketRef): Promise<StrigoiHold[]> {
    const work = this.tail.then(() => this.run(identity, packet));
    this.tail = work.catch(() => {});
    return work;
  }
  private async run(identity: StrigoiIdentity, packet: StrigoiPacketRef): Promise<StrigoiHold[]> {
    return this.options.admission.run(identity.sessionId, "recovery", async () => {
      const validate = async () => {
        const state = await this.options.repository.read(), transition = state.transition;
        if (state.desired !== "enabled" || state.activeBinding?.sessionId !== identity.sessionId
          || state.activeGeneration !== identity.generation || state.incarnation !== identity.incarnation
          || !transition?.predecessor || transition.successor?.sessionId !== identity.sessionId
          || !["reconciling", "complete"].includes(transition.phase)
          || JSON.stringify(transition.packet) !== JSON.stringify(packet)) throw new Error("STRIGOI_STALE_RECOVERY");
        return transition;
      };
      const transition = await validate();
      const inventory = await this.inventory(packet);
      await validate();
      const holds = await this.options.workers.recoverResident(identity, inventory.workers, async () => { await validate(); });
      await validate();
      for (const wait of inventory.waits) {
        if (wait.actorSessionId === transition.predecessor!.sessionId && wait.status === "armed"
          && !await this.options.attention.schedulingRecord(wait.controllerId)) {
          return [...holds, { code: "attention-evidence-missing", detail: "Captured armed wait has no current durable record; refusing to infer cancellation or consumption.", sourceIds: [wait.epoch] }];
        }
      }
      try { await this.options.attention.resumeForSuccessor(transition.predecessor!.sessionId, identity, transition.id); }
      catch (error) {
        // Ordinary changed source authority is a scoped hold. Missing/corrupt evidence still
        // propagates to the driver's unresolved participant hold and never becomes an empty wait.
        if (!["CAPABILITY_DENIED", "OWNERSHIP_LOST"].includes((error as { code?: string }).code ?? "")) throw error;
        holds.push({ code: "attention-authority-changed", detail: String(error), sourceIds: [transition.predecessor!.sessionId] });
      }
      await validate();
      return holds;
    });
  }
  private async inventory(packet: StrigoiPacketRef): Promise<{ workers: OwnershipSubject[]; waits: OrchestratorAttention[] }> {
    const refs: StrigoiSourceRef[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.options.packets.read(packet, cursor);
      refs.push(...page.sources.filter((source) => source.kind === "attention" || source.kind === "worker-event" && source.id.startsWith("ownership:")));
      cursor = page.nextCursor;
    } while (cursor);
    await this.options.packets.verify(refs.map(({ text: _text, ...ref }) => ref));
    const groups = new Map<string, StrigoiSourceRef[]>();
    for (const ref of refs) {
      const key = JSON.stringify([ref.kind, ref.id, ref.revision, ref.sha256]);
      groups.set(key, [...groups.get(key) ?? [], ref]);
    }
    const subjects = new Map<string, OwnershipSubject>();
    const waits: OrchestratorAttention[] = [];
    for (const parts of groups.values()) {
      const value: unknown = JSON.parse(parts.sort((a, b) => a.part! - b.part!).map((part) => part.text!).join(""));
      if (parts[0]!.kind === "attention") { waits.push(OrchestratorAttentionSchema.parse(value)); continue; }
      const subject = OwnershipSubjectSchema.parse(value);
      if (parts[0]!.id !== `ownership:${subject.subjectId}`) throw new Error("STRIGOI_OWNERSHIP_SOURCE_MISMATCH");
      const prior = subjects.get(subject.subjectId);
      if (!prior || subject.lease.version > prior.lease.version || (subject.lease.version === prior.lease.version && subject.updatedAt > prior.updatedAt)) {
        subjects.set(subject.subjectId, subject);
      }
    }
    return { workers: [...subjects.values()].filter((subject) => subject.subjectKind === "worker"), waits };
  }
}
