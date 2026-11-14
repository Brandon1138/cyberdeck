import { randomUUID } from "node:crypto";
import { grantAllows } from "../domain/capability.js";
import { orchestratorController, STRIGOI_KEY } from "../domain/orchestrator.js";
import { AttentionError, type OrchestratorAttention } from "../domain/orchestrator-attention.js";
import type { StrigoiIdentity } from "../domain/strigoi.js";
import type { OrchestratorAttentionOptions } from "./orchestrator-attention-control.js";
import { admitted } from "./strigoi-admission.js";
import { captureAttentionSources } from "./orchestrator-attention-source.js";

/** The live durable record is the snapshot. Packet history can never override a cancel tombstone. */
export async function successionWait(options: OrchestratorAttentionOptions, record: OrchestratorAttention): Promise<OrchestratorAttention | undefined> {
  if (record.bindingKey !== STRIGOI_KEY) return undefined;
  const state = await options.resident?.read(), transition = state?.transition;
  if (!transition || transition.predecessor?.sessionId !== record.actorSessionId
    || !["sealed", "retiring", "launching", "committed", "adopting", "reconciling"].includes(transition.phase)) return undefined;
  const ledger = await options.transcripts.readCompletionLedger(record.actorSessionId);
  if (ledger.turns.some((turn) => typeof turn.data?.turnNumber === "number"
    && turn.data.turnNumber > record.actorTurnFloor && turn.data.outcome === "cancelled")) {
    const { pendingIntent: _pending, ...rest } = record;
    const at = options.now?.() ?? new Date().toISOString();
    return { ...rest, status: "cancelled", cancelledAt: at, updatedAt: at, cancelReason: "Orchestrator turn cancelled after arming" };
  }
  return { ...record, recovery: "held-missing-process" };
}

export async function resumeAttentionForSuccessor(options: OrchestratorAttentionOptions, previousActor: string,
  successor: StrigoiIdentity, transitionId: string): Promise<OrchestratorAttention | undefined> {
  return admitted(options.strigoi, successor.sessionId, async () => {
    if (!options.resident || !options.bindings.withAuthority) throw new Error("STRIGOI_ATTENTION_AUTHORITY_REQUIRED");
    const validate = async () => {
      const state = await options.resident!.read(), binding = state.activeBinding;
      if (state.desired !== "enabled" || binding?.sessionId !== successor.sessionId || state.incarnation !== successor.incarnation
        || state.activeGeneration !== successor.generation || options.registry.get(successor.sessionId).generation !== successor.generation
        || state.transition?.id !== transitionId || state.transition.predecessor?.sessionId !== previousActor
        || !["reconciling", "complete"].includes(state.transition.phase)) throw new Error("STRIGOI_STALE_RECOVERY");
      const current = await options.bindings.findBySessionId(successor.sessionId);
      if (!current || current.kind !== "resident" || JSON.stringify(current.grant) !== JSON.stringify(binding.grant)) throw new Error("STRIGOI_STALE_RECOVERY");
      return current;
    };
    const binding = await validate(), controllerId = orchestratorController(binding).controllerId;
    let finalCheck: (() => Promise<void>) | undefined;
    // Attention serialization precedes canonical authority (store observers also archive under it).
    return options.store.update(controllerId, async (current) => {
      await validate();
      if (!current || current.status === "cancelled" || current.actorSessionId === successor.sessionId) return current;
      if (current.actorSessionId !== previousActor || current.bindingKey !== binding.key) throw new Error("STRIGOI_WAIT_CHANGED");
      const preserved = await successionWait(options, current);
      if (preserved?.status === "cancelled") return preserved;
      const actorLedger = await options.transcripts.readCompletionLedger(successor.sessionId);
      const epoch = randomUUID(), messageId = randomUUID(), at = options.now?.() ?? new Date().toISOString();
      const { pendingIntent, decision: _decision, lastWake: _wake, consumption: _consumption,
        reviewNotifiedAt: _review, ...rest } = current;
      let next: OrchestratorAttention = { ...rest, actorSessionId: successor.sessionId, epoch, armedAt: at, updatedAt: at,
        recovery: "ready", readSequence: 0, receipts: [], actorTurnFloor: actorLedger.completedTurns,
        succession: { previousActor, previousEpoch: current.epoch, transitionId,
          ...(pendingIntent ? { pendingMessageId: pendingIntent.messageId, ...(pendingIntent.instructionId ? { pendingInstructionId: pendingIntent.instructionId } : {}) } : {}) },
        coverage: { captured: current.coverage.captured, consumed: current.coverage.consumed, evaluated: [], noticed: [], submitted: [] },
        ...(pendingIntent ? { pendingIntent: { epoch, messageId, coverage: pendingIntent.coverage, createdAt: at, readSequenceFloor: 0 }, lastWake: { epoch, messageId, intendedAt: at } } : {}) };
      const fresh = await validate();
      if (!["thread.read", "thread.enqueue"].every((capability) => grantAllows(fresh.grant, capability as "thread.read" | "thread.enqueue", fresh))) {
        throw new AttentionError("CAPABILITY_DENIED", "Successor attention grant changed");
      }
      const authoritiesFor = (fresh: typeof binding) => current.authorities.map((authority) => {
        const subject = options.coordination.getSubject(authority.sessionId);
        let cwd = authority.cwd;
        try { cwd = options.registry.get(authority.sessionId).cwd; }
        catch (error) { if ((error as { code?: string }).code !== "SESSION_NOT_FOUND") throw error; }
        if (!grantAllows(fresh.grant, "thread.read", { sessionId: authority.sessionId, cwd })
          || !grantAllows(fresh.grant, "thread.enqueue", { sessionId: authority.sessionId, cwd })) throw new AttentionError("CAPABILITY_DENIED", "Wait source grant changed");
        if (subject?.lease.controller?.controllerId !== controllerId) throw new AttentionError("OWNERSHIP_LOST", "Wait source transferred away");
        return { ...authority, cwd, leaseVersion: subject.lease.version };
      });
      const authorities = authoritiesFor(fresh);
      next = { ...next, authorities };
      const sources = await captureAttentionSources(options, next);
      // Recheck at the actual store commit, after conservative reference acquisition. This
      // preserves the store's capture/pin/deletion ordering without waiting on transcripts
      // under authority, and suspension/revocation queued during capture wins the write.
      finalCheck = async () => {
        const final = await validate();
        if (JSON.stringify(final.grant) !== JSON.stringify(fresh.grant)
          || JSON.stringify(authoritiesFor(final)) !== JSON.stringify(authorities)) {
          throw new AttentionError("OWNERSHIP_LOST", "Wait authority changed during capture");
        }
      };
      return { ...next, authorities, snapshotId: sources.snapshotId, gaps: sources.gaps,
        coverage: { ...next.coverage, captured: sources.captured } };
    }, (commit) => options.bindings.withAuthority!(async () => {
      await validate(); await finalCheck?.(); await commit();
    }));
  }, "recovery");
}
