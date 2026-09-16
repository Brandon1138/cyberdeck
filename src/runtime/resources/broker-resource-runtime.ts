import { readDockerInventory } from "./docker-stats-reader.js";
import { createHash } from "node:crypto";
import type { BrokerRuntimeConfig } from "../../config.js";
import type { SessionRecord } from "../../domain/session.js";
import type { ExecutionRef } from "../../domain/worker-execution.js";
import type { ResourceReservation } from "../../domain/resource-budget.js";
import type { ResourceRuntimeBinding, ResourceRuntimeIdentity, ResourceRuntimeInspection } from "../../domain/resource-runtime.js";
import { ResourceAdmissionService } from "../../orchestration/resource-admission-service.js";
import { ResourceExecutionGate } from "../../orchestration/resource-execution-gate.js";
import { ResourceReservationStore } from "../../persistence/resource-reservation-store.js";
import { ResourceRuntimeBindingStore } from "../../persistence/resource-runtime-binding-store.js";
import { OrbStackClient } from "../execution/orbstack-client.js";
import { ResourceMonitor } from "./resource-monitor.js";
import { NativeMacosProcessSampler } from "./native-macos-process-sampler.js";
import { acquireResourceOwnerLock } from "./resource-owner-lock.js";
import type { ProcessRoot } from "./macos-process-sampler.js";

export interface BrokerResourceRuntimeOptions {
  config: BrokerRuntimeConfig;
  brokerId: string;
  captureHold?(): "evaluation-capture-gap" | null;
  execution(sessionId: string): ExecutionRef | undefined;
  resolveFamily(record: SessionRecord): Promise<string>;
}
type ContainerRow = { id: string; labels: Record<string, string>; running: boolean };
/** Installation-scoped composition. It never signals foreign processes or containers. */
export async function brokerResourceRuntime(options: BrokerResourceRuntimeOptions) {
  const config = options.config.resourceManagement;
  if (!config) return undefined;
  const endpoint = options.config.containerRuntime?.endpoint;
  if (!endpoint) throw new Error("RESOURCE_CONTAINER_ENDPOINT_REQUIRED");
  const client = new OrbStackClient(endpoint);
  const sampler = new NativeMacosProcessSampler(config.nativeHelper);
  let admission: ResourceAdmissionService | undefined, gate: ResourceExecutionGate | undefined;
  let failures = 0, recoveryHold = true;
  const verifiers = new Map<string, (reservation: ResourceReservation, evidence: string) => Promise<boolean>>();
  const store = await ResourceReservationStore.open(config.directory, config.installationId, {
    acquireOwner: path => acquireResourceOwnerLock(config.ownerLockHelper, path, () => { admission?.drain(); void gate?.close(); }),
  });
  const bindings = await ResourceRuntimeBindingStore.open(config.directory, () => store.assertOwner());
  // A successful bounded full inventory is needed to account for helpers and spawn gaps.
  const inventory = (): Promise<ContainerRow[]> => readDockerInventory(endpoint.slice("unix://".length));
  const roots = (): ProcessRoot[] => [
    ...config.externalRoots.map(root => ({ identity: { pid: root.pid, startTime: root.startTime },
      owner: { installationId: config.installationId, workloadId: root.workloadId, kind: "control" as const } })),
    ...bindings.list().filter(b => b.phase === "bound" || b.phase === "launching").flatMap(binding => binding.identities
      .filter((id): id is Extract<ResourceRuntimeIdentity, { kind: "native" }> => id.kind === "native")
      .map(identity => ({ identity, owner: binding.request.owner }))),
  ];
  const monitor = new ResourceMonitor({ installationId: config.installationId, nativeHelper: config.nativeHelper,
    vmIdentity: config.vmIdentity, engineSocket: endpoint.slice("unix://".length), roots, uncertainBytes: config.policy.uncertainBytes,
    containers: async () => (await inventory()).filter(r => r.running).map(r => ({ id: r.id,
      owned: r.labels["cyberdeck.broker"] === options.brokerId || r.labels["cyberdeck.installation"] === config.installationId })),
  });
  const inspect = async (binding: ResourceRuntimeBinding): Promise<ResourceRuntimeInspection> => {
    try {
      const ref = options.execution(binding.request.owner.workloadId);
      const identities = [...binding.identities];
      // Native polling is measurement, never proof that every reparented descendant exited.
      if (identities.some(id => id.kind === "native")) return { state: "unknown", inventoryComplete: false, identities };
      if (!ref || ref.executor !== "orbstack-container" || ref.generation !== binding.request.owner.generation)
        return { state: "unknown", inventoryComplete: false, identities };
      const [container, all] = await Promise.all([client.inspect(ref), inventory()]);
      const owned = all.filter(r => r.labels["cyberdeck.broker"] === options.brokerId
        && (r.labels["cyberdeck.execution"] === ref.executionId || r.labels["cyberdeck.network-helper"] === ref.executionId));
      for (const row of owned) if (!identities.some(id => id.kind === "container" && id.containerId === row.id))
        identities.push({ kind: "container", containerId: row.id });
      return { state: container?.State.Running || owned.some(r => r.running) ? "running" : "terminated", inventoryComplete: true, identities };
    } catch { return { state: "unknown", inventoryComplete: false, identities: binding.identities }; }
  };
  admission = new ResourceAdmissionService(store, config.policy, () => {
    const environment = monitor.environment(), health = monitor.health();
    if (!("samples" in health)) return { ...environment, captureHold: options.captureHold?.() ?? null, observedBytes: null, unreservedBytes: null };
    const control = health.samples.filter(s => s.owner.kind === "control");
    // Until residual attribution is calibrated, reserve the whole VM as an upper bound.
    // This intentionally exposes calibration pressure rather than pretending foreign guests
    // are precisely subtractable from host physical memory.
    const unreservedBytes = control.some(s => s.memoryBytes === null) || health.vm.conservativeVmUpperBytes === null ? null
      : control.reduce((n, s) => n + s.memoryBytes!, 0) + health.vm.conservativeVmUpperBytes;
    return { ...environment, captureHold: options.captureHold?.() ?? null, observedBytes: health.conservativePhysicalUpperBytes, unreservedBytes };
  }, async (reservation, evidence) => {
    if (reservation.request.owner.kind === "worker" || reservation.request.owner.kind === "orchestrator")
      return gate?.verifyTermination(reservation, evidence) ?? false;
    const verifier = verifiers.get(reservation.request.demand.profileId);
    return verifier ? verifier(reservation, evidence) : false;
  });
  gate = new ResourceExecutionGate({ installationId: config.installationId, admission, bindings,
    resolveFamily: options.resolveFamily,
    resolveDemand: record => {
      const profile = config.profiles[`${record.provider}:${record.kind === "orchestrator" ? "orchestrator" : "worker"}`];
      if (!profile) throw new Error("RESOURCE_PROFILE_UNCONFIGURED");
      return profile.demand;
    },
    capture: async (binding, runtime) => {
      const ref = options.execution(binding.request.owner.workloadId);
      if (ref?.executor === "orbstack-container" && ref.generation === binding.request.owner.generation) {
        const found = await inspect(binding);
        if (!found.inventoryComplete || found.state !== "running") throw new Error("RESOURCE_CONTAINER_IDENTITY_UNAVAILABLE");
        // docker attach is broker-owned control overhead; cgroup owns provider and guest helpers.
        return found.identities;
      }
      const table = await sampler.readTable(), root = table.rows.find(r => r.identity.pid === runtime.pid);
      if (!root) throw new Error("RESOURCE_NATIVE_IDENTITY_UNAVAILABLE");
      return [{ kind: "native", ...root.identity }];
    }, inspect,
  });
  let timer: ReturnType<typeof setInterval> | undefined, pending: Promise<void> | undefined;
  const sweep = async () => {
    try {
      if (recoveryHold) { await gate!.reconcile(); recoveryHold = false; }
      for (const reservation of admission!.health().reservations) {
        if (["worker", "orchestrator"].includes(reservation.request.owner.kind))
          await gate!.release(reservation.request.requestId).catch(() => undefined);
      }
      await admission!.refresh();
    } catch { failures++; }
  };
  try {
    await monitor.start(); await sweep();
    timer = setInterval(() => {
      if (!pending) pending = sweep().finally(() => { pending = undefined; });
    }, 5000).unref();
  } catch (error) { await monitor.close(); await store.close(); throw error; }
  return {
    gate, admission, bindings,
    registerVerifier(profileId: string, verifier: (reservation: ResourceReservation, evidence: string) => Promise<boolean>) {
      if (verifiers.has(profileId)) throw new Error("RESOURCE_VERIFIER_DUPLICATE");
      verifiers.set(profileId, verifier);
    },
    envelope(record: SessionRecord, generation: number) {
      const demand = gate!.demand(record.id, generation), profile = config.profiles[`${record.provider}:worker`];
      if (!demand || !profile?.containerMemoryBytes || !profile.containerCpuCores
        || JSON.stringify(demand) !== JSON.stringify(profile.demand) || demand.pidLimit <= 32)
        throw new Error("RESOURCE_CONTAINER_GRANT_REQUIRED");
      return { memoryBytes: profile.containerMemoryBytes, cpus: profile.containerCpuCores, pidLimit: demand.pidLimit - 32 };
    },
    health: () => ({ ...monitor.health(), admission: admission!.health(), recoveryHold, failures,
      policyHash: createHash("sha256").update(JSON.stringify(config.policy)).digest("hex"),
      accounting: "whole-vm-upper-bound-pending-residual-calibration" }),
    drain: () => admission!.drain(),
    closeAdmission: () => gate!.close(),
    close: async () => { clearInterval(timer); await gate!.close(); await pending; await monitor.close(); await store.close(); },
  };
}
