import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { ResourceDemand, ResourceRequest, ResourceReservation } from "../domain/resource-budget.js";
import type { SessionRecord } from "../domain/session.js";
import type { SessionRuntime } from "../domain/session-runtime.js";
import type { ResourceRuntimeBinding, ResourceRuntimeBindingPort, ResourceRuntimeIdentity,
  ResourceRuntimeInspection, ResourceSessionLaunchPort } from "../domain/resource-runtime.js";
import type { ResourceAdmissionService } from "./resource-admission-service.js";

export interface ResourceExecutionGateOptions {
  installationId: string;
  admission: ResourceAdmissionService;
  bindings: ResourceRuntimeBindingPort;
  /** Use orchestratorController()/existing canonical worker lease authority in composition. */
  resolveFamily: (record: SessionRecord) => string | Promise<string>;
  resolveDemand: (record: SessionRecord) => ResourceDemand | Promise<ResourceDemand>;
  /** Return precise provider AND helper identities; rejection leaves the launch reservation held. */
  capture: (binding: ResourceRuntimeBinding, runtime: SessionRuntime) => Promise<ResourceRuntimeIdentity[]>;
  /** Never infer tree termination from the root PID or PTY exit alone. */
  inspect: (binding: ResourceRuntimeBinding) => Promise<ResourceRuntimeInspection>;
  pollMs?: number;
}

/** Durable reservation surrounds provider preparation as well as spawn, including Orc daemons. */
export class ResourceExecutionGate implements ResourceSessionLaunchPort {
  private readonly starts = new Map<string, AbortController>();
  private readonly settlements = new Set<Promise<unknown>>();
  private closed = false;
  private readonly abandonedBeforeSpawn = new Set<string>();
  constructor(private readonly options: ResourceExecutionGateOptions) {}

  start(record: SessionRecord, launch: () => Promise<SessionRuntime>): Promise<SessionRuntime> {
    if (this.closed) return Promise.reject(new Error("RESOURCE_ADMISSION_CLOSED"));
    if (this.starts.has(record.id)) return Promise.reject(new Error("RESOURCE_LAUNCH_BUSY"));
    const controller = new AbortController(); this.starts.set(record.id, controller);
    const operation = this.startExclusive(record, launch, controller.signal).finally(() => {
      this.starts.delete(record.id); this.settlements.delete(operation);
    });
    this.settlements.add(operation); return operation;
  }
  cancelStart(sessionId: string): boolean {
    const controller = this.starts.get(sessionId);
    if (!controller) return false;
    controller.abort(new Error("RESOURCE_QUEUE_CANCELLED")); return true;
  }
  async close(): Promise<void> {
    this.closed = true; this.options.admission.drain();
    for (const controller of this.starts.values()) controller.abort(new Error("RESOURCE_ADMISSION_CLOSED"));
    await Promise.allSettled([...this.settlements]);
  }
  /** The container executor uses this exact generation's envelope, never a profile guess. */
  demand(sessionId: string, generation: number): ResourceDemand | undefined {
    const reservation = this.options.admission.health().reservations.find(entry =>
      entry.request.owner.workloadId === sessionId && entry.request.owner.generation === generation);
    return reservation ? structuredClone(reservation.request.demand) : undefined;
  }
  /** Wire directly into ResourceAdmissionService's verifier. Evidence cannot cross a generation. */
  async verifyTermination(reservation: ResourceReservation, evidenceId: string): Promise<boolean> {
    const binding = this.options.bindings.get(reservation.request.requestId);
    if (!binding || evidenceId !== binding.request.requestId
      || JSON.stringify(binding.request) !== JSON.stringify(reservation.request)) return false;
    if (binding.phase === "terminated") return true;
    if (binding.phase === "queued" || binding.phase === "reserved")
      return !this.starts.has(binding.request.owner.workloadId) || this.abandonedBeforeSpawn.has(binding.request.requestId);
    const inspection = await this.options.inspect(binding);
    return inspection.state === "terminated" && inspection.inventoryComplete;
  }
  /** Reconcile *all* held work before admission opens. Unknown spawn gaps remain held. */
  async reconcile(): Promise<void> {
    if (this.starts.size) throw new Error("RESOURCE_RECONCILIATION_DURING_LAUNCH");
    const terminated: ResourceReservation[] = [];
    await this.options.admission.reconcile(async held => {
      let complete = true;
      for (const reservation of held) {
        const binding = this.options.bindings.get(reservation.request.requestId);
        if (!binding || JSON.stringify(binding.request) !== JSON.stringify(reservation.request)) { complete = false; continue; }
        if (binding.phase === "queued" || binding.phase === "reserved" || binding.phase === "terminated") {
          terminated.push(reservation); continue;
        }
        const inspection = await this.options.inspect(binding);
        if (inspection.state === "unknown" || !inspection.inventoryComplete) { complete = false; continue; }
        if (inspection.state === "terminated") terminated.push(reservation);
        else {
          if (!inspection.identities.length) { complete = false; continue; }
          const identities = [...binding.identities, ...inspection.identities.filter(identity =>
            !binding.identities.some(prior => JSON.stringify(prior) === JSON.stringify(identity)))];
          await this.options.bindings.put({ ...binding, phase: "bound", identities });
        }
      }
      return complete;
    });
    for (const reservation of terminated) await this.release(reservation.request.requestId);
  }
  /** Periodic cleanup/recovery may retry this; a runtime exit callback is only a hint. */
  async release(requestId: string): Promise<void> {
    const binding = this.options.bindings.get(requestId);
    if (!binding) throw new Error("RESOURCE_BINDING_UNKNOWN");
    const reservation = this.options.admission.health().reservations.find(e => e.request.requestId === requestId);
    if (!reservation) return;
    await this.options.admission.release({ reservationId: reservation.reservationId, terminationEvidenceId: requestId });
    await this.options.bindings.put({ ...binding, phase: "terminated" });
  }
  private async startExclusive(record: SessionRecord, launch: () => Promise<SessionRuntime>, signal: AbortSignal): Promise<SessionRuntime> {
    const familyId = await this.options.resolveFamily(record);
    if (!familyId) throw new Error("RESOURCE_CANONICAL_FAMILY_REQUIRED");
    const request: ResourceRequest = { requestId: randomUUID(), owner: {
      installationId: this.options.installationId, workloadId: record.id, generation: record.generation ?? 1,
      kind: record.kind === "orchestrator" ? "orchestrator" : "worker", familyId,
    }, demand: await this.options.resolveDemand(record), priority: "interactive" };
    let binding: ResourceRuntimeBinding = { request, phase: "queued", identities: [] };
    await this.options.bindings.put(binding);
    let runtime: SessionRuntime | undefined;
    try {
      signal.throwIfAborted();
      for (;;) {
        const decision = await this.options.admission.request(request);
        signal.throwIfAborted();
        if (decision.state === "resource-infeasible") throw new Error(`RESOURCE_INFEASIBLE:${decision.requiredBytes}:${decision.availableBytes}`);
        if (decision.state === "admitted") break;
        await delay(this.options.pollMs ?? 250, undefined, { signal });
      }
      binding = { ...binding, phase: "reserved" }; await this.options.bindings.put(binding);
      signal.throwIfAborted();
      if (await this.options.resolveFamily(record) !== familyId) throw new Error("RESOURCE_CANONICAL_FAMILY_CHANGED");
      // This fsynced transition precedes every side effect of prepareLaunch. No recovery may
      // release a launching binding merely because PID/container binding never reached disk.
      binding = { ...binding, phase: "launching" }; await this.options.bindings.put(binding);
      runtime = await launch();
      const identities = await this.options.capture(binding, runtime);
      if (!identities.length) throw new Error("RESOURCE_RUNTIME_IDENTITY_UNAVAILABLE");
      binding = { ...binding, phase: "bound", identities }; await this.options.bindings.put(binding);
      signal.throwIfAborted();
      runtime.onExit(() => { void this.release(request.requestId).catch(() => undefined); });
      return runtime;
    } catch (error) {
      // Kill is a request, never termination evidence; helpers may survive the provider.
      try { runtime?.kill("SIGTERM"); } catch { /* retained reservation exposes cleanup debt */ }
      if (binding.phase === "queued" || binding.phase === "reserved") this.abandonedBeforeSpawn.add(request.requestId);
      const admitted = this.options.admission.health().reservations.some(e => e.request.requestId === request.requestId);
      if (admitted) await this.release(request.requestId).catch(() => undefined);
      else await this.options.admission.cancel(request.requestId);
      this.abandonedBeforeSpawn.delete(request.requestId);
      throw error;
    }
  }
}
