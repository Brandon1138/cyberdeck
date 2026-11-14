import { randomUUID } from "node:crypto";
import type { StrigoiIdentity, StrigoiState, StrigoiTransition } from "../domain/strigoi.js";
import type { AgentActivityPort } from "./agent-activity-port.js";
import type { StrigoiContinuity } from "./strigoi-continuity.js";
import { strigoiLaunchFailureIsPermanent, type StrigoiLifecycle, type StrigoiLifecycleOptions } from "./strigoi-lifecycle.js";
import type { StrigoiInspection, StrigoiPacketPort, StrigoiSourcePort, StrigoiReconciliationParticipant, StrigoiSuccessionTurns } from "./strigoi-ports.js";
import { strigoiPrompt } from "./strigoi-prompt.js";

export interface StrigoiSuccessionOptions extends StrigoiLifecycleOptions {
  lifecycle: StrigoiLifecycle;
  continuity: StrigoiContinuity;
  packets: StrigoiPacketPort;
  sources: StrigoiSourcePort;
  registry: StrigoiLifecycleOptions["registry"] & {
    residentRetirement(sessionId: string, generation: number): Promise<"confirmed" | "unknown">;
  };
  turns: StrigoiSuccessionTurns;
  workers?: StrigoiReconciliationParticipant;
  delivery?: StrigoiReconciliationParticipant & {
    /** Close ordinary turn dispatch, not durable input acceptance. Idempotent across restart. */
    hold(identity: StrigoiIdentity, transitionId: string): Promise<void>;
    flush?(): Promise<void>;
    /** Current durable obligations, not transcript byte counts. Missing evidence never wakes a model. */
    needsAdoption?(identity: StrigoiIdentity, packet: import("../domain/strigoi.js").StrigoiPacketRef): Promise<boolean>;
  };
  activity?: AgentActivityPort;
  now?: () => number;
}
const terminal = (t?: StrigoiTransition) => !t || t.phase === "complete" || t.phase === "aborted";
const fault = (code: string) => Object.assign(new Error(code), { code });
const delays = [1000, 5000, 30000];

/** One serialized driver per resident. Every effect is preceded by durable intent and fresh authority. */
export class StrigoiSuccession {
  private tail: Promise<unknown> = Promise.resolve();
  private reconciliation: { id: string; work: Promise<import("../domain/strigoi.js").StrigoiHold[]> } | undefined;
  private drain?: { id: string; done: boolean; wait: Promise<boolean> };
  constructor(private readonly o: StrigoiSuccessionOptions) { o.lifecycle.attachSuccession(this); }
  private now() { return this.o.now?.() ?? Date.now(); }
  private at() { return new Date(this.now()).toISOString(); }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work, work); this.tail = next.catch(() => {}); return next;
  }
  private authority<T>(work: () => Promise<T>): Promise<T> {
    if (!this.o.bindings.withAuthority) throw fault("AUTHORITY_UNAVAILABLE");
    return this.o.bindings.withAuthority(work);
  }
  private write(state: StrigoiState, patch: Partial<StrigoiState>, id: string = randomUUID()) {
    return this.o.repository.compareAndSwap(state.revision, id, { ...state, ...patch, revision: state.revision + 1, updatedAt: this.at() });
  }
  private save(state: StrigoiState, patch: Partial<StrigoiState>) {
    return this.write(state, patch, `succession:${state.transition!.id}:${state.revision + 1}`);
  }
  async renew(expectedIncarnation: number, reason: string, mutationId: string, authorize?: () => Promise<void>): Promise<StrigoiTransition> {
    if (!mutationId.trim() || !reason.trim()) throw fault("STRIGOI_INVALID_MUTATION");
    return this.authority(async () => {
      const state = await this.o.repository.read();
      await authorize?.();
      const prior = state.successionRequests?.find((r) => r.mutationId === mutationId);
      if (prior) {
        if (prior.expectedIncarnation !== expectedIncarnation || prior.reason !== reason) throw fault("STRIGOI_MUTATION_CONFLICT");
        await this.o.repository.confirmMutation(`renew:${mutationId}`);
        return [state.transition, ...state.successionHistory ?? []].find((t) => t?.id === prior.transitionId)!;
      }
      if (state.desired !== "enabled") throw fault("STRIGOI_SUSPENDED");
      if (state.incarnation !== expectedIncarnation || !state.activeBinding) throw fault("STRIGOI_STALE_INCARNATION");
      if (!terminal(state.transition)) throw fault("STRIGOI_TRANSITION_IN_PROGRESS");
      const transition: StrigoiTransition = { id: randomUUID(), expectedIncarnation, reason, phase: "requested", attempts: 0,
        predecessor: { sessionId: state.activeBinding.sessionId, incarnation: state.incarnation, generation: state.activeGeneration! },
        requestedAt: this.at(), phaseTimes: { requested: this.at() }, lastMutationId: `renew:${mutationId}`, recovery: !this.o.registry.ownsProcess(state.activeBinding.sessionId) };
      await this.write(state, { transition, hold: undefined,
        successionHistory: [...state.successionHistory ?? [], ...state.transition ? [state.transition] : []],
        successionRequests: [...state.successionRequests ?? [], { mutationId, expectedIncarnation, reason, transitionId: transition.id }] }, `renew:${mutationId}`);
      return transition;
    });
  }
  async recover(state: StrigoiState): Promise<void> {
    if (state.desired !== "enabled") return;
    if (terminal(state.transition)) {
      const id = state.activeBinding?.sessionId;
      if (!id) return;
      if (this.o.registry.ownsProcess(id) && this.o.registry.get(id).exitCode === null) {
        if (state.transition && ["complete", "aborted"].includes(state.transition.phase)) {
          await this.advance(state.transition.id);
        }
        return;
      }
      await this.renew(state.incarnation, "runtime-recovery", `recovery:${state.incarnation}`);
    }
    await this.advance((await this.o.repository.read()).transition!.id);
  }
  advance(transitionId: string): Promise<StrigoiInspection> {
    return this.serial(async () => {
      const epoch = this.o.lifecycle.successionEpoch();
      // A bounded phase loop; waiting turns/unknown effects yield instead of blocking broker boot.
      for (let step = 0; step < 20; step++) {
        const state = await this.o.repository.read(), t = state.transition;
        if (!t || t.id !== transitionId) throw fault("STRIGOI_STALE_TRANSITION");
        if (state.desired !== "enabled" || !this.o.lifecycle.permitsSuccession(epoch)) break;
        if (state.hold?.code === "continuity-evidence-unavailable") break;
        if (t.predecessor && !["requested", "checkpointing", "aborted"].includes(t.phase)) await this.o.admission.freeze(t.predecessor);
        if (t.successor) await this.o.admission.freeze(t.successor);
        // Re-sync the latest phase record when visible after a failed append. Other writers
        // (desired state/continuity) use their own receipt confirmation, so phase confirmation
        // uses the recorded per-phase revision marker below, not the current state revision.
        const marker = t.lastMutationId;
        if (marker) await this.o.repository.confirmMutation(marker);
        await this.event(state);
        if (t.phase === "complete" || t.phase === "aborted") {
          if (t.phase === "aborted" && !await this.startDrain(t).wait && !this.drain!.done) {
            this.o.lifecycle.wakeSuccession(this.now() + 1000); break;
          }
          const actor = t.phase === "complete" ? t.successor! : t.predecessor!;
          if (!this.o.registry.ownsProcess(actor.sessionId) || this.o.registry.get(actor.sessionId).exitCode !== null) {
            await this.hold(t, epoch, "successor-unavailable", "Completed transition has no owned active runtime; lifecycle recovery must reconcile it."); break;
          }
          if (!state.hold && this.o.lifecycle.permitsSuccession(epoch)) {
            await this.o.manager.observeResident(state.activeBinding!, this.o.registry.get(actor.sessionId));
          }
          await this.o.lifecycle.reconcileActive(epoch);
          await this.o.delivery?.flush?.();
          break;
        }
        if (!await this.step(state, epoch)) {
          this.o.lifecycle.wakeSuccession(this.now() + 1000); break;
        }
      }
      return this.o.lifecycle.inspect();
    }).catch((error: unknown) => { this.o.lifecycle.wakeSuccession(this.now() + 1000); throw error; });
  }
  abort(transitionId: string, mutationId: string): Promise<void> {
    return this.serial(async () => {
      const epoch = this.o.lifecycle.successionEpoch();
      await this.authority(async () => {
        const s = await this.o.repository.read(), t = s.transition;
        if (!t || t.id !== transitionId) throw fault("STRIGOI_STALE_TRANSITION");
        if (t.phase === "aborted") { await this.o.repository.confirmMutation(`abort:${mutationId}`); return; }
        // Once a stop has been issued its outcome can be unknown: never reopen an actor
        // that a delayed stop may kill. Proven retirement is an irreversible forward boundary.
        if (t.retirementConfirmedAt || t.stopRequestedAt || !["requested", "checkpointing", "sealed"].includes(t.phase)
          || await this.o.registry.residentRetirement(t.predecessor!.sessionId, t.predecessor!.generation) === "confirmed") throw fault("STRIGOI_ABORT_UNSAFE");
        await this.write(s, { transition: { ...t, phase: "aborted", lastMutationId: `abort:${mutationId}` }, hold: undefined }, `abort:${mutationId}`);
      });
      const s = await this.o.repository.read();
      // Abort is durable immediately; an admitted mutation still owns its permit.
      // Keep the barrier closed until it drains, then let lifecycle recheck fresh state.
      const drain = this.startDrain(s.transition!);
      await Promise.resolve();
      if (drain.done) await this.o.lifecycle.reconcileActive(epoch);
      else { void drain.wait.catch(() => {}); this.o.lifecycle.wakeSuccession(this.now() + 1000); }
    });
  }
  private async change(id: string, epoch: number, patch: (s: StrigoiState, t: StrigoiTransition) => Partial<StrigoiState>): Promise<boolean> {
    return this.authority(async () => {
      const s = await this.o.repository.read(), t = s.transition;
      if (s.desired !== "enabled" || !this.o.lifecycle.permitsSuccession(epoch) || t?.id !== id) return false;
      const next = patch(s, t);
      next.transition = { ...next.transition ?? t, lastMutationId: `succession:${id}:${s.revision + 1}` };
      await this.save(s, next); return true;
    });
  }
  private phase(t: StrigoiTransition, phase: StrigoiTransition["phase"], extra: Partial<StrigoiTransition> = {}): StrigoiTransition {
    return { ...t, ...extra, phase, phaseTimes: { ...t.phaseTimes, [phase]: this.at() } };
  }
  private hold(t: StrigoiTransition, epoch: number, code: string, detail: string): Promise<boolean> {
    return this.o.repository.read().then(async (state) => {
      if (state.hold?.code !== code || state.hold.detail !== detail) await this.change(t.id, epoch, () => ({ hold: { code, detail, sourceIds: [t.predecessor!.sessionId, ...t.successor ? [t.successor.sessionId] : []] } }));
      return false;
    });
  }
  private async step(s: StrigoiState, epoch: number): Promise<boolean> {
    const t = s.transition!, old = t.predecessor!;
    if (!this.o.lifecycle.permitsSuccession(epoch) || (await this.o.repository.read()).desired !== "enabled") return false;
    if (["committed", "adopting", "reconciling"].includes(t.phase) && t.successor
      && (!this.o.registry.ownsProcess(t.successor.sessionId) || this.o.registry.get(t.successor.sessionId).generation !== t.successor.generation
        || this.o.registry.get(t.successor.sessionId).exitCode !== null)) return this.hold(t, epoch, "successor-unavailable", "Committed successor has no exact owned active runtime; no adoption execution is authorized.");
    switch (t.phase) {
      case "requested":
      case "checkpointing": {
        if (!this.o.delivery) return this.hold(t, epoch, "delivery-participant-missing", "Task 8 production delivery participant is not wired.");
        await this.o.delivery.hold(old, t.id);
        const retired = await this.o.registry.residentRetirement(old.sessionId, old.generation) === "confirmed";
        if (!retired && this.o.registry.ownsProcess(old.sessionId)) {
          if (t.checkpointTurn && !await this.turn(s, epoch, "checkpoint")) return false;
          const boundary = await this.o.turns.boundary(old);
          if (boundary !== "safe") {
            if (this.now() - Date.parse(t.requestedAt!) >= 120_000 || boundary === "modal")
              return this.hold(t, epoch, boundary === "modal" ? "provider-permission-modal" : "awaiting-safe-boundary", "The incumbent is not at a confirmed safe boundary; ongoing work is not killed.");
            return false;
          }
          if (!s.latestPacket && !t.checkpointTurn) {
            if (!await this.turn(s, epoch, "checkpoint")) return false;
          }
        }
        return this.seal(await this.o.repository.read(), epoch);
      }
      case "sealed": return this.change(t.id, epoch, (_s, current) => ({ transition: this.phase(current, "retiring"), hold: undefined }));
      case "retiring": {
        if (await this.o.registry.residentRetirement(old.sessionId, old.generation) !== "confirmed") {
          if (!t.stopRequestedAt && this.o.registry.ownsProcess(old.sessionId)) {
            if (!await this.change(t.id, epoch, (_s, current) => ({ transition: { ...current, stopRequestedAt: this.at() } }))) return false;
            // Request once, outside authority. A lost stop result is reconciled, not absence.
            await this.o.registry.stopResidentProcess(old.sessionId);
          }
          if (await this.o.registry.residentRetirement(old.sessionId, old.generation) !== "confirmed")
            return this.hold(t, epoch, "retirement-unconfirmed", "No exact-generation observed retirement; no successor may launch.");
        }
        return this.change(t.id, epoch, (_s, current) => ({ transition: this.phase(current, "launching", { retirementConfirmedAt: this.at() }), hold: undefined }));
      }
      case "launching": return this.launch(s, epoch);
      case "committed": {
        await this.o.manager.observeResident(s.activeBinding!, this.o.registry.get(t.successor!.sessionId));
        return this.change(t.id, epoch, (_s, current) => ({ transition: this.phase(current, "adopting"), hold: undefined }));
      }
      case "adopting":
        if (t.reason === "runtime-recovery" && !t.adoptionTurn) {
          if (!this.o.delivery?.needsAdoption) return this.hold(t, epoch, "recovery-demand-unavailable", "Task 8 must identify current durable obligations before automatic recovery inference.");
          if (!await this.o.delivery.needsAdoption(t.successor!, t.packet!)) {
            if (!t.adoptionDeferred) await this.change(t.id, epoch, (_s, current) => ({ transition: { ...current, adoptionDeferred: true }, hold: undefined }));
            return false;
          }
          if (t.adoptionDeferred) await this.change(t.id, epoch, (_s, current) => ({ transition: { ...current, adoptionDeferred: false }, hold: undefined }));
        }
        if (!await this.turn(s, epoch, "adoption")) return false;
        return this.change(t.id, epoch, (_s, current) => ({ transition: this.phase(current, "reconciling"), hold: undefined }));
      case "reconciling": {
        if (!this.o.workers || !this.o.delivery) return this.hold(t, epoch, "reconciliation-participants-missing", "Task 7 worker/attention and Task 8 delivery participants must both be wired before release.");
        // Keep the same in-flight operation after timeout; a polling tick must not run a
        // second participant invocation concurrently. Restart replay belongs to each durable seam.
        if (this.reconciliation?.id !== t.id) this.reconciliation = { id: t.id, work: (async () => {
          const holds = await this.o.workers!.reconcile(t.successor!, t.packet!);
          if (!this.o.lifecycle.permitsSuccession(epoch) || (await this.o.repository.read()).desired !== "enabled") return holds;
          return [...holds, ...await this.o.delivery!.reconcile(t.successor!, t.packet!)];
        })() };
        let reconciled: Awaited<ReturnType<typeof this.bounded<import("../domain/strigoi.js").StrigoiHold[]>>>;
        try { reconciled = await this.bounded(this.reconciliation.work); }
        catch (error) { return this.hold(t, epoch, "reconciliation-outcome-unresolved", `Participant failed with unresolved effects: ${String(error)}`); }
        if (!reconciled.done) return this.hold(t, epoch, "reconciliation-outcome-unresolved", "120-second reconciliation elapsed; the existing invocation remains in flight.");
        this.reconciliation = undefined;
        const continuationHolds = reconciled.value.filter(h => h.code === "STRIGOI_WORKFLOW_CONTINUATION_REQUIRED");
        const holds = reconciled.value.filter(h => h.code !== "STRIGOI_WORKFLOW_CONTINUATION_REQUIRED");
        if (holds.length) return this.change(t.id, epoch, () => ({ hold: holds[0] })).then(() => false);
        if (!this.o.registry.ownsProcess(t.successor!.sessionId) || this.o.registry.get(t.successor!.sessionId).exitCode !== null)
          return this.hold(t, epoch, "successor-unavailable", "The committed successor is unavailable; do not create another adoption chain.");
        return this.change(t.id, epoch, (_s, current) => ({ transition: this.phase(current, "complete"), continuationHolds, hold: undefined }));
      }
      default: return false;
    }
  }
  private async seal(s: StrigoiState, epoch: number): Promise<boolean> {
    const t = s.transition!;
    const drain = this.startDrain(t);
    if (!drain.done && !await drain.wait)
      return this.hold(t, epoch, "awaiting-safe-boundary", "120-second admission drain elapsed; the barrier remains closed and admitted work is not killed.");
    // A drain completion grants no authority by itself. Suspension/disposal can fence
    // this await, and later ticks must use the current transition and epoch.
    s = await this.o.repository.read();
    if (!this.o.lifecycle.permitsSuccession(epoch) || s.desired !== "enabled" || s.transition?.id !== t.id
      || !["requested", "checkpointing"].includes(s.transition.phase)) return false;
    let prepared: Awaited<ReturnType<StrigoiSuccession["preparePacket"]>>;
    try { prepared = await this.preparePacket(s); }
    catch (error) { return this.hold(t, epoch, "continuity-evidence-unavailable", `Cannot seal original continuity evidence: ${String(error)}`); }
    return this.change(t.id, epoch, (_s, current) => ({ transition: this.phase(current, "sealed", prepared), hold: undefined }));
  }
  private startDrain(t: StrigoiTransition) {
    if (this.drain?.id === t.id) return this.drain;
    const drain = { id: t.id, done: false, wait: Promise.resolve(false) };
    const work = this.o.admission.freeze(t.predecessor!).then(() => {
      drain.done = true;
      this.o.lifecycle.wakeSuccession(this.now() + 1);
    });
    drain.wait = this.bounded(work).then((result) => result.done);
    this.drain = drain;
    return drain;
  }
  private async preparePacket(s: StrigoiState) {
    const t = s.transition!;
    let prose = "No model checkpoint is available. Reconstruct understanding from the original evidence; unrecorded thoughts are unknown.";
    const refs = await this.o.sources.capture(s);
    if (s.latestPacket) {
      let cursor: string | undefined;
      do {
        const page = await this.o.packets.read(s.latestPacket, cursor); prose = page.packet.prose;
        refs.push(...page.sources.map(({ text: _text, ...ref }) => ref)); cursor = page.nextCursor;
      } while (cursor);
    } else if (t.checkpointTurn) {
      prose = (await this.o.turns.observe(t.checkpointTurn.id, t.predecessor!)).checkpoint ?? prose;
    }
    // Freeze/drain precedes capture publication and is always outside canonical authority.
    const unique = [...new Map(refs.map((ref) => [ref.coverageSourceId, ref])).values()];
    const packet = await this.o.packets.write(t.predecessor!, prose, unique, this.at());
    const manifest = (await this.o.packets.read(packet)).packet;
    return { packet, packetBytes: Buffer.byteLength(JSON.stringify(manifest)) };
  }
  private async turn(s: StrigoiState, epoch: number, kind: "checkpoint" | "adoption"): Promise<boolean> {
    const t = s.transition!, field = kind === "checkpoint" ? "checkpointTurn" : "adoptionTurn";
    const actor = kind === "checkpoint" ? t.predecessor! : t.successor!;
    const attempt = t[field];
    if (attempt) {
      const result = await this.o.turns.observe(attempt.id, actor);
      if (result.outcome === "completed") {
        if (kind === "adoption") {
          if (!result.adoption || JSON.stringify(result.adoption.identity) !== JSON.stringify(actor)
            || result.adoption.packetHash !== t.packet!.sha256 || result.adoption.coverageId !== t.packet!.coverageId)
            return this.hold(t, epoch, "adoption-invalid", "Completed provider turn is not a valid packet adoption receipt.");
          try { await this.o.continuity.acknowledge(result.adoption, `adopt:${attempt.id}`); }
          catch (error) {
            if (/STRIGOI_UNKNOWN_|ZodError/.test(String(error))) return this.hold(t, epoch, "adoption-invalid", `Adoption does not validate against captured coverage: ${String(error)}`);
            throw error;
          }
        } else if (!result.checkpoint?.trim()) return this.hold(t, epoch, "checkpoint-invalid", "Checkpoint turn completed without checkpoint prose.");
        const completed = { ...attempt, outcome: "completed" as const, endedAt: this.at(), usage: result.usage };
        await this.change(t.id, epoch, (_s, current) => ({ transition: { ...current, [field]: completed,
          turnHistory: [...current.turnHistory?.filter((a) => a.id !== attempt.id) ?? [], { ...completed, kind }] }, hold: undefined }));
        return true;
      }
      if (result.outcome === "unknown") {
        if (this.now() - Date.parse(attempt.startedAt) >= 120_000)
          return this.hold(t, epoch, `${kind}-outcome-unresolved`, "120-second attempt elapsed; rendered/submitted execution is unresolved and will not be retyped.");
        return false;
      }
      if (attempt.outcome !== "terminated") {
        const ended = { ...attempt, outcome: "terminated" as const, endedAt: this.at(), usage: result.usage };
        await this.change(t.id, epoch, (_s, current) => ({ transition: { ...current, [field]: ended,
          turnHistory: [...current.turnHistory?.filter((a) => a.id !== attempt.id) ?? [], { ...ended, kind }] } }));
      }
      if (attempt.attempt >= 2) return this.hold(t, epoch, `${kind}-retries-exhausted`, "Two terminated attempts exhausted; no unbounded inference retries.");
      // A proven refusal permits a later attempt, not a retry into the same owner/modal.
      const boundary = await this.o.turns.boundary(actor);
      if (boundary !== "safe") {
        if (boundary === "modal" || this.now() - Date.parse(attempt.startedAt) >= 120_000)
          return this.hold(t, epoch, boundary === "modal" ? "provider-permission-modal" : "awaiting-safe-boundary", "The refused turn awaits a confirmed safe boundary before retry.");
        return false;
      }
    }
    const next = { id: randomUUID(), attempt: (attempt?.attempt ?? 0) + 1, startedAt: this.at(), outcome: "unknown" as const };
    if (!await this.change(t.id, epoch, (_s, current) => ({ transition: { ...this.phase(current, kind === "checkpoint" ? "checkpointing" : "adopting"), [field]: next }, hold: undefined }))) return false;
    const submission = this.o.turns.submit(next.id, actor, kind, t.packet, (apply) => this.o.admission.run(actor.sessionId, "recovery", () => this.authority(async () => {
      const current = await this.o.repository.read();
      if (!this.o.lifecycle.permitsSuccession(epoch) || current.desired !== "enabled" || current.transition?.id !== t.id
        || current.transition[field]?.id !== next.id || current.activeBinding?.sessionId !== actor.sessionId
        || this.now() - Date.parse(next.startedAt) >= 120_000) throw fault("STRIGOI_SUBMISSION_FENCED");
      return apply();
    })));
    // A hung preflight/transport must not hide the 120s hold. The underlying call is not
    // cancelled or retried; it retains this attempt ID and the final deadline/epoch fence.
    if (!(await this.bounded(submission)).done) return this.hold(t, epoch, `${kind}-outcome-unresolved`, "120-second submission elapsed with unknown execution; no concurrent retry.");
    return false;
  }
  private async bounded<T>(work: Promise<T>): Promise<{ done: true; value: T } | { done: false }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([work.then((value) => ({ done: true as const, value })), new Promise<{ done: false }>((resolve) => {
        timer = setTimeout(() => resolve({ done: false }), 120_000); timer.unref?.();
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }
  private async launch(s: StrigoiState, epoch: number): Promise<boolean> {
    let t = s.transition!;
    if (s.hold?.code === "launch-configuration-failed" || s.hold?.code === "launch-retries-exhausted") return false;
    if (t.nextAttemptAt && Date.parse(t.nextAttemptAt) > this.now()) return false;
    if (!t.successor) {
      if (t.attempts >= 3) return this.hold(t, epoch, "launch-retries-exhausted", "Three passive launch attempts exhausted.");
      const successor = { sessionId: randomUUID(), incarnation: t.expectedIncarnation + 1, generation: 1 };
      if (!await this.change(t.id, epoch, (current, transition) => ({ transition: { ...transition, successor, attempts: transition.attempts + 1, launchStartedAt: undefined, nextAttemptAt: undefined },
        retainedSessionIds: [...current.retainedSessionIds, successor.sessionId], hold: undefined }))) return false;
      s = await this.o.repository.read(); t = s.transition!;
    }
    const successor = t.successor!, reservation = { sessionId: successor.sessionId, transitionId: t.id };
    if (!t.launchStartedAt) {
      // Claim before preparation, not just before spawn. Replay cannot repeat an unknown call.
      if (!await this.change(t.id, epoch, (_s, current) => ({ transition: { ...current, launchStartedAt: this.at() }, hold: undefined }))) return false;
      let enteredRegistry = false;
      try {
        const { request } = await this.o.manager.prepareResident(s.selection!);
        request.providerInstructions += `\n\n${strigoiPrompt(s)}`;
        if (!this.o.lifecycle.permitsSuccession(epoch)) throw fault("STRIGOI_SUSPENDED");
        enteredRegistry = true;
        await this.o.registry.start(request, undefined, async (record) => {
          await this.change(t.id, epoch, (_s, current) => ({ transition: { ...current, successor: { ...successor, generation: record.generation! } } }));
        }, undefined, (apply) => this.o.admission.run(t.predecessor!.sessionId, "recovery", () => this.authority(async () => {
          if (!this.o.lifecycle.permitsSuccession(epoch)) throw fault("STRIGOI_SUSPENDED");
          await this.o.lifecycle.validateReservation(reservation); return apply();
        })), reservation);
      } catch (error) {
        if (!enteredRegistry) return this.launchFailed(t, epoch, error);
        // Coordinator evidence, not a rejected Promise, determines whether execution happened.
      }
    }
    s = await this.o.repository.read(); t = s.transition!;
    const outcome = this.o.registry.launchOutcome(reservation, t.successor!.generation);
    if (outcome.kind === "failed") return this.launchFailed(t, epoch, outcome.error);
    if (outcome.kind !== "owned") return this.hold(t, epoch, "launch-ownership-unresolved", "Assigned launch has no matching owned execution or proven failure.");
    await this.o.admission.freeze(t.successor!);
    let failed: { error: unknown } | undefined;
    const committed = await this.change(t.id, epoch, (current, transition) => {
      const fresh = this.o.registry.launchOutcome(reservation, transition.successor!.generation);
      if (fresh.kind !== "owned") { if (fresh.kind === "failed") failed = fresh; return { hold: { code: "launch-ownership-unresolved", detail: "Execution changed before activation.", sourceIds: [successor.sessionId] } }; }
      const binding = current.activeBinding!;
      // Preserve the current effective grant, never defaults or packet authority.
      return { activeBinding: { ...binding, sessionId: fresh.session.id, updatedAt: this.at(), grant: { ...binding.grant, subjectSessionId: fresh.session.id }, resident: { name: "strigoi", incarnation: successor.incarnation } },
        activeGeneration: fresh.session.generation!, incarnation: successor.incarnation, latestPacket: transition.packet,
        transition: this.phase(transition, "committed"), hold: undefined };
    });
    if (failed) return this.launchFailed(t, epoch, failed.error);
    if (!committed) {
      if (this.o.registry.ownsProcess(successor.sessionId)) await this.o.registry.stopResidentProcess(successor.sessionId);
      return false;
    }
    return (await this.o.repository.read()).transition?.phase === "committed";
  }
  private async launchFailed(t: StrigoiTransition, epoch: number, error: unknown): Promise<boolean> {
    await this.change(t.id, epoch, (_s, current) => ({ transition: { ...current, successor: undefined, launchStartedAt: undefined,
      nextAttemptAt: new Date(this.now() + delays[t.attempts - 1]!).toISOString() },
      hold: strigoiLaunchFailureIsPermanent(error) ? { code: "launch-configuration-failed", detail: String(error), sourceIds: [] } : undefined }));
    return false;
  }
  private async event(s: StrigoiState) {
    const t = s.transition!, actor = t.successor ?? t.predecessor;
    if (!actor || !this.o.activity) return;
    await this.o.activity.append({ schemaVersion: 1, eventId: randomUUID(), runId: t.id, sessionId: actor.sessionId, workerId: actor.sessionId,
      generation: actor.generation, sourceKey: `strigoi:${t.id}:${s.revision}`, kind: "worker.lifecycle", operation: "lifecycle",
      provenance: "broker", coverage: "partial", outcome: s.hold ? "unknown" : "observed", observedAt: s.updatedAt,
      startedAt: t.requestedAt, payloadRef: `strigoi:revision:${s.revision}`, provider: s.selection?.provider, model: s.selection?.model,
      succession: { transitionId: t.id, phase: t.phase, reason: t.reason, launchAttempts: t.attempts,
        checkpointAttempts: t.checkpointTurn?.attempt ?? 0, adoptionAttempts: t.adoptionTurn?.attempt ?? 0,
        phaseTimes: t.phaseTimes ?? {}, packetManifestBytes: t.packetBytes, checkpointOutcome: t.checkpointTurn?.outcome,
        adoptionOutcome: t.adoptionTurn?.outcome, hold: s.hold?.code, usage: null,
        turns: [...t.turnHistory ?? [], ...t.checkpointTurn && !t.turnHistory?.some((a) => a.id === t.checkpointTurn!.id) ? [{ ...t.checkpointTurn, kind: "checkpoint" as const }] : [],
          ...t.adoptionTurn && !t.turnHistory?.some((a) => a.id === t.adoptionTurn!.id) ? [{ ...t.adoptionTurn, kind: "adoption" as const }] : []]
          .map((turn) => ({ ...turn, usage: turn.usage ?? null })) } });
  }
}
