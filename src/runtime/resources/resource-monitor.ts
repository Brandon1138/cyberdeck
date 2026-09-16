import { monitorEventLoopDelay } from "node:perf_hooks";
import { totalmem } from "node:os";
import type { ResourceOwner, ResourceEnvironment, ResourceSample } from "../../domain/resource-budget.js";
import { NativeMacosProcessSampler } from "./native-macos-process-sampler.js";
import { ProcessOwnership, type ProcessRoot, type ProcessIdentity } from "./macos-process-sampler.js";
import { readDockerStats } from "./docker-stats-reader.js";
import { runResourceCommand } from "./bounded-command.js";
import { attributeVm, type VmAttribution } from "./vm-attribution.js";

export interface ResourceMonitorOptions {
  installationId: string;
  nativeHelper: string;
  roots(): ProcessRoot[];
  vmIdentity?: ProcessIdentity;
  containers(): Promise<{ id: string; owned: boolean; helper?: boolean }[]>;
  engineSocket?: string;
  uncertainBytes: number;
  intervalMs?: number;
}
export interface ResourceHealth {
  configured: true; observedAt: string; samples: ResourceSample[];
  managedNativePhysicalBytes: number | null; vm: VmAttribution;
  attributedPhysicalEstimateBytes: number | null; conservativePhysicalUpperBytes: number | null;
  pressure: ResourceEnvironment["pressure"]; availableBytes: number | null;
  eventLoopP99Ms: number; sampleDurationMs: number; collectionFailures: number;
  uncertainty: string[];
  activeWorkloads: number;
}
/** Bounded snapshots; inspection RPC reads cached data and cannot force sampling work. */
export class ResourceMonitor {
  private readonly native: NativeMacosProcessSampler;
  private readonly ownership = new ProcessOwnership();
  private readonly loop = monitorEventLoopDelay({ resolution: 20 });
  private readonly history: ResourceHealth[] = [];
  private pending: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private failures = 0;
  constructor(private readonly options: ResourceMonitorOptions) { this.native = new NativeMacosProcessSampler(options.nativeHelper); }
  async start(): Promise<void> {
    if (this.timer) return;
    this.loop.enable(); await this.sample();
    this.timer = setInterval(() => { void this.sample(); }, Math.max(5000, this.options.intervalMs ?? 5000)).unref();
  }
  health(): ResourceHealth | { configured: true; hold: "metrics-unavailable" } {
    return structuredClone(this.history.at(-1) ?? { configured: true, hold: "metrics-unavailable" });
  }
  recent(): ResourceHealth[] { return structuredClone(this.history); }
  environment(): ResourceEnvironment {
    const value = this.history.at(-1);
    return { observedAt: value ? Date.parse(value.observedAt) : 0, pressure: value?.pressure ?? "unknown",
      availableBytes: value?.availableBytes ?? null,
      attributionComplete: value?.managedNativePhysicalBytes !== null && value?.conservativePhysicalUpperBytes !== null && value !== undefined };
  }
  sample(): Promise<void> {
    if (!this.pending) this.pending = this.collect().catch(() => { this.failures++; }).finally(() => { this.pending = undefined; });
    return this.pending;
  }
  async close(): Promise<void> { clearInterval(this.timer); this.timer = undefined; await this.pending; this.loop.disable(); }
  private async collect(): Promise<void> {
    const began = performance.now(), observedAt = new Date().toISOString();
    const [table, pressureText, levelText, containers] = await Promise.all([
      this.native.readTable(), runResourceCommand("/usr/bin/memory_pressure", ["-Q"]).catch(() => ""),
      runResourceCommand("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]).catch(() => ""),
      this.options.containers(),
    ]);
    if (containers.length > 128 || new Set(containers.map(c => c.id)).size !== containers.length) throw new Error("RESOURCE_CONTAINER_INVENTORY_INVALID");
    const roots = this.options.roots();
    const self = table.rows.find(r => r.identity.pid === process.pid);
    if (!self) throw new Error("RESOURCE_BROKER_METRICS_UNAVAILABLE");
    if (self && !roots.some(r => r.identity.pid === process.pid)) roots.push({ identity: self.identity,
      owner: { installationId: this.options.installationId, workloadId: "broker", kind: "control" } });
    const samples = this.ownership.sample(table.rows, roots, observedAt, "physical-footprint");
    const managedNativePhysicalBytes = samples.some(s => s.memoryBytes === null) ? null : samples.reduce((n, s) => n + s.memoryBytes!, 0);
    const stats = await Promise.all(containers.map(async container => {
      try {
        if (!this.options.engineSocket) throw new Error("engine-unavailable");
        return { owned: container.owned, metrics: await readDockerStats(this.options.engineSocket, container.id) };
      } catch { return { owned: container.owned, metrics: null }; }
    }));
    const group = (owned: boolean) => stats.filter(s => s.owned === owned).some(s => s.metrics === null) ? null
      : stats.filter(s => s.owned === owned).reduce((n, s) => n + s.metrics!.memoryBytes, 0);
    const vmId = this.options.vmIdentity;
    const vmProcess = vmId && table.rows.find(r => r.identity.pid === vmId.pid && r.identity.startTime === vmId.startTime);
    const vm = attributeVm(vmProcess?.physicalFootprintBytes ?? null, group(true), group(false), this.options.uncertainBytes);
    const pressure = ({ "1": "normal", "2": "elevated", "4": "critical" } as const)[levelText.trim() as "1" | "2" | "4"] ?? "unknown";
    const percent = /System-wide memory free percentage: (\d+)%/.exec(pressureText);
    const availableBytes = percent && Number(percent[1]) <= 100 ? Math.floor(totalmem() * Number(percent[1]) / 100) : null;
    const addNative = (vmBytes: number | null) => managedNativePhysicalBytes === null || vmBytes === null ? null : managedNativePhysicalBytes + vmBytes;
    const result: ResourceHealth = { configured: true, observedAt, samples, managedNativePhysicalBytes, vm,
      activeWorkloads: containers.filter(c => c.owned && !c.helper).length
        + samples.filter(s => s.owner.kind !== "control" && s.pids !== null && s.pids > 0).length,
      attributedPhysicalEstimateBytes: addNative(vm.attributedVmEstimateBytes), conservativePhysicalUpperBytes: addNative(vm.conservativeVmUpperBytes),
      pressure, availableBytes, eventLoopP99Ms: this.loop.percentile(99) / 1e6, sampleDurationMs: performance.now() - began,
      collectionFailures: this.failures, uncertainty: [...vm.uncertainty, "os-headroom-estimate", "unobserved-short-lived-descendants",
        ...(table.inaccessibleProcesses ? ["foreign-process-table-incomplete"] : [])] };
    this.loop.reset(); this.history.push(result); if (this.history.length > 120) this.history.shift();
  }
}
