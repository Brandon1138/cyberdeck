import type { ResourceOwner, ResourceSample } from "../../domain/resource-budget.js";
import { runResourceCommand, type ResourceCommand } from "./bounded-command.js";

export type ProcessIdentity = { pid: number; startTime: string };
export type ProcessRoot = { owner: ResourceOwner; identity: ProcessIdentity };
export type ProcessReading = { identity: ProcessIdentity; parentPid: number; rssBytes: number; cpuCoreFraction: number };
const key = (identity: ProcessIdentity): string => `${identity.pid}:${identity.startTime}`;
const ownerKey = (owner: ResourceOwner | Record<string, never>): string => JSON.stringify(owner);

/** ps contains only selected numeric metrics and start time, never argv or environment. */
export function parseProcessTable(text: string): ProcessReading[] {
  return text.split("\n").filter((line) => line.trim()).map((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.+?)\s*$/.exec(line);
    if (!match) throw new Error("invalid-process-table");
    const [, pid, parent, rss, cpu, start] = match;
    const reading = { identity: { pid: Number(pid), startTime: start! }, parentPid: Number(parent),
      rssBytes: Number(rss) * 1024, cpuCoreFraction: Number(cpu) / 100 };
    if (!Number.isSafeInteger(reading.rssBytes) || !Number.isFinite(reading.cpuCoreFraction)
      || !/^[A-Z][a-z]{2} [A-Z][a-z]{2}\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/.test(start!)) throw new Error("invalid-process-table");
    return reading;
  });
}

/** Only observed descendants survive reparenting. A disappeared identity is forgotten. */
export class ProcessOwnership {
  private known = new Map<string, ResourceOwner>();
  sample(rows: ProcessReading[], roots: ProcessRoot[], observedAt: string): ResourceSample[] {
    const activeOwners = new Map(roots.map((root) => [ownerKey(root.owner), root.owner]));
    const current = new Map(rows.map((row) => [key(row.identity), row]));
    const next = new Map<string, ResourceOwner>();
    const rootKeys = new Set<string>();
    for (const root of roots) {
      const id = key(root.identity);
      if (rootKeys.has(id)) throw new Error("duplicate-process-root");
      rootKeys.add(id);
      if (current.has(id)) next.set(id, root.owner);
    }
    const byPid = new Map(rows.map((row) => [row.identity.pid, row]));
    // Resolve each ancestry chain directly; explicit nested roots take precedence.
    for (const row of rows) {
      const id = key(row.identity);
      if (next.has(id)) continue;
      const visited = new Set<number>([row.identity.pid]);
      let parent = byPid.get(row.parentPid);
      while (parent && !visited.has(parent.identity.pid)) {
        visited.add(parent.identity.pid);
        const owner = next.get(key(parent.identity));
        if (owner) { next.set(id, owner); break; }
        parent = byPid.get(parent.parentPid);
      }
      const retained = this.known.get(id);
      if (!next.has(id) && retained && activeOwners.has(ownerKey(retained))) next.set(id, retained);
    }
    this.known = next;
    return [...activeOwners].map(([id, owner]) => {
      const owned = rows.filter((row) => ownerKey(next.get(key(row.identity)) ?? {}) === id);
      return { owner, observedAt, source: "macos-process", memoryKind: "rss",
        memoryBytes: owned.length ? owned.reduce((sum, row) => sum + row.rssBytes, 0) : null,
        cpuCoreFraction: owned.length ? owned.reduce((sum, row) => sum + row.cpuCoreFraction, 0) : null,
        pids: owned.length || null, uncertainty: ["rss-not-physical-footprint", "ps-cpu-decayed-average", "unobserved-short-lived-descendants", "start-time-resolution-one-second", ...(owned.length ? [] : ["process-identity-not-observed"])] };
    });
  }
}

export class MacosProcessSampler {
  private readonly ownership = new ProcessOwnership();
  constructor(private readonly command: ResourceCommand = runResourceCommand) {}
  async sample(roots: ProcessRoot[], observedAt: string): Promise<ResourceSample[]> {
    try {
      const rows = parseProcessTable(await this.command("/bin/ps", ["-axo", "pid=,ppid=,rss=,%cpu=,lstart="]));
      return this.ownership.sample(rows, roots, observedAt);
    } catch {
      return roots.map(({ owner }) => ({ owner, observedAt, source: "macos-process", memoryKind: "rss",
        memoryBytes: null, cpuCoreFraction: null, pids: null, uncertainty: ["process-metrics-unavailable"] }));
    }
  }
}
