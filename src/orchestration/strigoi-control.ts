import { grantAllows } from "../domain/capability.js";
import type { StrigoiAdoption, StrigoiIdentity, StrigoiPacketRef, StrigoiSelection, StrigoiSourceRef } from "../domain/strigoi.js";
import type { StrigoiLifecycle, StrigoiLifecycleOptions } from "./strigoi-lifecycle.js";
import type { StrigoiContinuity } from "./strigoi-continuity.js";
import type { StrigoiSuccession } from "./strigoi-succession.js";
import type { StrigoiDeliveryPort } from "./strigoi-ports.js";

const fail = (code: string) => Object.assign(new Error(code), { code });
/** Thin application facade: canonical lifecycle, continuity and instruction services own all state. */
export class StrigoiControl {
  constructor(private readonly o: Pick<StrigoiLifecycleOptions, "repository" | "registry" | "admission"> & {
    lifecycle: StrigoiLifecycle; continuity: StrigoiContinuity; succession: StrigoiSuccession;
    delivery: StrigoiDeliveryPort; validateSelection(selection: StrigoiSelection): Promise<void>;
  }) {}
  inspect() { return this.o.lifecycle.inspect(); }
  async configure(selection: StrigoiSelection, mutationId: string) {
    await this.o.validateSelection(selection);
    await this.o.lifecycle.configure(selection, mutationId);
    // Configure commits its own desired state once. A later suspension must not be overwritten.
    // Re-enabling an existing suspended selection uses explicit resume.
    this.wake(); return this.inspect();
  }
  async desired(desired: "enabled" | "suspended" | "disabled", mutationId: string) {
    await this.o.lifecycle.setDesired(desired, mutationId);
    if (desired === "enabled") this.wake();
    return this.inspect();
  }
  async renew(expectedIncarnation: number, reason: string, mutationId: string) {
    const result = await this.o.succession.renew(expectedIncarnation, reason, mutationId);
    this.wake(); return result;
  }
  submit(message: string, messageId: string) { return this.o.delivery.submit(message, messageId); }
  async checkpoint(actor: string, prose: string, sources: StrigoiSourceRef[], mutationId: string) {
    const identity = await this.actor(actor, "thread.enqueue");
    return this.o.continuity.checkpoint(identity, prose, sources, mutationId, this.guard(identity, "thread.enqueue"));
  }
  async read(actor: string, packet: StrigoiPacketRef, cursor?: string) {
    const identity = await this.actor(actor, "thread.read");
    return this.o.continuity.read(identity, packet, cursor, this.guard(identity, "thread.read"));
  }
  async acknowledge(actor: string, adoption: Omit<StrigoiAdoption, "identity">, mutationId: string) {
    const identity = await this.actor(actor, "thread.enqueue");
    await this.o.continuity.acknowledge({ ...adoption, identity }, mutationId, this.guard(identity, "thread.enqueue"));
    this.wake(); return { acknowledged: true };
  }
  async agentRenew(actor: string, reason: string, mutationId: string) {
    const identity = await this.actor(actor, "thread.enqueue");
    // renew records intent only. Never drain admission while holding this permit.
    const result = await this.o.admission.run(actor, "mutate", () => this.o.succession.renew(identity.incarnation, reason, mutationId, this.guard(identity, "thread.enqueue")));
    this.wake(); return result;
  }
  private wake() { this.o.lifecycle.wakeSuccession(Date.now()); }
  private guard(identity: StrigoiIdentity, capability: "thread.read" | "thread.enqueue") {
    return async () => {
      const current = await this.actor(identity.sessionId, capability);
      if (current.incarnation !== identity.incarnation || current.generation !== identity.generation) throw fail("STRIGOI_STALE_INCARNATION");
    };
  }
  private async actor(actor: string, capability: "thread.read" | "thread.enqueue"): Promise<StrigoiIdentity> {
    const state = await this.o.repository.read(), binding = state.activeBinding;
    if (binding?.sessionId !== actor || this.o.registry.get(actor).generation !== state.activeGeneration) throw fail("STRIGOI_STALE_INCARNATION");
    if (!grantAllows(binding.grant, capability, { sessionId: actor, cwd: binding.cwd })) throw fail("CAPABILITY_DENIED");
    if (capability !== "thread.read" && state.desired !== "enabled") throw fail("STRIGOI_SUSPENDED");
    return { sessionId: actor, incarnation: state.incarnation, generation: state.activeGeneration! };
  }
}

/** Generic worker controls cannot bypass the resident's orchestrator stop policy or drain their own permit. */
export async function refuseResidentWorkerControl(record: import("../domain/session.js").SessionRecord | undefined,
  bindings: import("./persistence-ports.js").OrchestratorBindingLookup): Promise<void> {
  if (record?.kind === "orchestrator" && (await bindings.findBySessionId(record.id))?.kind === "resident") {
    throw Object.assign(new Error("Strigoi requires resident lifecycle control; use strigoi suspend or the authorized orchestrator stop path"), { code: "STRIGOI_LIFECYCLE_REQUIRED" });
  }
}
