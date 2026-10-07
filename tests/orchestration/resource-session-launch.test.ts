import { SessionLifecycleController } from "../../src/orchestration/session/session-lifecycle-controller.js";
import type { SessionRuntimeObserver } from "../../src/orchestration/session/session-runtime-observer.js";
import { describe, expect, it, vi } from "vitest";
import type { SessionRecord } from "../../src/domain/session.js";
import type { SessionRuntime } from "../../src/domain/session-runtime.js";
import type { ResourceSessionLaunchPort } from "../../src/domain/resource-runtime.js";
import { SessionRuntimeAssembly } from "../../src/orchestration/session/session-runtime-assembly.js";
import type { SessionCatalog } from "../../src/orchestration/session/session-catalog.js";
import type { SessionUpdateBus } from "../../src/orchestration/session/session-update-bus.js";
import type { ScoutSessionSupervisorFactory } from "../../src/orchestration/session/scout-session-supervisor.js";
import type { ProviderAdapter, ProviderLaunchSpec } from "../../src/orchestration/session/provider-ports.js";

const spec: ProviderLaunchSpec = { executable: "codex", args: ["-c", 'model_provider="openai"'], cwd: "/fixture", env: {} };
const runtime = { pid: 42 } as SessionRuntime;
function fixture(gate: ResourceSessionLaunchPort) {
  const factory = vi.fn(() => runtime), workerStart = vi.fn(async () => runtime), prepare = vi.fn(async () => {});
  const adapter: ProviderAdapter = { id: "codex", buildLaunchSpec: () => spec, buildResumeSpec: () => spec, prepareLaunch: prepare };
  const catalog = { options: { resourceExecution: gate, sessionRuntimeFactory: factory, executions: { start: workerStart },
    adapters: { codex: adapter } }, replayBytesFor: () => 1024 } as unknown as SessionCatalog;
  const assembly = new SessionRuntimeAssembly({ catalog, bus: {} as SessionUpdateBus,
    scoutSupervision: {} as ScoutSessionSupervisorFactory });
  return { assembly, adapter, factory, workerStart, prepare };
}
describe("shared resource launch boundary", () => {
  it.each(["worker", "orchestrator"] as const)("holds %s preparation and factory until admitted", async kind => {
    let admit!: () => void;
    const admitted = new Promise<void>(resolve => { admit = resolve; });
    const gate: ResourceSessionLaunchPort = { cancelStart: () => false,
      start: async (_record, launch) => { await admitted; return launch(); } };
    const f = fixture(gate);
    const record = { id: "test", provider: "codex", kind, generation: 2 } as SessionRecord;
    const beforeSpawn = vi.fn(async () => {});
    const launch = f.assembly.spawnPreparedLaunch(f.adapter, record, spec, beforeSpawn);
    await Promise.resolve();
    expect(beforeSpawn).toHaveBeenCalledOnce();
    expect(f.prepare).not.toHaveBeenCalled(); expect(f.factory).not.toHaveBeenCalled(); expect(f.workerStart).not.toHaveBeenCalled();
    admit(); expect(await launch).toBe(runtime);
    expect(f.prepare).toHaveBeenCalledWith(record, spec); expect(beforeSpawn).toHaveBeenCalledOnce();
    if (kind === "orchestrator") {
      expect(f.factory).toHaveBeenCalledWith(spec, 1024); expect(f.workerStart).not.toHaveBeenCalled();
    } else {
      expect(f.workerStart).toHaveBeenCalledWith(record, spec, 1024); expect(f.factory).not.toHaveBeenCalled();
    }
  });
  it("never falls back to an unaccounted launch when the gate rejects", async () => {
    const f = fixture({ cancelStart: () => false, start: async () => { throw new Error("RESOURCE_INFEASIBLE"); } });
    await expect(f.assembly.spawnPreparedLaunch(f.adapter, { id: "test", provider: "codex", kind: "orchestrator" } as SessionRecord, spec))
      .rejects.toThrow("RESOURCE_INFEASIBLE");
    expect(f.prepare).not.toHaveBeenCalled(); expect(f.factory).not.toHaveBeenCalled(); expect(f.workerStart).not.toHaveBeenCalled();
  });
});

describe("pending resource launch cancellation", () => {
  it("cancels both resource and executor waits and fences deletion until cancellation settles", async () => {
    const resourceCancel = vi.fn(() => true), executorCancel = vi.fn(() => false), requireRuntime = vi.fn();
    const catalog = { options: { resourceExecution: { cancelStart: resourceCancel }, executions: { cancelStart: executorCancel } },
      requireRuntime } as unknown as SessionCatalog;
    const lifecycle = new SessionLifecycleController({ catalog, bus: {} as SessionUpdateBus,
      assembly: {} as SessionRuntimeAssembly, observer: {} as SessionRuntimeObserver });
    await lifecycle.stop("queued");
    expect(resourceCancel).toHaveBeenCalledWith("queued"); expect(executorCancel).toHaveBeenCalledWith("queued");
    expect(requireRuntime).not.toHaveBeenCalled();
    await expect(lifecycle.delete("queued")).rejects.toThrow("cancellation is pending");
    expect(requireRuntime).not.toHaveBeenCalled();
  });
});
