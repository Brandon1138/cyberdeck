import { describe, expect, it, vi } from "vitest";
import { ResourceRuntimeRecovery } from "../../src/runtime/resources/resource-runtime-recovery.js";
import type { ResourceRuntimeBinding } from "../../src/domain/resource-runtime.js";

const binding: ResourceRuntimeBinding = { request: { requestId: "request", owner: { installationId: "test", workloadId: "worker",
  generation: 1, kind: "worker" }, demand: { memoryBytes: 1024, cpuWeight: 100, pidLimit: 10,
  profileId: "test", profileVersion: "1" }, priority: "interactive" }, phase: "bound", identities: [
  { kind: "native", pid: 42, startTime: "libproc:123.000001" },
  { kind: "native", pid: 43, startTime: "libproc:123.000002" },
] };
describe("runtime recovery identity fencing", () => {
  it("retains reparented descendants after root exit and ignores a reused PID birth", async () => {
    const native = vi.fn(async (pid: number) => pid === 42
      ? { kind: "native" as const, pid, startTime: "libproc:999.000001" }
      : { kind: "native" as const, pid, startTime: "libproc:123.000002" });
    const recovery = new ResourceRuntimeRecovery({ native, container: async () => "unknown", inventoryComplete: async () => true });
    expect((await recovery.inspect(binding)).state).toBe("running");
    native.mockImplementation(async pid => ({ kind: "native", pid, startTime: "libproc:999.000001" }));
    expect((await recovery.inspect(binding)).state).toBe("terminated");
  });
  it("never equates unavailable metrics, missing inventory, or engine outage with termination", async () => {
    const recovery = new ResourceRuntimeRecovery({ native: async () => undefined,
      container: async () => "unknown", inventoryComplete: async () => true });
    expect((await recovery.inspect(binding)).state).toBe("unknown");
    expect((await recovery.inspect({ ...binding, identities: [] })).state).toBe("unknown");
    expect((await recovery.inspect({ ...binding, identities: [{ kind: "container", containerId: "a".repeat(64) }] })).state).toBe("unknown");
    const incomplete = new ResourceRuntimeRecovery({ native: async () => null,
      container: async () => "terminated", inventoryComplete: async () => false });
    expect((await incomplete.inspect(binding)).state).toBe("unknown");
  });
});
