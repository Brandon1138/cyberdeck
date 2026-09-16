import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeProcessReading } from "../../../src/runtime/resources/native-macos-process-sampler.js";
import type { NativeCommand } from "../../../src/runtime/execution/native-tool-types.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
import { MacosNativeProcessSupervisor } from "../../../src/runtime/execution/native-process-supervisor.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
function row(pid: number, parentPid: number, start = pid): NativeProcessReading {
  return { identity: { pid, startTime: `libproc:${start}.000001` }, parentPid, monotonicNanos: 1n,
    cpuNanos: 0n, physicalFootprintBytes: 1, rssBytes: 1, cpuCoreFraction: 0, uncertainty: [] };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "native-supervisor-")); roots.push(root);
  const child = Object.assign(new EventEmitter(), { pid: 101, connected: true, send: vi.fn(), disconnect: vi.fn() });
  child.disconnect.mockImplementation(() => { child.connected = false; child.emit("exit", 125, null); });
  mocks.spawn.mockReturnValue(child);
  const command: NativeCommand = { executable: "/usr/bin/xcodebuild", args: ["test"], cwd: root, env: { PATH: "/usr/bin:/bin" },
    timeoutMs: 1000, logPath: join(root, "build.log"), artifactsDirectory: root, maxArtifactBytes: 1024,
    memoryBytes: 1024, pidLimit: 16 };
  return { child, command };
}

describe("native process supervision", () => {
  it("binds the exact supervisor birth before launching and never equates parent exit with complete cleanup", async () => {
    const f = await fixture(); let rows = [row(101, 1)]; let bound = false;
    f.child.send.mockImplementation(() => { expect(bound).toBe(true); rows = []; f.child.emit("exit", 0, null); });
    const sampler = { readTable: vi.fn(async () => ({ rows, inaccessibleProcesses: 0 })) };
    const result = await new MacosNativeProcessSupervisor(sampler).run(f.command, { identities: async identities => {
      expect(identities).toEqual([{ kind: "native", pid: 101, startTime: "libproc:101.000001" }]); bound = true;
    } });
    expect(result).toMatchObject({ exitCode: 0, cleanup: "unproven" });
    expect(f.child.send).toHaveBeenCalledOnce();
  });
  it("does not start the tool if durable identity binding fails", async () => {
    const f = await fixture();
    const sampler = { readTable: vi.fn(async () => ({ rows: [row(101, 1)], inaccessibleProcesses: 0 })) };
    const result = await new MacosNativeProcessSupervisor(sampler).run(f.command, { identities: async () => { throw new Error("disk-full"); } });
    expect(f.child.send).not.toHaveBeenCalled(); expect(f.child.disconnect).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ cleanup: "unproven", reason: "native-supervision-incomplete" });
  });
  it("retains reparented descendants while refusing to signal a reused PID", async () => {
    const f = await fixture(); const controller = new AbortController();
    f.child.send.mockImplementation(() => controller.abort());
    let call = 0;
    const tables = [[row(101, 1)], [row(101, 1), row(202, 101)], [row(101, 1), row(202, 1)],
      [row(101, 1), row(202, 1, 999)], [row(101, 1), row(202, 1, 999)], [], [], []];
    const sampler = { readTable: vi.fn(async () => ({ rows: tables[call++] ?? [], inaccessibleProcesses: 0 })) };
    const kill = vi.spyOn(process, "kill").mockImplementation(() => { f.child.emit("exit", null, "SIGTERM"); return true; });
    const identities = vi.fn().mockResolvedValue(undefined);
    const result = await new MacosNativeProcessSupervisor(sampler).run(f.command, { signal: controller.signal, identities });
    expect(result.cancelled).toBe(true);
    expect(result.identities).toContainEqual({ kind: "native", pid: 202, startTime: "libproc:202.000001" });
    expect(kill.mock.calls.every(([pid]) => pid === 101)).toBe(true);
    expect(kill).toHaveBeenCalled();
  });
  it("does not confuse inaccessible foreign processes with missing owned metrics", async () => {
    const f = await fixture(); const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    let rows = [row(101, 1)];
    f.child.send.mockImplementation(() => { rows = []; f.child.emit("exit", 0, null); });
    const sampler = { readTable: vi.fn(async () => ({ rows, inaccessibleProcesses: 303 })) };
    const result = await new MacosNativeProcessSupervisor(sampler).run(f.command, { identities: async () => {} });
    expect(result).toMatchObject({ exitCode: 0, cleanup: "unproven" });
    expect(result.uncertainty).toContain("foreign-process-table-incomplete");
    expect(kill).not.toHaveBeenCalled(); expect(f.child.send).toHaveBeenCalledOnce();
  });
});
