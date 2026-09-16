import type { ResourceOwner, ResourceSample } from "../../domain/resource-budget.js";
import { runResourceCommand, type ResourceCommand } from "./bounded-command.js";

export type ProcessIdentity = { pid: number; startTime: string };
export type ProcessRoot = { owner: ResourceOwner; identity: ProcessIdentity };
export type ProcessReading = { identity: ProcessIdentity; parentPid: number; rssBytes: number | null; cpuCoreFraction: number | null; physicalFootprintBytes?: number | null; uncertainty?: string[] };
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
  sample(rows: ProcessReading[], roots: ProcessRoot[], observedAt: string, memoryKind: "rss" | "physical-footprint" = "rss", tableUncertainty: string[] = []): ResourceSample[] {
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
      const visited = new Set<number>();
      const chain: ProcessReading[] = [];
      let node: ProcessReading | undefined = row;
      let resolved: ResourceOwner | undefined;
      while (node && !visited.has(node.identity.pid)) {
        visited.add(node.identity.pid);
        resolved = next.get(key(node.identity));
        if (resolved) break;
        chain.push(node);
        const parent = byPid.get(node.parentPid);
        // A reused parent PID cannot own a child born before that parent's birth.
        const childBirth = /^libproc:(\d+)\.(\d{6})$/.exec(node.identity.startTime);
        const parentBirth = parent && /^libproc:(\d+)\.(\d{6})$/.exec(parent.identity.startTime);
        if (childBirth && parentBirth && BigInt(parentBirth[1]! + parentBirth[2]!) > BigInt(childBirth[1]! + childBirth[2]!)) break;
        node = parent;
      }
      // Current rooted ancestry outranks retained ownership, independent of row order.
      if (!resolved) for (const ancestor of chain) {
        const retained = this.known.get(key(ancestor.identity));
        if (retained && activeOwners.has(ownerKey(retained))) { resolved = retained; break; }
      }
      if (resolved) next.set(id, resolved);
    }
    this.known = next;
    return [...activeOwners].map(([id, owner]) => {
      const owned = rows.filter((row) => ownerKey(next.get(key(row.identity)) ?? {}) === id);
      const memories = owned.map((row) => memoryKind === "rss" ? row.rssBytes : row.physicalFootprintBytes ?? null);
      const cpu = owned.map((row) => row.cpuCoreFraction);
      return { owner, observedAt, source: "macos-process", memoryKind,
        memoryBytes: memories.length && memories.every((value) => value !== null) ? memories.reduce<number>((sum, value) => sum + value!, 0) : null,
        cpuCoreFraction: cpu.length && cpu.every((value) => value !== null) ? cpu.reduce<number>((sum, value) => sum + value!, 0) : null,
        pids: owned.length || null, uncertainty: [...new Set([
          ...(memoryKind === "rss" ? ["rss-not-physical-footprint", "ps-cpu-decayed-average", "start-time-resolution-one-second", "not-reclamation-identity"] : []),
          "unobserved-short-lived-descendants", ...tableUncertainty, ...owned.flatMap((row) => row.uncertainty ?? []),
          ...(owned.length ? [] : ["process-identity-not-observed"])])] };
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
