import { randomUUID } from "node:crypto";
import {
  ResourcePolicySchema, ResourceRequestSchema,
  type ResourceAdmissionPort, type ResourceDecision, type ResourceEnvironment, type ResourceLedger,
  type ResourceLedgerPort, type ResourcePolicy, type ResourceRequest, type ResourceReservation,
} from "../domain/resource-budget.js";

/** Additional capacity gate. Its callers must have already resolved canonical authority. */
export class ResourceAdmissionService implements ResourceAdmissionPort {
  private tail: Promise<unknown> = Promise.resolve();
  private reconciled = false;
  private draining = false;
  private readonly policy: ResourcePolicy;
  constructor(private readonly store: ResourceLedgerPort, policy: ResourcePolicy,
    private readonly environment: () => ResourceEnvironment,
    private readonly verifyTermination: (reservation: ResourceReservation, evidenceId: string) => Promise<boolean | "never-launched">,
    private readonly now: () => number = Date.now) {
    this.policy = ResourcePolicySchema.parse(policy);
  }

  /** External reconciliation is mandatory after every restart, even with an empty ledger. */
  async reconcile(verify: (held: readonly ResourceReservation[]) => Promise<boolean>): Promise<void> {
    return this.serial(async () => {
      this.reconciled = false;
      const held = this.store.read().entries.filter(e => e.state === "admitted");
      if (!await verify(held)) throw new Error("RESOURCE_RECONCILIATION_REQUIRED");
      this.reconciled = true;
    });
  }

  async request(input: ResourceRequest): Promise<ResourceDecision> {
    const request = ResourceRequestSchema.parse(input);
    return this.serial(async () => {
      const ledger = this.store.read();
      if (request.owner.installationId !== ledger.installationId) throw new Error("RESOURCE_INSTALLATION_MISMATCH");
      const prior = ledger.entries.find(e => e.request.requestId === request.requestId);
      if (prior && JSON.stringify(prior.request) !== JSON.stringify(request)) throw new Error("RESOURCE_REQUEST_CONFLICT");
      if (prior?.state === "cancelled" || prior?.state === "released") throw new Error("RESOURCE_REQUEST_TERMINAL");
      // Temporary observed overhead queues feasible work; it does not change feasibility.
      const pool = this.policy.totalBytes - this.policy.fixedBytes - this.policy.uncertainBytes - this.policy.controlMarginBytes;
      if (request.demand.memoryBytes > pool || request.demand.pidLimit > this.policy.maxPids) {
        return { state: "resource-infeasible", reason: request.demand.pidLimit > this.policy.maxPids ? "pid-limit" : "memory-envelope",
          requiredBytes: request.demand.memoryBytes, availableBytes: pool };
      }
      const generation = request.owner.generation;
      // Cancelled entries were never admitted: cancel() refuses every admitted reservation.
      // A released generation remains fenced unless its owner durably proved launch never began.
      const related = ledger.entries.filter(e => e.request.owner.workloadId === request.owner.workloadId);
      if (related.some(e => (e.request.owner.generation ?? 0) > (generation ?? 0)
        || e.request.requestId !== request.requestId && (e.state === "admitted" || e.state === "waiting-capacity"
          || e.request.owner.generation === generation && e.state !== "cancelled" && e.terminationKind !== "never-launched"))) throw new Error("RESOURCE_GENERATION_CONFLICT");
      if (!prior) {
        if (ledger.entries.length >= 10000 || ledger.entries.filter(e => e.state === "waiting-capacity").length >= this.policy.maxQueue)
          throw new Error("RESOURCE_LEDGER_BACKPRESSURE");
        ledger.entries.push({ request, sequence: ledger.nextSequence++, queuedAt: new Date(this.now()).toISOString(),
          state: "waiting-capacity", reservationId: randomUUID(), bypasses: 0 });
      }
      this.schedule(ledger);
      await this.persist(ledger);
      return this.decision(ledger.entries.find(e => e.request.requestId === request.requestId)!);
    });
  }

  async lookupReservation(input: ResourceRequest): Promise<string | undefined> {
    const request = ResourceRequestSchema.parse(input);
    return this.serial(async () => {
      const entry = this.store.read().entries.find(entry => entry.request.requestId === request.requestId);
      if (entry && JSON.stringify(entry.request) !== JSON.stringify(request)) throw new Error("RESOURCE_REQUEST_CONFLICT");
      return entry?.state === "admitted" ? entry.reservationId : undefined;
    });
  }

  async refresh(): Promise<void> {
    return this.serial(async () => {
      const ledger = this.store.read(); this.schedule(ledger); await this.persist(ledger);
    });
  }

  async cancel(requestId: string): Promise<void> {
    return this.serial(async () => {
      const ledger = this.store.read(), entry = ledger.entries.find(e => e.request.requestId === requestId);
      if (!entry || entry.state === "cancelled" || entry.state === "released") return;
      // A caller must terminate even a reserved-but-not-yet-spawned attempt through its owner.
      if (entry.state === "admitted") throw new Error("RESOURCE_TERMINATION_REQUIRED");
      entry.state = "cancelled"; this.schedule(ledger); await this.persist(ledger);
    });
  }

  async release(input: { reservationId: string; terminationEvidenceId: string }): Promise<void> {
    return this.serial(async () => {
      const ledger = this.store.read(), entry = ledger.entries.find(e => e.reservationId === input.reservationId);
      if (!entry) throw new Error("RESOURCE_RESERVATION_UNKNOWN");
      if (entry.state === "released") return;
      if (entry.state !== "admitted" || !input.terminationEvidenceId) throw new Error("RESOURCE_TERMINATION_UNCONFIRMED");
      const proof = await this.verifyTermination(structuredClone(entry), input.terminationEvidenceId);
      if (proof !== true && proof !== "never-launched") throw new Error("RESOURCE_TERMINATION_UNCONFIRMED");
      entry.state = "released"; entry.terminationEvidenceId = input.terminationEvidenceId;
      if (proof === "never-launched") entry.terminationKind = proof;
      this.schedule(ledger); await this.persist(ledger);
    });
  }

  drain(): void { this.draining = true; }
  health() {
    const ledger = this.store.read(), held = ledger.entries.filter(e => e.state === "admitted");
    return { policy: this.policy, hold: this.hold(), reservedBytes: held.reduce((n, e) => n + e.request.demand.memoryBytes, 0),
      reservedPids: held.reduce((n, e) => n + e.request.demand.pidLimit, 0),
      queue: ledger.entries.filter(e => e.state === "waiting-capacity").map(e => ({ requestId: e.request.requestId,
        familyId: e.request.owner.familyId, queuedAt: e.queuedAt, demand: e.request.demand, reason: this.hold() ?? "reserved-capacity" })),
      reservations: held, revision: ledger.revision };
  }

  private pool(): number {
    const observed = this.environment().unreservedBytes;
    const fixed = observed !== undefined && observed !== null && Number.isFinite(observed) && observed >= 0
      ? Math.max(this.policy.fixedBytes, observed) : this.policy.fixedBytes;
    return Math.max(0, this.policy.totalBytes - fixed - this.policy.uncertainBytes - this.policy.controlMarginBytes);
  }
  private hold(): string | null {
    if (!this.reconciled) return "reconciliation";
    if (this.draining) return "draining";
    const env = this.environment(), age = this.now() - env.observedAt;
    if (env.captureHold) return env.captureHold;
    if (env.observedBytes === null || env.unreservedBytes === null
      || [env.observedBytes, env.unreservedBytes].some(n => n !== undefined && (!Number.isFinite(n) || n! < 0)))
      return "metrics-unavailable";
    if (env.observedBytes !== undefined && env.observedBytes >= this.policy.totalBytes) return "observed-budget";
    if (age < 0 || age > this.policy.maxMetricAgeMs || !env.attributionComplete || env.availableBytes === null
      || !Number.isFinite(env.availableBytes) || env.availableBytes < 0) return "metrics-unavailable";
    if (env.pressure !== "normal") return "host-pressure";
    return null;
  }
  private schedule(ledger: ResourceLedger): void {
    if (this.hold()) return;
    const held = ledger.entries.filter(e => e.state === "admitted");
    let memory = held.reduce((n, e) => n + e.request.demand.memoryBytes, 0);
    let pids = held.reduce((n, e) => n + e.request.demand.pidLimit, 0);
    // Available host headroom is consumed by this batch, never multiplied per new request.
    let headroom = this.environment().availableBytes! - this.policy.controlMarginBytes - memory;
    const pending = ledger.entries.filter(e => e.state === "waiting-capacity").sort((a, b) => a.sequence - b.sequence);
    while (pending.length) {
      const oldest = pending[0]!;
      const family = (e: ResourceReservation) => e.request.owner.familyId ?? e.request.owner.kind;
      const fronts = pending.filter((e, index) => pending.findIndex(other => family(other) === family(e)) === index);
      // Bounded bypass overrides round-robin, including background work, to prevent starvation.
      const candidates = oldest.bypasses >= this.policy.maxBypass ? [oldest]
        : [...fronts.filter(e => family(e) !== ledger.lastFamily), ...fronts.filter(e => family(e) === ledger.lastFamily)];
      const candidate = candidates.find(e => memory + e.request.demand.memoryBytes <= this.pool()
        && e.request.demand.memoryBytes <= headroom && pids + e.request.demand.pidLimit <= this.policy.maxPids);
      if (!candidate) break;
      for (const skipped of pending) if (skipped.sequence < candidate.sequence) skipped.bypasses++;
      candidate.state = "admitted"; ledger.lastFamily = family(candidate);
      memory += candidate.request.demand.memoryBytes; headroom -= candidate.request.demand.memoryBytes;
      pids += candidate.request.demand.pidLimit; pending.splice(pending.indexOf(candidate), 1);
    }
  }
  private decision(entry: ResourceReservation): ResourceDecision {
    return entry.state === "admitted" && !this.hold() ? { state: "admitted", reservationId: entry.reservationId, demand: entry.request.demand }
      : { state: "waiting-capacity", reason: this.hold() ?? "reserved-capacity", queuedAt: entry.queuedAt };
  }
  private async persist(ledger: ResourceLedger): Promise<void> {
    // A queued poll or unchanged refresh is not a new durable state transition.
    if (JSON.stringify(ledger) === JSON.stringify(this.store.read())) return;
    const revision = ledger.revision; ledger.revision++; await this.store.save(ledger, revision);
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation); this.tail = result.catch(() => undefined); return result;
  }
}
