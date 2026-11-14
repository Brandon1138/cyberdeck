import { InstructionRefusedError } from "./session/session-registry-ports.js";
import { effectiveInstruction, type InstructionRecord, type InstructionAdmission } from "../domain/instruction.js";
import { grantAllows } from "../domain/capability.js";
import type { StrigoiHold, StrigoiIdentity, StrigoiPacketRef, StrigoiState } from "../domain/strigoi.js";
import type { InstructionQueue } from "./instruction-queue.js";
import type { InstructionRouting } from "./instruction-delivery.js";
import type { OrchestratorBindingReader, SessionLookupPort } from "./session/session-ports.js";
import type { StrigoiAdmission } from "./strigoi-admission.js";
import type { StrigoiDeliveryPort, StrigoiRepository } from "./strigoi-ports.js";
import type { WorkflowService } from "./workflow-service.js";

const fail = (code: string) => Object.assign(new Error(code), { code });
const safe = (r: InstructionRecord) => ["accepted", "queued"].includes(r.status) && !r.renderedAt && r.launch !== true && r.submissionAttempt?.outcome !== "unknown";
const transitioning = (s: StrigoiState) => s.transition && !["complete", "aborted"].includes(s.transition.phase);
export interface StrigoiDeliveryOptions {
  repository: StrigoiRepository; bindings: OrchestratorBindingReader; admission: StrigoiAdmission;
  registry: SessionLookupPort; instructions: InstructionQueue;
  workflows: Pick<WorkflowService, "continuationHolds">;
  /** Current substrate/custody validation, inside canonical authority at the final write. */
  authorizeWorker<T>(actorSessionId: string, targetSessionId: string, apply: () => T | Promise<T>): Promise<T>;
  /** Current durable worker/wait/result/conversation demand, never packet size or a constant. */
  demand(identity: StrigoiIdentity): Promise<boolean>;
  observeInstruction?(record: InstructionRecord): Promise<Partial<InstructionRecord> | undefined>;
}

/** Resident addressing is a projection of the existing instruction journal, never a mailbox. */
export class StrigoiDelivery implements StrigoiDeliveryPort, InstructionRouting {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly o: StrigoiDeliveryOptions) { o.instructions.setRouting(this); }
  async submit(message: string, messageId: string): Promise<InstructionRecord> {
    const record = await this.o.instructions.acceptResident(message, messageId, async () => {
      const state = await this.o.repository.read();
      if (!state.activeBinding) throw fail("STRIGOI_NOT_CONFIGURED");
      return state.activeBinding.sessionId;
    });
    await this.flush();
    return (await this.o.instructions.list()).find(r => r.id === record.id)!;
  }
  async key(sessionId: string): Promise<string> {
    if (sessionId === "resident:strigoi") return sessionId;
    try { if (this.o.registry.get(sessionId).kind !== "orchestrator") return sessionId; } catch { /* Archived identity still uses its durable resident key. */ }
    return (await this.o.repository.retentionPins()).has(sessionId) ? "resident:strigoi" : sessionId;
  }
  async hold(identity: StrigoiIdentity, transitionId: string): Promise<void> {
    const s = await this.o.repository.read();
    if (s.transition?.id !== transitionId || s.transition.predecessor?.sessionId !== identity.sessionId) throw fail("STRIGOI_STALE_TRANSITION");
    // The journal phase closes dispatch, including after process reconstruction; acceptance stays open.
  }
  async flush(): Promise<void> {
    const s = await this.o.repository.read();
    if (!s.activeBinding || s.desired !== "enabled" || transitioning(s) || s.hold) return;
    const pins = await this.o.repository.retentionPins();
    for (const record of await this.o.instructions.list()) {
      if (record.logicalRecipient || pins.has(record.actorSessionId)) await this.o.instructions.revise(record, (current, persist) => this.observe(current, persist));
    }
    const targets = new Set([s.activeBinding.sessionId]);
    for (const record of await this.o.instructions.list()) if (["accepted", "queued"].includes(record.status)) targets.add(effectiveInstruction(record).targetSessionId);
    for (const target of targets) await this.o.instructions.flush(target);
  }
  async needsAdoption(identity: StrigoiIdentity, packet: StrigoiPacketRef): Promise<boolean> {
    const s = await this.o.repository.read(); this.validate(s, identity, packet);
    const ids = await this.o.repository.retentionPins();
    for (const record of await this.o.instructions.list()) {
      if (record.logicalRecipient || ids.has(record.actorSessionId)) await this.o.instructions.revise(record, (current, persist) => this.observe(current, persist));
    }
    if ((await this.o.instructions.list()).some(r => !["completed", "cancelled", "undelivered"].includes(r.status)
      && (r.logicalRecipient || ids.has(r.actorSessionId) || ids.has(r.targetSessionId)))) return true;
    if ((await this.o.workflows.continuationHolds([...ids].filter(id => id !== identity.sessionId))).length) return true;
    return this.o.demand(identity);
  }
  reconcile(identity: StrigoiIdentity, packet: StrigoiPacketRef): Promise<StrigoiHold[]> {
    const work = this.tail.catch(() => {}).then(async () => {
      this.validate(await this.o.repository.read(), identity, packet);
      const pins = await this.o.repository.retentionPins(), holds: StrigoiHold[] = [];
      for (const record of await this.o.instructions.list()) {
        if (!record.logicalRecipient && !pins.has(record.actorSessionId)) continue;
        if (["completed", "cancelled", "undelivered"].includes(record.status)) continue;
        await this.o.instructions.revise(record, async (current, persist) => {
          await this.observe(current, persist);
          if (!safe(current)) {
            if (current.status === "rendered" || current.submissionAttempt?.outcome === "unknown" && !["completed", "cancelled", "undelivered"].includes(current.status))
              holds.push({ code: "STRIGOI_INSTRUCTION_OUTCOME_UNRESOLVED", detail: "Prior submission lacks a confirmed terminal receipt; observe it without retyping.", sourceIds: [current.id, current.messageId] });
            return;
          } // operator cancellation or provider receipt won the queue serializer
          if (current.workflowRunId) {
            holds.push({ code: "STRIGOI_WORKFLOW_CONTINUATION_REQUIRED", detail: `Run ${current.workflowRunId}, message ${current.messageId}, instruction ${current.id} remains session-bound. Explicitly continue or replace through workflow create/send/cancel; no participant or reply was migrated.`,
              sourceIds: [current.workflowRunId, current.messageId, current.id] });
            return;
          }
          if (current.submissionKind === "wake" || current.launch === true) return;
          try {
            await this.o.admission.run(identity.sessionId, "recovery", () => this.authority(async () => {
              const state = await this.o.repository.read(); this.validate(state, identity, packet);
              const effective = this.resolve(current, state, pins);
              await this.authorize(current, effective, state, true, async () => {
                this.receipt(current, effective, state); await persist();
              });
            }));
          } catch (error) {
            const code = (error as { code?: string }).code;
            if (!code || !["CAPABILITY_DENIED", "OWNERSHIP_LOST", "STRIGOI_STALE_TARGET"].includes(code)) throw error;
            holds.push({ code, detail: `Instruction ${current.id} cannot continue under current authority.`, sourceIds: [current.id, current.messageId] });
          }
        });
      }
      this.validate(await this.o.repository.read(), identity, packet);
      return [...holds, ...await this.o.workflows.continuationHolds([...pins].filter(id => id !== identity.sessionId))];
    });
    this.tail = work; return work;
  }
  async prepare(record: InstructionRecord, persist: () => Promise<void>): Promise<{ effective: InstructionRecord; admission: InstructionAdmission } | undefined> {
    // Established unrelated bindings retain their existing path even if the resident shard is corrupt.
    if (!record.logicalRecipient && !record.continuations?.length) {
      const actor = await this.o.bindings.findBySessionId(record.actorSessionId);
      if (actor && actor.kind !== "resident" && this.o.registry.get(record.targetSessionId).kind !== "orchestrator") return undefined;
    }
    const state = await this.o.repository.read(), pins = await this.o.repository.retentionPins();
    const involved = !!record.logicalRecipient || pins.has(record.actorSessionId) || pins.has(record.targetSessionId);
    if (!involved) return undefined;
    await this.observe(record, persist);
    if (!safe(record)) throw fail("STRIGOI_INSTRUCTION_ALREADY_RENDERED");
    const effective = this.resolve(record, state, pins);
    const authority = <T>(apply: () => T | Promise<T>): Promise<T> => this.authority(async () => {
      const current = await this.o.repository.read(), currentPins = await this.o.repository.retentionPins();
      const latest = this.resolve(record, current, currentPins);
      if (latest.actorSessionId !== effective.actorSessionId || latest.targetSessionId !== effective.targetSessionId) throw fail("STRIGOI_STALE_INCARNATION");
      if (involved) {
        return this.authorize(record, latest, current, false, async () => {
          this.receipt(record, latest, current);
          record.submissionAttempt = { actorSessionId: latest.actorSessionId, targetSessionId: latest.targetSessionId,
            generation: this.o.registry.get(latest.targetSessionId).generation ?? 1, at: new Date().toISOString(), outcome: "unknown" };
          await persist(); // ambiguous failure after this point is never safe to retype
          try {
            const result = await apply();
            if (typeof result === "object" && result !== null && "state" in result && ["queued", "undelivered"].includes(String(result.state))) {
              record.submissionAttempt.outcome = "refused"; await persist();
            }
            return result;
          }
          catch (error) {
            if (error instanceof InstructionRefusedError) { record.submissionAttempt.outcome = "refused"; await persist(); }
            throw error;
          }
        });
      }
      return apply();
    });
    const admission: InstructionAdmission = apply => this.o.admission.instruction(effective)(() =>
      pins.has(effective.targetSessionId) && effective.targetSessionId !== effective.actorSessionId
        ? this.o.admission.run(effective.targetSessionId, "mutate", () => authority(apply)) : authority(apply));
    return { effective, admission };
  }
  private async observe(record: InstructionRecord, persist: () => Promise<void>): Promise<void> {
    if (["completed", "cancelled", "undelivered"].includes(record.status)) return;
    const observation = await this.o.observeInstruction?.(record);
    if (observation && (["accepted", "queued"].includes(record.status) || ["completed", "cancelled"].includes(observation.status ?? ""))) {
      Object.assign(record, observation); await persist();
    }
  }
  private resolve(record: InstructionRecord, state: StrigoiState, pins: ReadonlySet<string>): InstructionRecord {
    const active = state.activeBinding?.sessionId;
    if (record.workflowRunId && [record.actorSessionId, record.targetSessionId, record.senderSessionId ?? ""].some(id => pins.has(id) && id !== active)) throw fail("STRIGOI_WORKFLOW_CONTINUATION_REQUIRED");
    if (!record.logicalRecipient && pins.has(record.targetSessionId) && record.targetSessionId !== active) throw fail("STRIGOI_STALE_TARGET");
    if (!active || !safe(record) || record.workflowRunId || record.submissionKind === "wake") return effectiveInstruction(record);
    const actor = record.logicalRecipient || pins.has(record.actorSessionId) ? active : record.actorSessionId;
    return { ...record, actorSessionId: actor, targetSessionId: record.logicalRecipient ? active : record.targetSessionId,
      senderSessionId: record.senderSessionId === record.actorSessionId ? actor : record.senderSessionId };
  }
  private async authorize<T>(original: InstructionRecord, effective: InstructionRecord, s: StrigoiState, recovery: boolean, apply: () => T | Promise<T>): Promise<T> {
    if (s.desired !== "enabled") throw fail("STRIGOI_SUSPENDED");
    if (!recovery && (transitioning(s) || s.hold)) throw fail("STRIGOI_RECOVERING");
    const binding = await this.o.bindings.findBySessionId(effective.actorSessionId);
    if (!binding) throw fail("ACTOR_NOT_AUTHORIZED");
    const residentActor = binding.kind === "resident";
    if (residentActor && (s.activeBinding?.sessionId !== effective.actorSessionId || this.o.registry.get(effective.actorSessionId).generation !== s.activeGeneration)) throw fail("STRIGOI_STALE_INCARNATION");
    if (effective.targetSessionId === s.activeBinding?.sessionId && this.o.registry.get(effective.targetSessionId).generation !== s.activeGeneration) throw fail("STRIGOI_STALE_INCARNATION");
    const target = this.o.registry.get(effective.targetSessionId);
    if (!grantAllows(binding.grant, "thread.enqueue", target)) throw fail("CAPABILITY_DENIED");
    if (residentActor && !original.logicalRecipient && effective.targetSessionId !== effective.actorSessionId && target.kind !== "orchestrator") return this.o.authorizeWorker(effective.actorSessionId, effective.targetSessionId, apply);
    return apply();
  }
  private receipt(original: InstructionRecord, effective: InstructionRecord, state: StrigoiState): void {
    const prior = effectiveInstruction(original);
    if (prior.actorSessionId === effective.actorSessionId && prior.targetSessionId === effective.targetSessionId) return;
    if (!safe(original) || !state.transition) throw fail("STRIGOI_UNSAFE_CONTINUATION");
    original.continuations = [...original.continuations ?? [], { instructionId: original.id,
      originalActorSessionId: original.actorSessionId, originalTargetSessionId: original.targetSessionId,
      effectiveActorSessionId: effective.actorSessionId, effectiveTargetSessionId: effective.targetSessionId,
      ...(effective.senderSessionId ? { effectiveSenderSessionId: effective.senderSessionId } : {}),
      transitionId: state.transition.id, incarnation: state.incarnation, generation: state.activeGeneration!, at: new Date().toISOString() }];
  }
  private validate(s: StrigoiState, identity: StrigoiIdentity, packet: StrigoiPacketRef): void {
    if (s.desired !== "enabled" || s.activeBinding?.sessionId !== identity.sessionId || s.incarnation !== identity.incarnation
      || s.activeGeneration !== identity.generation || JSON.stringify(s.transition?.packet) !== JSON.stringify(packet)
      || !["adopting", "reconciling", "complete"].includes(s.transition?.phase ?? "")) throw fail("STRIGOI_STALE_RECOVERY");
  }
  private authority<T>(work: () => Promise<T>): Promise<T> {
    if (!this.o.bindings.withAuthority) throw fail("AUTHORITY_UNAVAILABLE");
    return this.o.bindings.withAuthority(work);
  }
}
