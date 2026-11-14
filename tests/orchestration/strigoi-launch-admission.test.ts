import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrchestratorStore } from "../../src/persistence/orchestrator-store.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionRegistry } from "../../src/broker/session-registry.js";
import { BrokerRuntimeConfigSchema } from "../../src/config.js";
import type { SessionRuntime } from "../../src/domain/session-runtime.js";
import type { OrchestratorBinding } from "../../src/domain/orchestrator.js";
import type { ExecutionRecord } from "../../src/domain/worker-execution.js";
import { WorkerTurnObservationAdapter } from "../../src/runtime/worker-turn-observation-adapter.js";
import { AgentControlService } from "../../src/orchestration/agent-control-service.js";
import { OrchestratorManager } from "../../src/orchestration/orchestrator-manager.js";
import { OrchestratorPeerService } from "../../src/orchestration/orchestrator-peer-service.js";
import { WorkerExecutionService } from "../../src/orchestration/worker-execution-service.js";
import { fixture, deferred, successor, at } from "./strigoi-admission-fixture.js";

const roots: string[] = [];
const registries: SessionRegistry[] = [];
afterEach(async () => { for (const registry of registries.splice(0)) await registry.stopAll(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
function runtime(): SessionRuntime {
  const exits = new Set<(code: number) => void>();
  return { pid: 1234, write: vi.fn(), resize: vi.fn(), snapshot: () => Buffer.alloc(0),
    kill: () => { for (const exit of exits) exit(0); }, onOutput: () => () => {},
    onExit: (listener) => { exits.add(listener); return () => { exits.delete(listener); }; } };
}
async function launchFixture(stage: "discovery" | "permissions" | "provider" | "executor" | "initialization", durable = false) {
  const entered = deferred(), finish = deferred();
  let armed = false;
  const pause = async (point: typeof stage) => { if (armed && point === stage) { entered.resolve(); await finish.promise; } };
  const spawn = vi.fn(runtime), activated = vi.fn(async () => {});
  const records = new Map<string, ExecutionRecord>();
  const executions = new WorkerExecutionService({ brokerId: "fixture", get: (id) => records.get(id),
    list: () => [...records.values()], put: async (record) => { records.set(record.ref.sessionId, record); } }, {
    host: { prepare: async (input) => { await pause("executor"); return { ref: { ...input.identity, executor: input.request.executor, workspaceId: input.record.cwd }, launch: input.launch }; },
      start: async () => spawn(), inspect: async (ref) => ({ state: "absent", ref }), stop: async (ref) => ({ state: "absent", ref }),
      collect: async () => ({ complete: true, manifestRef: "fixture" }), destroy: async () => {} },
  });
  const spec = { executable: "fixture", args: [], cwd: "/repo", env: {} };
  const registry = new SessionRegistry({ adapters: { codex: { id: "codex",
    buildLaunchSpec: () => spec, buildResumeSpec: () => spec,
    prepareLaunch: async () => pause("provider"), initializeSession: async () => pause("initialization") } },
    executions, sessionRuntimeFactory: spawn, journal: { append: async () => {} },
    workerTurnObservation: new WorkerTurnObservationAdapter(), validateCwd: async () => {},
    config: BrokerRuntimeConfigSchema.parse({}) });
  registries.push(registry);
  await registry.ready();
  const actor = (await registry.start({ provider: "codex", cwd: "/repo", sandbox: "read-only", detached: true, kind: "orchestrator" })).id;
  const f = fixture();
  f.set({ ...f.state(), retainedSessionIds: [actor], activeBinding: { ...f.state().activeBinding!, sessionId: actor,
    grant: { ...f.state().activeBinding!.grant, subjectSessionId: actor } } });
  const stored = new Map<string, OrchestratorBinding>();
  const directory = durable ? await mkdtemp(join(tmpdir(), "peer-authority-")) : undefined;
  if (directory) roots.push(directory);
  const authority = directory ? new OrchestratorStore(directory) : undefined;
  if (authority) {
    const { resident: _, ...creator } = f.state().activeBinding!;
    await authority.put({ ...creator, key: `fleet:peer:${actor}`, kind: "peer" });
    await authority.put({ ...creator, key: "fleet", kind: "primary", sessionId: successor,
      grant: { ...creator.grant, subjectSessionId: successor } });
  }
  const bindings = { ...f.bindings,
    withAuthority: <T>(apply: () => Promise<T>) => authority ? authority.withAuthority(apply) : apply(), findBySessionId: (id: string) => authority ? authority.findBySessionId(id) : f.bindings.findBySessionId(id),
    get: async (key: string) => authority ? authority.get(key) : stored.get(key), list: async () => [...stored.values()],
    put: async (binding: OrchestratorBinding) => { await activated(); await authority?.put(binding); stored.set(binding.key, binding); },
    reset: async (key: string) => { await authority?.reset(key); stored.delete(key); } };
  const manager = new OrchestratorManager(registry, bindings, undefined, { list: async () => { await pause("permissions"); return {}; } }, async () => { await pause("discovery"); return []; });
  const peer = new OrchestratorPeerService({ registry, bindings, manager, strigoi: f.admission });
  const agent = new AgentControlService(registry, bindings, {} as never, undefined, { strigoi: f.admission });
  const createPeer = () => peer.create({ actorSessionId: actor, provider: "codex", model: "gpt-5.6-sol", cwd: "/repo",
    reason: "test", approval: { kind: "per-create", quote: "create it", channel: "terminal", grantedAt: at } });
  const startWorker = () => agent.startWorker({ actorSessionId: actor, provider: "codex", cwd: "/repo", prompt: "inspect" });
  const identity = { sessionId: actor, incarnation: 1, generation: 1 };
  spawn.mockClear(); armed = true;
  return { f, registry, actor, identity, entered, finish, spawn, activated, bindings, authority, stored, createPeer, startWorker };
}

describe("Strigoi launch admission through the real manager and launch coordinator", () => {
  it("fails closed when a launch embedding lacks canonical binding authority", async () => {
    const h = await launchFixture("provider"), pending = h.createPeer();
    await h.entered.promise; Reflect.deleteProperty(h.bindings, "withAuthority"); h.finish.resolve();
    await expect(pending).resolves.toMatchObject({ outcome: "LAUNCH_FAILED", code: "AUTHORITY_UNAVAILABLE" });
    expect(h.spawn).not.toHaveBeenCalled(); expect(h.activated).not.toHaveBeenCalled();
  });
  it.each(["revoked", "scope-widens", "narrow-grant", "inactive", "scope-off"] as const)("uses one final creator snapshot for %s", async (change) => {
    const h = await launchFixture("provider", true), pending = h.createPeer();
    await h.entered.promise;
    const find = h.bindings.findBySessionId;
    vi.spyOn(h.bindings, "findBySessionId").mockImplementationOnce(async (id) => {
      const creator = (await h.authority!.findBySessionId(id))!;
      if (change === "inactive") await h.registry.stop(id);
      else if (change === "scope-widens") await h.authority!.put({ ...creator, scope: { kind: "workspace", cwd: "/repo" },
        grant: { ...creator.grant, scope: { kind: "workspace", cwd: "/repo" } } });
      else if (change === "scope-off") {
        const primary = (await h.authority!.get("fleet"))!;
        await h.authority!.put({ ...primary, grant: { ...primary.grant, capabilities: [] } });
      }
      else await h.authority!.put({ ...creator, grant: { ...creator.grant, capabilities: change === "revoked" ? [] : ["orchestrator.create"] } });
      return find(id);
    });
    h.finish.resolve();
    if (change === "narrow-grant") {
      await expect(pending).resolves.toMatchObject({ outcome: "CREATED", grant: ["orchestrator.create"] });
      expect((await h.authority!.list()).find((b) => b.kind === "peer" && b.sessionId !== h.actor)?.grant.capabilities).toEqual(["orchestrator.create"]);
    } else {
      await expect(pending).resolves.toMatchObject({ code: change === "scope-widens" ? "SCOPE_WIDENS" : change === "inactive" ? "ACTOR_NOT_ACTIVE" : change === "scope-off" ? "SCOPE_PEER_CREATE_OFF" : "CAPABILITY_DENIED" });
      expect(h.spawn).not.toHaveBeenCalled(); expect(h.activated).not.toHaveBeenCalled();
      expect((await h.authority!.list()).filter((b) => b.kind === "peer" && b.sessionId !== h.actor)).toEqual([]);
    }
  });
  it("serializes external creator revocation behind the final lookup, binding activation and spawn", async () => {
    const h = await launchFixture("provider", true), pending = h.createPeer();
    await h.entered.promise;
    const creator = (await h.authority!.findBySessionId(h.actor))!;
    const entered = deferred(), finish = deferred(), committed = vi.fn();
    const find = h.bindings.findBySessionId;
    vi.spyOn(h.bindings, "findBySessionId").mockImplementationOnce(async (id) => {
      const snapshot = await find(id); entered.resolve(); await finish.promise; return snapshot;
    });
    h.finish.resolve(); await entered.promise;
    const revoke = h.authority!.put({ ...creator, grant: { ...creator.grant, capabilities: [] } }).then(() => {
      expect(h.spawn).toHaveBeenCalledOnce(); committed();
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(committed).not.toHaveBeenCalled(); expect(h.activated).not.toHaveBeenCalled();
    finish.resolve(); await expect(pending).resolves.toMatchObject({ outcome: "CREATED" }); await revoke;
    expect((await h.authority!.findBySessionId(h.actor))!.grant.capabilities).toEqual([]);
  });
  it.each(["discovery", "permissions", "provider"] as const)("freezes peer %s while pending and never launches the delayed predecessor", async (stage) => {
    const h = await launchFixture(stage);
    const pending = h.createPeer();
    await h.entered.promise;
    await h.f.admission.freeze(h.identity); // preparation is deliberately still unresolved
    h.f.set({ ...h.f.state(), incarnation: 2, activeBinding: { ...h.f.state().activeBinding!, sessionId: successor,
      resident: { name: "strigoi", incarnation: 2 } } });
    h.finish.resolve();
    await expect(pending).resolves.toMatchObject({ outcome: "LAUNCH_FAILED", code: "STRIGOI_STALE_INCARNATION" });
    expect(h.spawn).not.toHaveBeenCalled(); expect(h.activated).not.toHaveBeenCalled();
  });
  it.each(["provider", "executor"] as const)("freezes worker %s while pending and never launches the delayed predecessor", async (stage) => {
    const h = await launchFixture(stage);
    const pending = h.startWorker();
    const result = expect(pending).rejects.toMatchObject({ code: "STRIGOI_STALE_INCARNATION" });
    await h.entered.promise;
    await h.f.admission.freeze(h.identity);
    h.f.set({ ...h.f.state(), incarnation: 2, activeBinding: { ...h.f.state().activeBinding!, sessionId: successor,
      resident: { name: "strigoi", incarnation: 2 } } });
    h.finish.resolve(); await result;
    expect(h.spawn).not.toHaveBeenCalled();
  });
  it("drains peer binding activation and spawn together once activation is admitted", async () => {
    const h = await launchFixture("provider"), entered = deferred(), finish = deferred(), frozen = vi.fn();
    h.activated.mockImplementationOnce(async () => { entered.resolve(); await finish.promise; });
    const pending = h.createPeer();
    await h.entered.promise; h.finish.resolve(); await entered.promise;
    const freeze = h.f.admission.freeze(h.identity).then(frozen);
    await Promise.resolve(); expect(frozen).not.toHaveBeenCalled(); expect(h.spawn).not.toHaveBeenCalled();
    finish.resolve(); await freeze;
    await expect(pending).resolves.toMatchObject({ outcome: "CREATED" });
    expect(h.spawn).toHaveBeenCalledOnce();
  });
  it.each(["worker", "peer"] as const)("does not hold a %s launch permit across initialization", async (kind) => {
    const h = await launchFixture("initialization");
    const pending = kind === "worker" ? h.startWorker() : h.createPeer();
    await h.entered.promise;
    expect(h.spawn).toHaveBeenCalledOnce();
    await h.f.admission.freeze(h.identity);
    h.finish.resolve(); await pending;
  });
  it.each(["discovery", "permissions", "provider"] as const)("refreshes creator permission after %s", async (stage) => {
    const h = await launchFixture(stage), pending = h.createPeer();
    await h.entered.promise;
    h.f.state().activeBinding!.grant.capabilities = [];
    h.finish.resolve();
    await expect(pending).resolves.toMatchObject({ code: "CAPABILITY_DENIED" });
    expect(h.spawn).not.toHaveBeenCalled(); expect(h.activated).not.toHaveBeenCalled();
  });
  it("does not restore inherited capabilities revoked during provider preparation", async () => {
    const h = await launchFixture("provider"), pending = h.createPeer();
    await h.entered.promise;
    h.f.state().activeBinding!.grant.capabilities = ["orchestrator.create"];
    h.finish.resolve();
    await expect(pending).resolves.toMatchObject({ outcome: "CREATED", grant: ["orchestrator.create"] });
    expect([...h.stored.values()][0]?.grant.capabilities).toEqual(["orchestrator.create"]);
    expect(h.spawn).toHaveBeenCalledOnce();
  });
  it.each(["scope-off", "scope-widens", "inactive"] as const)("rechecks %s after provider preparation", async (change) => {
    const h = await launchFixture("provider"), pending = h.createPeer();
    await h.entered.promise;
    if (change === "scope-off") h.stored.set("fleet", { ...h.f.state().activeBinding!, key: "fleet", kind: "primary",
      grant: { ...h.f.state().activeBinding!.grant, capabilities: [] } });
    else if (change === "scope-widens") h.f.state().activeBinding!.scope = { kind: "workspace", cwd: "/repo" };
    else await h.registry.stop(h.actor);
    h.finish.resolve();
    await expect(pending).resolves.toMatchObject({ code: { "scope-off": "SCOPE_PEER_CREATE_OFF", "scope-widens": "SCOPE_WIDENS", inactive: "ACTOR_NOT_ACTIVE" }[change] });
    expect(h.spawn).not.toHaveBeenCalled(); expect(h.activated).not.toHaveBeenCalled();
  });
  it("rechecks worker grants after adapter preparation", async () => {
    const h = await launchFixture("provider"), pending = h.startWorker();
    const result = expect(pending).rejects.toMatchObject({ code: "CAPABILITY_DENIED" });
    await h.entered.promise; h.f.state().activeBinding!.grant.capabilities = []; h.finish.resolve();
    await result; expect(h.spawn).not.toHaveBeenCalled();
  });
});
