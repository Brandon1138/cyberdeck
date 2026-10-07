import { describe, expect, it } from "vitest";
import { ResourceAdmissionService } from "../../src/orchestration/resource-admission-service.js";
import { ResourcePolicySchema, type ResourceEnvironment, type ResourceLedger, type ResourceLedgerPort, type ResourceRequest } from "../../src/domain/resource-budget.js";

const GiB = 1024 ** 3, MiB = 1024 ** 2;
class Store implements ResourceLedgerPort {
  value: ResourceLedger = { schemaVersion: 1, installationId: "test", revision: 0, nextSequence: 0, lastFamily: null, entries: [] };
  read() { return structuredClone(this.value); }
  async save(next: ResourceLedger, expected: number) {
    if (expected !== this.value.revision) throw new Error("conflict"); this.value = structuredClone(next);
  }
}
function request(id: string, family = "a", memoryBytes = 768 * MiB): ResourceRequest {
  return { requestId: id, owner: { installationId: "test", workloadId: id, familyId: family, kind: "worker", generation: 1 },
    demand: { memoryBytes, cpuWeight: 100, pidLimit: 64, profileId: "synthetic", profileVersion: "1" }, priority: "interactive" };
}
async function fixture() {
  const store = new Store();
  const env: ResourceEnvironment = { observedAt: 100, pressure: "normal", availableBytes: 20 * GiB, attributionComplete: true };
  const policy = ResourcePolicySchema.parse({ fixedBytes: GiB, uncertainBytes: GiB / 2, controlMarginBytes: GiB / 2, maxPids: 2048, maxBypass: 2 });
  const make = () => new ResourceAdmissionService(store, policy, () => env, async (_, id) => id === "terminated", () => 100);
  const service = make(); await service.reconcile(async () => true);
  return { service, store, env, make };
}
describe("shared resource admission", () => {
  it("preserves held identity for cleanup while withholding prelaunch permission behind global recovery and pressure", async () => {
    const { service, env, make } = await fixture(), input = request("reserved-before-crash");
    const granted = await service.request(input); if (granted.state !== "admitted") throw new Error("setup");
    const restarted = make();
    expect(await restarted.request(input)).toMatchObject({ state: "waiting-capacity", reason: "reconciliation" });
    expect(await restarted.lookupReservation(input)).toBe(granted.reservationId);
    expect(restarted.health().reservations).toHaveLength(1);
    await expect(restarted.lookupReservation({ ...input, owner: { ...input.owner, generation: 2 } })).rejects.toThrow("CONFLICT");
    await expect(restarted.reconcile(async () => false)).rejects.toThrow("RECONCILIATION_REQUIRED");
    expect((await restarted.request(input)).state).toBe("waiting-capacity");
    await restarted.reconcile(async () => true);
    expect(await restarted.request(input)).toEqual(granted);
    env.observedBytes = 8 * GiB;
    expect(await restarted.request(input)).toMatchObject({ state: "waiting-capacity", reason: "observed-budget" });
    await restarted.release({ reservationId: (await restarted.lookupReservation(input))!, terminationEvidenceId: "terminated" });
    expect(await restarted.lookupReservation(input)).toBeUndefined();
  });
  it("holds on an observed budget breach and unknown usage, and queues transient overhead", async () => {
    const { service, env, store } = await fixture();
    env.observedBytes = 8 * GiB;
    expect(await service.request(request("one"))).toMatchObject({ state: "waiting-capacity", reason: "observed-budget" });
    env.observedBytes = null; await service.refresh();
    expect(service.health().hold).toBe("metrics-unavailable");
    env.observedBytes = 2 * GiB; env.unreservedBytes = 7 * GiB;
    expect((await service.request(request("two"))).state).toBe("waiting-capacity");
    const revision = store.read().revision;
    await service.refresh(); await service.request(request("two"));
    expect(store.read().revision).toBe(revision);
    env.unreservedBytes = GiB; await service.refresh();
    expect(service.health().reservations).toHaveLength(2);
  });
  it("admits eight synthetic light envelopes, queues ninth and rejects impossible request", async () => {
    const { service } = await fixture();
    const decisions = await Promise.all(Array.from({ length: 9 }, (_, i) => service.request(request(String(i)))));
    expect(decisions.slice(0, 8).every(d => d.state === "admitted")).toBe(true);
    expect(decisions[8]?.state).toBe("waiting-capacity");
    expect(service.health().reservedBytes).toBe(6 * GiB);
    expect(await service.request(request("heavy", "b", 7 * GiB))).toMatchObject({ state: "resource-infeasible", availableBytes: 6 * GiB });
  });
  it("deduplicates requests, refuses conflicts, requires confirmed termination and releases exactly once", async () => {
    const { service } = await fixture(), input = request("a");
    const first = await service.request(input);
    expect(await service.request(input)).toEqual(first);
    await expect(service.request({ ...input, demand: { ...input.demand, memoryBytes: GiB } })).rejects.toThrow("CONFLICT");
    if (first.state !== "admitted") throw new Error("test setup");
    await expect(service.release({ reservationId: first.reservationId, terminationEvidenceId: "transport-failed" })).rejects.toThrow("UNCONFIRMED");
    expect(service.health().reservedBytes).toBe(768 * MiB);
    await service.release({ reservationId: first.reservationId, terminationEvidenceId: "terminated" });
    await service.release({ reservationId: first.reservationId, terminationEvidenceId: "terminated" });
    expect(service.health().reservedBytes).toBe(0);
  });
  it("closes startup admission, preserves holds, and does not treat missing metrics as zero", async () => {
    const { service, env, make } = await fixture();
    await service.request(request("held"));
    const restarted = make();
    expect((await restarted.request(request("queued"))).state).toBe("waiting-capacity");
    expect(restarted.health().reservedBytes).toBe(768 * MiB);
    await expect(restarted.reconcile(async () => false)).rejects.toThrow("RECONCILIATION");
    await restarted.reconcile(async held => held.length === 1);
    env.availableBytes = null; await restarted.refresh();
    expect(restarted.health().hold).toBe("metrics-unavailable");
    env.availableBytes = 20 * GiB; env.pressure = "critical"; await restarted.refresh();
    expect(restarted.health().queue).toHaveLength(1);
    env.pressure = "normal"; await restarted.refresh();
    expect(restarted.health().queue).toHaveLength(0);
  });
  it("services different families and ages a large request against small arrivals", async () => {
    const { service, store } = await fixture();
    const held = await service.request(request("fill", "a", 4 * GiB));
    await service.request(request("large", "a", 5 * GiB));
    await service.request(request("small-b", "b", GiB));
    const evaluation = request("evaluation", "evaluation", GiB); evaluation.priority = "background"; evaluation.owner.kind = "evaluation";
    await service.request(evaluation);
    if (held.state !== "admitted") throw new Error("test setup");
    const admitted = store.read().entries.filter(e => e.state === "admitted" && e.request.requestId !== "fill");
    expect(admitted.map(e => e.request.requestId)).toContain("small-b");
    for (const e of admitted) await service.release({ reservationId: e.reservationId, terminationEvidenceId: "terminated" });
    expect((await service.request(request("new-small", "c", GiB))).state).toBe("waiting-capacity");
    await service.release({ reservationId: held.reservationId, terminationEvidenceId: "terminated" });
    await service.refresh();
    expect(service.health().reservations.some(e => e.request.requestId === "large")).toBe(true);
    expect(store.read().entries.find(e => e.request.requestId === "evaluation")?.state).not.toBe("waiting-capacity");
  });
  it("persists cancellations and fences stale generations", async () => {
    const { service, env } = await fixture(); env.pressure = "elevated";
    await service.request(request("q")); await service.cancel("q");
    await expect(service.request(request("q"))).rejects.toThrow("TERMINAL");
    const newer = request("new"); newer.owner.workloadId = "work"; newer.owner.generation = 2;
    await service.request(newer);
    const old = request("old"); old.owner.workloadId = "work";
    await expect(service.request(old)).rejects.toThrow("GENERATION");
  });
  it("does not admit two competing queued generations of one workload", async () => {
    const { service, env } = await fixture(); env.pressure = "elevated";
    const first = request("first"); first.owner.workloadId = "same-worker";
    await service.request(first);
    const next = request("next"); next.owner.workloadId = "same-worker"; next.owner.generation = 2;
    await expect(service.request(next)).rejects.toThrow("GENERATION_CONFLICT");
    env.pressure = "normal"; await service.refresh();
    expect(service.health().reservations.map(entry => entry.request.requestId)).toEqual(["first"]);
  });

});
