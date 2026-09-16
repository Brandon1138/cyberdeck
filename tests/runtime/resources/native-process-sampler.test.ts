import { describe, expect, it } from "vitest";
import { NativeMacosProcessSampler, parseNativeProcessTable } from "../../../src/runtime/resources/native-macos-process-sampler.js";
import { ProcessOwnership } from "../../../src/runtime/resources/macos-process-sampler.js";
import { ResourceSampler } from "../../../src/runtime/resources/resource-sampler.js";
const owner = { installationId: "fixture", workloadId: "a", kind: "worker" as const };
const line = (micros = 1, cpu = 100, time = 1000, pid = 1, parent = 0) => `${pid}\t${parent}\t123\t${micros}\t${time}\t42\t64\t${cpu}\t0`;
const table = (rows: string[], inaccessible = 0) => `cyberdeck-process-v1\n${rows.join("\n")}\nend\t${rows.length}\t${inaccessible}\n`;

describe("native macOS measurement", () => {
  it("preserves microsecond birth identity and rejects reused PID in the same second", () => {
    const first = parseNativeProcessTable(table([line(1)]));
    const next = parseNativeProcessTable(table([line(2)]));
    expect(first.rows[0]!.identity.startTime).toBe("libproc:123.000001");
    const ownership = new ProcessOwnership();
    const roots = [{ owner, identity: first.rows[0]!.identity }];
    expect(ownership.sample(first.rows, roots, "now", "physical-footprint")[0]!.memoryBytes).toBe(42);
    expect(ownership.sample(next.rows, roots, "now", "physical-footprint")[0]!.memoryBytes).toBeNull();
  });
  it("aggregates physical memory and interval CPU rather than RSS or cumulative time", async () => {
    let call = 0;
    const sampler = new NativeMacosProcessSampler("/fixture/helper", async () => table([line(1, ++call * 100, call * 1000)]));
    const root = { owner, identity: { pid: 1, startTime: "libproc:123.000001" } };
    const first = await sampler.sample([root], new Date().toISOString());
    expect(first[0]).toMatchObject({ memoryKind: "physical-footprint", memoryBytes: 42, cpuCoreFraction: null });
    const second = await sampler.sample([root], new Date().toISOString());
    expect(second[0]!.cpuCoreFraction).toBe(0.1);
    const combined = await new ResourceSampler({ host: async () => second, guests: async () => [], vm: async () => [] }).sample();
    expect(combined.managedHostPhysicalBytes).toBe(42);
    expect(combined.managedHostRssBytes).toBeNull();
    expect(combined.installationPhysicalBytes).toBeNull();
  });
  it("keeps denied child metrics unknown and exposes inaccessible process gaps", async () => {
    const sampler = new NativeMacosProcessSampler("/fixture/helper", async () => table([line(), "2\t1\t123\t2\t1000\t-\t-\t-\t-"], 3));
    const result = await sampler.sample([{ owner, identity: { pid: 1, startTime: "libproc:123.000001" } }], "now");
    expect(result[0]).toMatchObject({ memoryBytes: null, cpuCoreFraction: null, pids: 2 });
    expect(result[0]!.uncertainty).toContain("process-table-incomplete");
    expect(result[0]!.uncertainty).toContain("process-rusage-unavailable");
  });
  it("rejects truncated, malformed, duplicate and oversized helper output", () => {
    expect(() => parseNativeProcessTable("cyberdeck-process-v1\n" + line())).toThrow();
    expect(() => parseNativeProcessTable(table([line(), line()]))).toThrow();
    expect(() => parseNativeProcessTable(table([line(1000000)]))).toThrow();
    expect(() => parseNativeProcessTable("x".repeat(1024 * 1024 + 1))).toThrow();
    expect(() => parseNativeProcessTable(table([line().replace("42", "secret")]))).toThrow();
  });
  it("coalesces concurrent table reads and does not share mutable returned rows", async () => {
    let resolve!: (value: string) => void;
    let calls = 0;
    const sampler = new NativeMacosProcessSampler("/fixture/helper", async () => { calls++; return new Promise<string>((done) => { resolve = done; }); });
    const a = sampler.readTable(); const b = sampler.readTable();
    resolve(table([line()]));
    const [first, second] = await Promise.all([a, b]);
    expect(calls).toBe(1);
    first.rows[0]!.identity.startTime = "changed";
    expect(second.rows[0]!.identity.startTime).toBe("libproc:123.000001");
  });
  it("does not expose helper error text, and requires an explicit absolute helper path", async () => {
    expect(() => new NativeMacosProcessSampler("helper")).toThrow();
    const sampler = new NativeMacosProcessSampler("/fixture/helper", async () => { throw new Error("secret argv"); });
    const result = await sampler.sample([{ owner, identity: { pid: 1, startTime: "libproc:123.000001" } }], "now");
    expect(result[0]!.memoryBytes).toBeNull();
    expect(JSON.stringify(result)).not.toContain("secret");
  });
  it("does not attach an older child to a reused parent PID", () => {
    const ownership = new ProcessOwnership();
    const rows = parseNativeProcessTable(table([line(3, 100, 1000, 1), line(2, 100, 1000, 2, 1)])).rows;
    const result = ownership.sample(rows, [{ owner, identity: rows[0]!.identity }], "now", "physical-footprint");
    expect(result[0]!.pids).toBe(1);
  });
  it("attributes children of retained reparented processes regardless of row order", () => {
    const ownership = new ProcessOwnership();
    const initial = parseNativeProcessTable(table([line(1, 100, 1000, 1), line(2, 100, 1000, 2, 1)])).rows;
    const roots = [{ owner, identity: initial[0]!.identity }];
    ownership.sample(initial, roots, "now", "physical-footprint");
    const reparented = parseNativeProcessTable(table([line(3, 100, 1000, 3, 2), line(2, 100, 1000, 2, 0)])).rows;
    expect(ownership.sample(reparented, roots, "now", "physical-footprint")[0]!.pids).toBe(2);
  });

});
