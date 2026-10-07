import type { ResourceSample } from "../../domain/resource-budget.js";
import { runResourceCommand, type ResourceCommand } from "./bounded-command.js";
import { ProcessOwnership, type ProcessReading, type ProcessRoot } from "./macos-process-sampler.js";

export type NativeProcessReading = ProcessReading & { monotonicNanos: bigint; cpuNanos: bigint | null };
export type NativeProcessTable = { rows: NativeProcessReading[]; inaccessibleProcesses: number };
const unsigned = (value: string | undefined): bigint => {
  if (!value || !/^\d{1,20}$/.test(value)) throw new Error("invalid-native-process-table");
  return BigInt(value);
};
const integer = (value: string | undefined): number => {
  const parsed = Number(unsigned(value));
  if (!Number.isSafeInteger(parsed)) throw new Error("invalid-native-process-table");
  return parsed;
};

/** A versioned, numeric-only format; a missing trailer invalidates the entire table. */
export function parseNativeProcessTable(text: string): NativeProcessTable {
  if (Buffer.byteLength(text) > 1024 * 1024) throw new Error("native-process-output-limit");
  const lines = text.trimEnd().split("\n");
  if (lines.shift() !== "cyberdeck-process-v1") throw new Error("invalid-native-process-version");
  const trailer = lines.pop()?.split("\t");
  if (trailer?.length !== 3 || trailer[0] !== "end" || integer(trailer[1]) !== lines.length || lines.length > 16384)
    throw new Error("invalid-native-process-trailer");
  const pids = new Set<number>();
  const rows = lines.map((line): NativeProcessReading => {
    const fields = line.split("\t");
    if (fields.length !== 9) throw new Error("invalid-native-process-row");
    const [pidText, parent, seconds, micros, monotonic, footprint, rss, user, system] = fields;
    const pid = integer(pidText);
    const usec = integer(micros);
    if (pid < 1 || pids.has(pid) || usec > 999999) throw new Error("invalid-native-process-identity");
    pids.add(pid);
    const denied = footprint === "-" && rss === "-" && user === "-" && system === "-";
    return { identity: { pid, startTime: `libproc:${unsigned(seconds)}.${String(usec).padStart(6, "0")}` },
      parentPid: integer(parent), monotonicNanos: unsigned(monotonic),
      physicalFootprintBytes: denied ? null : integer(footprint), rssBytes: denied ? null : integer(rss),
      cpuNanos: denied ? null : unsigned(user) + unsigned(system), cpuCoreFraction: null,
      uncertainty: denied ? ["process-rusage-unavailable"] : ["cpu-first-observation"] };
  });
  return { rows, inaccessibleProcesses: integer(trailer[2]) };
}

/** The executable is installed/configured by composition, never compiled or found on PATH here. */
export class NativeMacosProcessSampler {
  private readonly ownership = new ProcessOwnership();
  private previous = new Map<string, { time: bigint; cpu: bigint }>();
  private pending: Promise<NativeProcessTable> | undefined;
  constructor(private readonly executable: string, private readonly command: ResourceCommand = runResourceCommand) {
    if (!executable.startsWith("/")) throw new Error("absolute-native-helper-required");
  }
  readTable(): Promise<NativeProcessTable> {
    if (this.pending) return this.pending.then((table) => structuredClone(table));
    this.pending = this.read().finally(() => { this.pending = undefined; });
    return this.pending.then((table) => structuredClone(table));
  }
  private async read(): Promise<NativeProcessTable> {
    const table = parseNativeProcessTable(await this.command(this.executable, []));
    const next = new Map<string, { time: bigint; cpu: bigint }>();
    for (const row of table.rows) {
      if (row.cpuNanos === null) continue;
      const id = `${row.identity.pid}:${row.identity.startTime}`;
      const before = this.previous.get(id);
      if (before && row.monotonicNanos > before.time && row.cpuNanos >= before.cpu) {
        row.cpuCoreFraction = Number(row.cpuNanos - before.cpu) / Number(row.monotonicNanos - before.time);
        row.uncertainty = [];
      } else if (before) row.uncertainty = ["cpu-counter-reset-or-clock-regression"];
      next.set(id, { time: row.monotonicNanos, cpu: row.cpuNanos });
    }
    this.previous = next;
    return table;
  }
  async sample(roots: ProcessRoot[], observedAt: string): Promise<ResourceSample[]> {
    try {
      const table = await this.readTable();
      return this.ownership.sample(table.rows, roots, observedAt, "physical-footprint",
        table.inaccessibleProcesses ? ["process-table-incomplete"] : []);
    } catch {
      this.previous.clear();
      return roots.map(({ owner }) => ({ owner, observedAt, source: "macos-process", memoryKind: "physical-footprint",
        memoryBytes: null, cpuCoreFraction: null, pids: null, uncertainty: ["native-process-metrics-unavailable"] }));
    }
  }
}
