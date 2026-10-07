import type { ResourceOwner, ResourceSample } from "../../domain/resource-budget.js";

export type ContainerIdentity = { containerId: string; owner: ResourceOwner };
export type ContainerReading = { containerId: string; installationId: string;
  memoryCurrentBytes: number | null; cpuCoreFraction: number | null; pids: number | null };
export type ContainerMetricsPort = () => Promise<ContainerReading[]>;
const metric = (value: number | null, integer = false): number | null =>
  value !== null && Number.isFinite(value) && value >= 0 && (!integer || Number.isSafeInteger(value)) ? value : null;

/** Engine discovery is separate from authority: only exact registered IDs are charged. */
export class ContainerResourceSampler {
  constructor(private readonly read: ContainerMetricsPort) {}
  async sample(owned: ContainerIdentity[], observedAt: string): Promise<{ samples: ResourceSample[]; foreignContainers: number | null }> {
    let rows: ContainerReading[];
    let available = true;
    try { rows = await this.read(); }
    catch { rows = []; available = false; }
    const ids = new Set(owned.map((item) => item.containerId));
    if (ids.size !== owned.length) throw new Error("duplicate-container-identity");
    const duplicateIds = new Set(rows.filter((row, index) => rows.findIndex((candidate) => candidate.containerId === row.containerId) !== index).map((row) => row.containerId));
    return { foreignContainers: available ? rows.filter((row) => !ids.has(row.containerId)).length : null,
      samples: owned.map(({ owner, containerId }) => {
        const row = rows.find((candidate) => candidate.containerId === containerId && candidate.installationId === owner.installationId && !duplicateIds.has(containerId));
        const memoryBytes = metric(row?.memoryCurrentBytes ?? null, true);
        const cpuCoreFraction = metric(row?.cpuCoreFraction ?? null);
        const pids = metric(row?.pids ?? null, true);
        return { owner, observedAt, source: "docker-cgroup", memoryKind: "cgroup-current", memoryBytes, cpuCoreFraction, pids,
          uncertainty: row ? (memoryBytes === null || cpuCoreFraction === null || pids === null ? ["container-metrics-partial"] : []) : ["container-metrics-unavailable-or-identity-mismatch"] };
      }) };
  }
}

/** Narrow cgroup v2 reader for already reconciled, installation-owned immutable IDs.
 * Each invocation is read-only; the exec process itself contributes measurement overhead.
 * CPU requires two successful observations. No Docker stats cache subtraction is used.
 */
export function cgroupV2Reader(command: import("./bounded-command.js").ResourceCommand,
  containers: () => ContainerIdentity[], now: () => number = () => performance.now()): ContainerMetricsPort {
  const previous = new Map<string, { micros: number; time: number }>();
  return async () => {
    const identities = containers();
    if (identities.length > 64) throw new Error("container-sample-limit");
    const active = new Set(identities.map((item) => item.containerId));
    for (const id of previous.keys()) if (!active.has(id)) previous.delete(id);
    const readings: ContainerReading[] = [];
    for (const { containerId, owner } of identities) {
      if (!/^[a-f0-9]{64}$/.test(containerId)) throw new Error("immutable-container-id-required");
      try {
        const text = await command("docker", ["exec", containerId, "cat", "/sys/fs/cgroup/memory.current",
          "/sys/fs/cgroup/cpu.stat", "/sys/fs/cgroup/pids.current"]);
        const lines = text.trim().split("\n");
        const first = lines.shift();
        const last = lines.pop();
        const usage = lines.find((line) => /^usage_usec \d+$/.test(line));
        if (!/^\d+$/.test(first ?? "") || !/^\d+$/.test(last ?? "") || !usage) throw new Error("invalid-cgroup-output");
        const micros = Number(usage.split(" ")[1]);
        const time = now();
        const before = previous.get(containerId);
        const cpuCoreFraction = before && time > before.time && micros >= before.micros
          ? (micros - before.micros) / ((time - before.time) * 1000) : null;
        previous.set(containerId, { micros, time });
        readings.push({ containerId, installationId: owner.installationId, memoryCurrentBytes: Number(first), cpuCoreFraction, pids: Number(last) });
      } catch {
        previous.delete(containerId);
        readings.push({ containerId, installationId: owner.installationId, memoryCurrentBytes: null, cpuCoreFraction: null, pids: null });
      }
    }
    return readings;
  };
}
