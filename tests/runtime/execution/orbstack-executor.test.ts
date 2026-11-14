import { WorkerExecutionService } from "../../../src/orchestration/worker-execution-service.js";
import type { ExecutionRecord } from "../../../src/domain/worker-execution.js";
import type { SessionRuntime } from "../../../src/domain/session-runtime.js";
import { fixture, deferred, identity, actor, successor } from "../../orchestration/strigoi-admission-fixture.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrbStackClient } from "../../../src/runtime/execution/orbstack-client.js";
import { OrbStackExecutor, networkProfileSupport } from "../../../src/runtime/execution/orbstack-executor.js";
import type { SessionRecord } from "../../../src/domain/session.js";
import type { ContainerInspection } from "../../../src/runtime/execution/orbstack-client.js";
import { containerLaunchContext } from "../../../src/runtime/execution/container-launch-context.js";
import { mkdir } from "node:fs/promises";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const image = `sha256:${"a".repeat(64)}`;
function executor(network: "egress" | "none", run = vi.fn(async () => { throw new Error("DOCKER_MUST_NOT_RUN"); })) {
  const client = new OrbStackClient("unix:///tmp/orbstack.sock", run);
  const contexts = { prepare: vi.fn(async () => { throw new Error("CONTEXT_MUST_NOT_PREPARE"); }), get: vi.fn(async () => { throw new Error("CONTEXT_UNKNOWN"); }) };
  return { run, contexts, backend: new OrbStackExecutor({ client, profile: { image, cpus: 1, memoryBytes: 256 * 1024 * 1024, slots: 1, network }, contexts, attach: () => { throw new Error("ATTACH_MUST_NOT_RUN"); }, evidenceDirectory: "/nonexistent", onFailure: () => {} }) };
}
describe("OrbStack network profiles", () => {
  it.each(["freeze", "start", "verify-fails"] as const)("runs real backend verification before launch admission: %s", async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "orbstack-admission-")); roots.push(root);
    const f = fixture(), entered = deferred(), finish = deferred();
    const context = containerLaunchContext({ hostState: join(root, "state"), hostCredentials: join(root, "credentials"),
      reportingUrl: "http://host.docker.internal:1234/v1/report", workspace: { mode: "independent-clone", executionId: randomUUID(),
        hostPath: join(root, "clone"), guestPath: "/workspace", source: root, baseCommit: "a".repeat(40), branch: "work", manifestHash: "b".repeat(64) } });
    await mkdir(context.hostCredentials);
    const inspection: ContainerInspection = { Id: "c".repeat(64), Name: "fixture", Config: { Labels: {}, User: "1000:1000", Image: image },
      State: { Running: false, ExitCode: 0, OOMKilled: false },
      HostConfig: { Memory: 256 * 1024 ** 2, MemorySwap: 256 * 1024 ** 2, NanoCpus: 1e9, Privileged: false,
        ReadonlyRootfs: true, PidsLimit: 512, PidMode: "", IpcMode: "private", NetworkMode: "bridge", CapAdd: null, Devices: [],
        CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges"] },
      Mounts: [{ Source: context.workspace.hostPath, Destination: "/workspace", RW: false },
        { Source: context.hostState, Destination: "/home/worker", RW: true }, { Source: context.hostCredentials, Destination: "/run/credentials", RW: false }] };
    const client = new OrbStackClient("unix:///tmp/fixture", async () => { throw new Error("NO_DOCKER"); });
    vi.spyOn(client, "capacity").mockResolvedValue({ cpus: 4, memory: 4 * 1024 ** 3 });
    vi.spyOn(client, "inspect").mockResolvedValue(inspection);
    const stop = vi.spyOn(client, "stop").mockResolvedValue(inspection);
    const verify = vi.spyOn(client, "verify").mockImplementation(async () => {
      entered.resolve(); await finish.promise; if (mode === "verify-fails") throw new Error("VERIFY_FAILED");
    });
    const runtime: SessionRuntime = { pid: 1234, write: vi.fn(), resize: vi.fn(), snapshot: () => Buffer.alloc(0),
      kill: vi.fn(), onOutput: () => () => {}, onExit: () => () => {} };
    const attach = vi.fn(() => runtime);
    const backend = new OrbStackExecutor({ client, profile: { image, cpus: 1, memoryBytes: 256 * 1024 ** 2, slots: 1, network: "egress" },
      contexts: { prepare: async () => context, get: async () => context }, attach, evidenceDirectory: root, onFailure: vi.fn() });
    const records = new Map<string, ExecutionRecord>();
    const executions = new WorkerExecutionService({ brokerId: randomUUID(), get: (id) => records.get(id),
      list: () => [...records.values()], put: async (record) => { records.set(record.ref.sessionId, record); } }, { "orbstack-container": backend });
    const id = randomUUID();
    const record = { ...f.registry.get(id), executor: "orbstack-container" as const };
    const admitted = vi.fn();
    const pending = executions.start(record, { executable: "node", args: [], cwd: "/workspace", env: {} }, 1024,
      (apply) => f.admission.run(actor, "mutate", async () => { admitted(); return apply(); }));
    const result = mode === "start" ? expect(pending).resolves.toMatchObject({ pid: 1234 })
      : expect(pending).rejects.toThrow(mode === "freeze" ? "STRIGOI_STALE_INCARNATION" : "VERIFY_FAILED");
    await entered.promise;
    expect(attach).not.toHaveBeenCalled(); expect(admitted).not.toHaveBeenCalled();
    if (mode === "freeze") {
      await f.admission.freeze(identity); // must resolve with real backend verify still unresolved
      f.set({ ...f.state(), incarnation: 2, activeBinding: { ...f.state().activeBinding!, sessionId: successor,
        resident: { name: "strigoi", incarnation: 2 } } });
    }
    finish.resolve(); await result;
    expect(verify).toHaveBeenCalledOnce();
    if (mode === "start") {
      expect(admitted).toHaveBeenCalledOnce(); expect(attach).toHaveBeenCalledOnce();
      expect(records.get(id)?.phase).toBe("running");
      await backend.stop(record.execution!, true);
    } else {
      expect(admitted).not.toHaveBeenCalled(); expect(attach).not.toHaveBeenCalled();
      expect(records.get(id)).toMatchObject({ phase: "failed", cleanupFailed: false });
      expect(stop).toHaveBeenCalled();
    }
    expect(backend.slots.snapshot().running).toEqual([]);
  });
  it.each([
    { NetworkMode: "host" }, { ReadonlyRootfs: false }, { MemorySwap: -1 },
    { PidsLimit: -1 }, { PidMode: "host" }, { IpcMode: "host" },
    { CapAdd: ["SYS_ADMIN"] }, { Devices: [{}] },
  ])("refuses an inspected boundary that differs from the requested isolation: %j", async (altered) => {
    const root = await mkdtemp(join(tmpdir(), "boundary-mismatch-")); roots.push(root);
    const id = randomUUID(), identity = { brokerId: randomUUID(), executionId: randomUUID(), workerId: id, sessionId: id, generation: 1 };
    const context = containerLaunchContext({ hostState: join(root, "state"), hostCredentials: join(root, "credentials"),
      reportingUrl: "http://host.docker.internal:1234/v1/report", workspace: { mode: "independent-clone", executionId: identity.executionId,
        hostPath: join(root, "clone"), guestPath: "/workspace", source: root, baseCommit: "a".repeat(40), branch: "work", manifestHash: "b".repeat(64) } });
    await mkdir(context.hostCredentials);
    const inspection: ContainerInspection = { Id: "c".repeat(64), Name: "fixture", Config: { Labels: {}, User: "1000:1000", Image: image },
      State: { Running: false, ExitCode: 0, OOMKilled: false },
      HostConfig: { Memory: 256 * 1024 ** 2, MemorySwap: 256 * 1024 ** 2, NanoCpus: 1e9, Privileged: false,
        ReadonlyRootfs: true, PidsLimit: 512, PidMode: "", IpcMode: "private", NetworkMode: "bridge", CapAdd: null, Devices: [],
        CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges"], ...altered },
      Mounts: [{ Source: context.workspace.hostPath, Destination: "/workspace", RW: false },
        { Source: context.hostState, Destination: "/home/worker", RW: true }, { Source: context.hostCredentials, Destination: "/run/credentials", RW: false }] };
    const client = new OrbStackClient("unix:///tmp/fixture");
    vi.spyOn(client, "capacity").mockResolvedValue({ cpus: 4, memory: 4 * 1024 ** 3 });
    vi.spyOn(client, "inspect").mockResolvedValue(inspection);
    const backend = new OrbStackExecutor({ client, profile: { image, cpus: 1, memoryBytes: 256 * 1024 ** 2, slots: 1, network: "egress" },
      contexts: { prepare: async () => context, get: async () => context }, attach: () => { throw new Error("NO_START"); }, evidenceDirectory: root, onFailure: () => {} });
    await expect(backend.prepare({ identity, record: { id, sandbox: "read-only" } as SessionRecord,
      request: { executor: "orbstack-container", profile: "ordinary" }, launch: { executable: "node", args: [], cwd: "/workspace", env: {} } })).rejects.toThrow("CONTAINER_BOUNDARY_MISMATCH");
    expect(backend.slots.snapshot().running).toEqual([]);
  });
  it("reports the none profile as unsupported with its reason, never as a silent egress launch", async () => {
    expect(networkProfileSupport("egress")).toEqual({ supported: true });
    expect(networkProfileSupport("none").supported).toBe(false);
    const root = await mkdtemp(join(tmpdir(), "orbstack-none-")); roots.push(root);
    const { backend, run, contexts } = executor("none");
    expect(backend.support()).toMatchObject({ network: "none", supported: false });
    const id = randomUUID();
    const record: SessionRecord = { id, provider: "codex", executor: "orbstack-container", kind: "worker", cwd: root, sandbox: "read-only", detached: true,
      generation: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), executionState: "starting", attachmentState: "detached", pid: 0, exitCode: null, childIds: [] };
    await expect(backend.prepare({ record, request: { executor: "orbstack-container", profile: "ordinary" },
      identity: { brokerId: randomUUID(), executionId: randomUUID(), workerId: id, sessionId: id, generation: 1 },
      launch: { executable: "node", args: [], cwd: "/workspace", env: {}, transport: "pty" } })).rejects.toThrow("CONTAINER_NETWORK_PROFILE_UNSUPPORTED");
    expect(run).not.toHaveBeenCalled();
    expect(contexts.prepare).not.toHaveBeenCalled();
    expect(backend.slots.snapshot()).toEqual({ running: [], queued: [], capacity: 1 });
  });
  it("keeps the egress profile supported", () => {
    expect(executor("egress").backend.support()).toEqual({ network: "egress", supported: true });
  });
});
