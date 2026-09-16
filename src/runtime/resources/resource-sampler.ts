import { ResourceSampleSchema, type ResourceSample } from "../../domain/resource-budget.js";

export type ResourceSnapshot = {
  observedAt: string;
  host: ResourceSample[];
  guests: ResourceSample[];
  vm: ResourceSample[];
  /** Host total excludes guests and shared VM. Never a whole-installation total. */
  managedHostRssBytes: number | null;
  guestCgroupBytes: number | null;
  installationPhysicalBytes: null;
  uncertainty: string[];
};
export type ResourceSources = { host: () => Promise<ResourceSample[]>;
  guests: () => Promise<ResourceSample[]>; vm: () => Promise<ResourceSample[]> };
const sum = (samples: ResourceSample[]): number | null => samples.some((sample) => sample.memoryBytes === null)
  ? null : samples.reduce((total, sample) => total + sample.memoryBytes!, 0);

/** Caller schedules low-frequency polls. Concurrent polls share one bounded collection. */
export class ResourceSampler {
  private pending: Promise<ResourceSnapshot> | undefined;
  private history: ResourceSnapshot[] = [];
  constructor(private readonly sources: ResourceSources, private readonly retention = 120,
    private readonly now: () => string = () => new Date().toISOString()) {
    if (!Number.isSafeInteger(retention) || retention < 1 || retention > 3600) throw new Error("invalid-resource-retention");
  }
  sample(): Promise<ResourceSnapshot> {
    if (this.pending) return this.pending;
    this.pending = this.collect().finally(() => { this.pending = undefined; });
    return this.pending;
  }
  recent(): ResourceSnapshot[] { return structuredClone(this.history); }
  private async collect(): Promise<ResourceSnapshot> {
    const observedAt = this.now();
    const read = async (source: () => Promise<ResourceSample[]>, expected: ResourceSample["source"]) => {
      const samples = await source();
      if (samples.length > 512) throw new Error("resource-sample-limit");
      const owners = new Set<string>();
      return samples.map((input) => {
        const sample = ResourceSampleSchema.parse(input);
        const age = Date.parse(this.now()) - Date.parse(sample.observedAt);
        const owner = JSON.stringify(sample.owner);
        if (owners.has(owner)) throw new Error("duplicate-resource-owner");
        owners.add(owner);
        if (sample.source !== expected || age < -1000 || age > 15000) throw new Error("resource-sample-stale-or-mismatched");
        return sample;
      });
    };
    const results = await Promise.allSettled([read(this.sources.host, "macos-process"),
      read(this.sources.guests, "docker-cgroup"), read(this.sources.vm, "vm-host")]);
    const [hostResult, guestResult, vmResult] = results;
    const host = hostResult!.status === "fulfilled" ? hostResult!.value : [];
    const guests = guestResult!.status === "fulfilled" ? guestResult!.value : [];
    const vm = vmResult!.status === "fulfilled" ? vmResult!.value : [];
    const snapshot: ResourceSnapshot = { observedAt, host, guests, vm,
      managedHostRssBytes: hostResult!.status === "fulfilled" ? sum(host) : null,
      guestCgroupBytes: guestResult!.status === "fulfilled" ? sum(guests) : null,
      installationPhysicalBytes: null,
      uncertainty: ["shared-vm-attribution-unavailable", "rss-not-physical-footprint",
        ...results.flatMap((result, index) => result.status === "rejected" ? [`source-${index}-unavailable`] : [])] };
    this.history.push(structuredClone(snapshot));
    if (this.history.length > this.retention) this.history.shift();
    return snapshot;
  }
}
