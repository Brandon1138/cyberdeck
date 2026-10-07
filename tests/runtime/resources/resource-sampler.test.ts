import { describe, expect, it } from "vitest";
import { ProcessOwnership, parseProcessTable, MacosProcessSampler } from "../../../src/runtime/resources/macos-process-sampler.js";
import { ContainerResourceSampler, cgroupV2Reader } from "../../../src/runtime/resources/container-resource-sampler.js";
import { ResourceSampler } from "../../../src/runtime/resources/resource-sampler.js";
import type { ResourceOwner, ResourceSample } from "../../../src/domain/resource-budget.js";
const owner = (workloadId: string): ResourceOwner => ({ installationId: "test", workloadId, kind: "worker" });
const row = (pid: number, parentPid: number, startTime = "birth") => ({ identity: { pid, startTime }, parentPid, rssBytes: 10, cpuCoreFraction: 0.1 });
const sample = (source: ResourceSample["source"], memoryBytes: number): ResourceSample => ({ owner: owner(source), observedAt: new Date().toISOString(), source, memoryBytes,
  memoryKind: source === "docker-cgroup" ? "cgroup-current" : "rss", cpuCoreFraction: null, pids: 1, uncertainty: [] });

describe("resource measurements", () => {
  it("attributes two trees once, retains reparented descendants, fences reused PIDs", () => {
    const ownership = new ProcessOwnership();
    const roots = [{ owner: owner("a"), identity: row(1, 0).identity }, { owner: owner("b"), identity: row(3, 0).identity }];
    expect(ownership.sample([row(1, 0), row(2, 1), row(3, 0), row(4, 3)], roots, "now").map((s) => s.memoryBytes)).toEqual([20, 20]);
    expect(ownership.sample([row(1, 0), row(2, 0), row(3, 0), row(4, 3, "new")], roots, "now").map((s) => s.memoryBytes)).toEqual([20, 20]);
    expect(ownership.sample([row(1, 0), row(2, 0, "new"), row(3, 0)], roots, "now").map((s) => s.memoryBytes)).toEqual([10, 10]);
    expect(ownership.sample([row(1, 0, "reused")], roots, "now")[0]?.memoryBytes).toBeNull();
  });
  it("partitions nested roots without counting their tree twice", () => {
    const ownership = new ProcessOwnership();
    const roots = [{ owner: owner("a"), identity: row(1, 0).identity }, { owner: owner("b"), identity: row(2, 1).identity }];
    expect(ownership.sample([row(3, 2), row(2, 1), row(1, 0)], roots, "now").map((s) => s.memoryBytes)).toEqual([10, 20]);
  });
  it("parses selected metrics only and exposes denied metrics as unknown", async () => {
    expect(parseProcessTable(" 12 1 1024 125.0 Wed Sep 16 12:34:56 2026")[0]?.cpuCoreFraction).toBe(1.25);
    expect(() => parseProcessTable("12 secret command")).toThrow();
    const sampler = new MacosProcessSampler(async () => { throw new Error("denied sensitive output"); });
    const result = await sampler.sample([{ owner: owner("a"), identity: row(1, 0).identity }], "now");
    expect(result[0]?.memoryBytes).toBeNull();
    expect(JSON.stringify(result)).not.toContain("sensitive");
  });
  it("excludes foreign containers and rejects wrong installation identity", async () => {
    const sampler = new ContainerResourceSampler(async () => [
      { containerId: "owned", installationId: "other", memoryCurrentBytes: 40, cpuCoreFraction: 0, pids: 1 },
      { containerId: "foreign", installationId: "other", memoryCurrentBytes: 90, cpuCoreFraction: 0, pids: 1 },
    ]);
    const result = await sampler.sample([{ containerId: "owned", owner: owner("a") }], "now");
    expect(result.foreignContainers).toBe(1);
    expect(result.samples[0]?.memoryBytes).toBeNull();
  });
  it("reads raw cgroup memory and interval CPU with immutable IDs", async () => {
    let time = 0; let calls = 0;
    const reader = cgroupV2Reader(async (file, args) => {
      expect(file).toBe("docker"); expect(args.slice(0, 3)).toEqual(["exec", "a".repeat(64), "cat"]);
      return `1234\nusage_usec ${++calls * 1000000}\nuser_usec 1\nsystem_usec 2\n4\n`;
    }, () => [{ containerId: "a".repeat(64), owner: owner("a") }], () => time);
    expect((await reader())[0]?.cpuCoreFraction).toBeNull();
    time = 2000;
    expect((await reader())[0]).toMatchObject({ memoryCurrentBytes: 1234, cpuCoreFraction: 0.5, pids: 4 });
  });
  it("does not sum shared VM and guests; coalesces polls and bounds history", async () => {
    let unblock!: (value: ResourceSample[]) => void;
    let hostCalls = 0;
    const sampler = new ResourceSampler({ host: () => { hostCalls++; return new Promise((resolve) => { unblock = resolve; }); },
      guests: async () => [sample("docker-cgroup", 100)], vm: async () => [sample("vm-host", 500)] }, 1);
    const first = sampler.sample(); const second = sampler.sample();
    expect(first).toBe(second); expect(hostCalls).toBe(1);
    unblock([sample("macos-process", 20)]);
    expect(await first).toMatchObject({ managedHostRssBytes: 20, guestCgroupBytes: 100, installationPhysicalBytes: null });
    const third = sampler.sample(); unblock([]); await third;
    expect(sampler.recent()).toHaveLength(1);
    sampler.recent()[0]!.uncertainty.push("mutation");
    expect(sampler.recent()[0]!.uncertainty).not.toContain("mutation");
  });
  it("rejects stale, duplicate and malformed source data without retaining payloads", async () => {
    const stale = { ...sample("macos-process", 10), observedAt: "2000-01-01T00:00:00.000Z" };
    const guest = sample("docker-cgroup", 20);
    const sampler = new ResourceSampler({ host: async () => [stale], guests: async () => [guest, guest],
      vm: async () => [{ ...sample("vm-host", 30), command: "secret" } as ResourceSample] });
    const snapshot = await sampler.sample();
    expect(snapshot.managedHostRssBytes).toBeNull();
    expect(snapshot.guestCgroupBytes).toBeNull();
    expect(snapshot.host).toEqual([]);
    expect(JSON.stringify(sampler.recent())).not.toContain("secret");
  });

});
