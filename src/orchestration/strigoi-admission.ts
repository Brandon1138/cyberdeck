import { AsyncLocalStorage } from "node:async_hooks";
import { grantAllows } from "../domain/capability.js";
import type { InstructionAdmission, InstructionRecord } from "../domain/instruction.js";
import type { StrigoiIdentity } from "../domain/strigoi.js";
import type { StrigoiAdmissionPort, StrigoiRepository } from "./strigoi-ports.js";
import type { OrchestratorBindingReader, SessionLookupPort } from "./session/session-ports.js";

type Permit = { actor: string; live: boolean; after: Array<() => Promise<unknown>> };
const key = (identity: StrigoiIdentity): string => JSON.stringify([identity.sessionId, identity.incarnation, identity.generation]);
export class StrigoiAdmissionError extends Error {
  constructor(readonly code: string) { super(code); this.name = "StrigoiAdmissionError"; }
}

/**
 * One instance per broker, shared by every application service.
 *
 * This is a draining barrier, not a mutex. Mutations use permit -> service serializer
 * -> repository calls; peer creation waits for its creator serializer before admission.
 * Final delivery uses target serializer -> fresh permit -> binding read -> optional
 * attention transaction -> write. The apparent inversion is safe: admission never waits
 * for a mutation permit, and deferred delivery releases the outer permit before entering
 * provider preflight. Never await freeze inside a permit or service serializer, and
 * never call admission while holding the canonical binding-authority transaction.
 * Peer/modal effects hold that canonical queue through their final checks and effect.
 * Reentrant store calls reuse its live owner; no provider preflight belongs there.
 * Lifecycle must close/drain
 * before committing cutover/suspension; durable desired/phase state also fences restart.
 * Launch uses creator serializer -> discovery/provider/executor preparation (no permit)
 * -> fresh permit and grants -> binding/budget activation and spawn. Provider initialization
 * follows permit release. No inference or worker-result wait belongs inside run.
 *
 * Nested mutations inherit a live internal permit, including while freeze drains it.
 * Queue delivery is deferred until the outer permit releases; provider preflight has
 * no permit. The final write acquires fresh admission and current grants. Expired
 * async contexts cannot reuse a permit. Recovery is internal read-only classification,
 * never an RPC input, and grants remain the responsibility of each existing service.
 */
export class StrigoiAdmission implements StrigoiAdmissionPort {
  private readonly context = new AsyncLocalStorage<Permit>();
  private readonly closed = new Set<string>();
  private readonly freezeEpochs = new Map<string, number>();
  private readonly active = new Map<string, number>();
  private readonly drained = new Map<string, Array<() => void>>();
  constructor(
    private readonly repository: Pick<StrigoiRepository, "read" | "retentionPins">,
    private readonly bindings: OrchestratorBindingReader,
    private readonly registry: SessionLookupPort,
  ) {}

  async run<T>(actorSessionId: string, operation: "read" | "mutate" | "recovery", apply: () => Promise<T>): Promise<T> {
    const parent = this.context.getStore();
    if (operation === "mutate" && parent?.live && parent.actor === actorSessionId) return apply();
    const generation = this.generation(actorSessionId);
    // Established unrelated bindings remain usable when the resident shard is corrupt.
    // The typed binding lookup is fail-closed for unknown/resident actors; never catch it.
    const binding = await this.bindings.findBySessionId(actorSessionId);
    let state;
    try { state = await this.repository.read(); }
    catch (error) {
      // Task 2 explicitly preserves established unrelated bindings on resident-only corruption.
      if (binding !== undefined && binding.kind !== "resident" && typeof error === "object" && error !== null
        && "code" in error && error.code === "STRIGOI_CORRUPT_STATE") return apply();
      throw error;
    }
    const resident = state.activeBinding?.sessionId === actorSessionId;
    if (!resident) {
      const pins = await this.repository.retentionPins();
      if (pins.has(actorSessionId) || state.retainedSessionIds.includes(actorSessionId)
        || state.transition?.predecessor?.sessionId === actorSessionId
        || state.transition?.successor?.sessionId === actorSessionId) throw new StrigoiAdmissionError("STRIGOI_STALE_INCARNATION");
      return apply();
    }
    if (generation !== state.activeGeneration || this.generation(actorSessionId) !== generation) throw new StrigoiAdmissionError("STRIGOI_STALE_INCARNATION");
    if (operation !== "mutate") return apply();
    const identity = key({ sessionId: actorSessionId, incarnation: state.incarnation, generation: state.activeGeneration! });
    if (this.closed.has(identity)) throw new StrigoiAdmissionError("STRIGOI_FROZEN");
    if (state.desired !== "enabled") throw new StrigoiAdmissionError("STRIGOI_SUSPENDED");
    if (state.hold?.code === "continuity-evidence-unavailable") throw new StrigoiAdmissionError("STRIGOI_EVIDENCE_UNAVAILABLE");
    if (state.transition !== undefined && ["sealed", "retiring", "launching", "committed", "adopting", "reconciling"].includes(state.transition.phase)) {
      throw new StrigoiAdmissionError("STRIGOI_RECOVERING");
    }
    const permit: Permit = { actor: actorSessionId, live: true, after: [] };
    this.active.set(identity, (this.active.get(identity) ?? 0) + 1);
    let result: T;
    try { result = await this.context.run(permit, apply); }
    finally {
      permit.live = false;
      const remaining = this.active.get(identity)! - 1;
      if (remaining > 0) this.active.set(identity, remaining);
      else {
        this.active.delete(identity);
        for (const resolve of this.drained.get(identity) ?? []) resolve();
        this.drained.delete(identity);
      }
      // Even partially completed mutations can have persisted instructions to flush.
      await this.context.exit(() => Promise.all(permit.after.map((work) => work())));
    }
    return result;
  }

  freeze(identity: StrigoiIdentity): Promise<void> {
    const id = key(identity);
    this.closed.add(id);
    this.freezeEpochs.set(id, (this.freezeEpochs.get(id) ?? 0) + 1);
    if (!this.active.has(id)) return Promise.resolve();
    return new Promise((resolve) => this.drained.set(id, [...this.drained.get(id) ?? [], resolve]));
  }

  /** Internal lifecycle seam for explicit abort/resume; no RPC exposes this operation. */
  async reopen(identity: StrigoiIdentity): Promise<void> {
    const id = key(identity), epoch = this.freezeEpochs.get(id);
    const state = await this.repository.read();
    if (state.activeBinding?.sessionId !== identity.sessionId || state.incarnation !== identity.incarnation
      || state.activeGeneration !== identity.generation || this.generation(identity.sessionId) !== identity.generation) {
      throw new StrigoiAdmissionError("STRIGOI_STALE_INCARNATION");
    }
    if (state.desired !== "enabled") throw new StrigoiAdmissionError("STRIGOI_SUSPENDED");
    if (state.transition !== undefined && !["aborted", "complete"].includes(state.transition.phase)) {
      throw new StrigoiAdmissionError("STRIGOI_RECOVERING");
    }
    if (this.active.has(id) || this.freezeEpochs.get(id) !== epoch) throw new StrigoiAdmissionError("STRIGOI_FROZEN");
    this.closed.delete(id);
  }

  /** Queue-only seam: do not retain an enclosing mutation permit through provider preflight. */
  deferDelivery(work: () => Promise<unknown>): boolean {
    const permit = this.context.getStore();
    if (!permit?.live) return false;
    permit.after.push(work);
    return true;
  }

  instruction(record: InstructionRecord): InstructionAdmission {
    return (apply) => this.run(record.actorSessionId, "mutate", async () => {
      const write = async () => {
        if (record.brokerOwned !== true) {
          const binding = await this.bindings.findBySessionId(record.actorSessionId);
          if (binding === undefined) throw new StrigoiAdmissionError("ACTOR_NOT_AUTHORIZED");
          if (!grantAllows(binding.grant, "thread.enqueue", this.registry.get(record.targetSessionId))) {
            throw new StrigoiAdmissionError("CAPABILITY_DENIED");
          }
        }
        return apply();
      };
      // Workflow sender and owner are separate authorities; neither may be a retired resident.
      return record.senderSessionId !== undefined && record.senderSessionId !== record.actorSessionId
        ? this.run(record.senderSessionId, "mutate", write) : write();
    });
  }

  private generation(actor: string): number | undefined {
    try { return this.registry.get(actor).generation ?? 1; } catch { return undefined; }
  }
}

/** Optional only for legacy embeddings/tests; production composes the single shared instance. */
export function admitted<T>(admission: StrigoiAdmission | undefined, actor: string | undefined,
  apply: () => Promise<T>, operation: "read" | "mutate" | "recovery" = "mutate"): Promise<T> {
  return admission === undefined || actor === undefined ? apply() : admission.run(actor, operation, apply);
}
