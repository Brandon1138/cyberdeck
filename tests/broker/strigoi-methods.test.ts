import { afterEach, expect, it, vi } from "vitest";
import { BROKER_METHODS } from "../../src/broker/server/methods.js";
import { strigoiMethods } from "../../src/broker/server/strigoi-methods.js";

const call = (method: string, params: unknown, control: object) => strigoiMethods[method]!({ options: { strigoi: control } } as never, {} as never, { params } as never);
it("inspection is read only and Alfred has no separate endpoint", async () => {
  const inspect = vi.fn(async () => ({ readiness: "unconfigured" }));
  expect(await call("strigoi.inspect", {}, { inspect })).toEqual({ readiness: "unconfigured" });
  expect(inspect).toHaveBeenCalledOnce();
  expect(Object.keys(BROKER_METHODS).some(k => /alfred/i.test(k))).toBe(false);
});
it("requires an explicit Codex model and absolute cwd before configuring", async () => {
  const configure = vi.fn();
  for (const params of [{}, { provider: "codex", cwd: "/repo" }, { provider: "claude", model: "x", cwd: "/repo" }, { provider: "codex", model: "x", cwd: "relative" }]) {
    await expect(call("strigoi.configure", params, { configure })).rejects.toThrow();
  }
  expect(configure).not.toHaveBeenCalled();
});
it("routes logical input without accepting session identity or enabling implicitly", async () => {
  const submit = vi.fn(async () => ({ id: "original" }));
  await call("strigoi.submit", { message: "continue", messageId: "stable" }, { submit });
  expect(submit).toHaveBeenCalledWith("continue", "stable");
  await expect(call("strigoi.submit", { message: "continue", sessionId: "old" }, { submit })).rejects.toThrow();
});

import { successionFixture } from "../orchestration/strigoi-succession-fixture.js";
import { StrigoiControl } from "../../src/orchestration/strigoi-control.js";
import { OrchestratorManager } from "../../src/orchestration/orchestrator-manager.js";
import { OrchestratorStore } from "../../src/persistence/orchestrator-store.js";
import { StrigoiTurns } from "../../src/orchestration/strigoi-turns.js";
import { FleetProjection } from "../../src/broker/fleet-projection.js";
const fixtures: Awaited<ReturnType<typeof successionFixture>>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); });
async function setup() {
  const f = await successionFixture(true); fixtures.push(f);
  const manager = new OrchestratorManager(f.registry, f.bindings, undefined, undefined, async () => []);
  const submit = vi.fn(async () => ({} as never));
  const control = new StrigoiControl({ repository: f.bindings.strigoi, registry: f.registry, admission: f.runtime.admission,
    lifecycle: f.runtime.lifecycle, continuity: f.runtime.continuity!, succession: f.runtime.succession!,
    delivery: { ...f.delivery, submit, flush: async () => {} }, validateSelection: s => manager.validateResidentSelection(s) });
  return { ...f, control, manager, submit, actor: f.original.activeBinding!.sessionId };
}
it("uses the existing catalog before any configuration write", async () => {
  const f = await setup(), before = await f.bindings.strigoi.read();
  await expect(call("strigoi.configure", { provider: "codex", model: "invented", cwd: f.root }, f.control)).rejects.toThrow("Unsupported orchestrator selection");
  expect(await f.bindings.strigoi.read()).toEqual(before);
  expect(f.spawn).toHaveBeenCalledTimes(1);
});
it("inspection is read-only on the actual lifecycle, including continuation holds", async () => {
  const f = await setup(), state = await f.bindings.strigoi.read();
  await f.bindings.strigoi.compareAndSwap(state.revision, "limitation", { ...state, revision: state.revision + 1, continuationHolds: [{ code: "workflow", detail: "Original workflow requires operator continuation", sourceIds: ["run-original", "message-original"] }] });
  const before = await f.bindings.strigoi.read(), starts = f.spawn.mock.calls.length;
  const inspection = await call("strigoi.inspect", {}, f.control);
  expect(inspection).toMatchObject({ state: { continuationHolds: [{ sourceIds: ["run-original", "message-original"] }] } });
  expect(await f.bindings.strigoi.read()).toEqual(before); expect(f.spawn).toHaveBeenCalledTimes(starts); expect(f.inference).not.toHaveBeenCalled();
});
it("rejects stale agents, supplied identities and suspended renew without changing desired state", async () => {
  const f = await setup();
  await expect(call("agent.strigoi.renew", { actorSessionId: "11111111-1111-4111-8111-111111111111", reason: "x", mutationId: "stale" }, f.control)).rejects.toThrow("STRIGOI_STALE_INCARNATION");
  await expect(call("agent.strigoi.checkpoint", { actorSessionId: f.actor, identity: { sessionId: f.actor }, prose: "x", mutationId: "bad" }, f.control)).rejects.toThrow();
  await call("strigoi.suspend", { mutationId: "suspend" }, f.control);
  await expect(call("agent.strigoi.renew", { actorSessionId: f.actor, reason: "x", mutationId: "renew" }, f.control)).rejects.toThrow("STRIGOI_SUSPENDED");
  await expect(call("strigoi.renew", { expectedIncarnation: 1, mutationId: "operator-renew" }, f.control)).rejects.toThrow("STRIGOI_SUSPENDED");
  expect((await f.bindings.strigoi.read()).desired).toBe("suspended");
});
it("checkpoint/read/ack use current grants and recheck revocation after source capture", async () => {
  const f = await setup();
  const cp = await call("agent.strigoi.checkpoint", { actorSessionId: f.actor, prose: "Continue original work", mutationId: "cp" }, f.control) as { artifactId: string; sha256: string; coverageId: string };
  expect(await call("agent.strigoi.read", { actorSessionId: f.actor, packet: cp }, f.control)).toMatchObject({ packet: { prose: "Continue original work" } });
  await call("agent.strigoi.acknowledge", { actorSessionId: f.actor, packetHash: cp.sha256, coverageId: cp.coverageId, handledSourceIds: [], account: "Pending work is still pending", mutationId: "ack" }, f.control);
  const capture = f.evidence.sources.capture.bind(f.evidence.sources);
  vi.spyOn(f.evidence.sources, "capture").mockImplementationOnce(async state => {
    const sources = await capture(state), current = await f.bindings.strigoi.read();
    await f.bindings.strigoi.compareAndSwap(current.revision, "revoke", { ...current, revision: current.revision + 1,
      activeBinding: { ...current.activeBinding!, grant: { ...current.activeBinding!.grant, capabilities: ["thread.read"] } } });
    return sources;
  });
  await expect(call("agent.strigoi.checkpoint", { actorSessionId: f.actor, prose: "late", mutationId: "late" }, f.control)).rejects.toThrow("CAPABILITY_DENIED");
  expect((await f.bindings.strigoi.read()).continuityReceipts?.some(r => r.mutationId === "late")).toBe(false);
  await expect(call("agent.strigoi.acknowledge", { actorSessionId: f.actor, packetHash: cp.sha256, coverageId: cp.coverageId, handledSourceIds: [], account: "x", mutationId: "late-ack" }, f.control)).rejects.toThrow("CAPABILITY_DENIED");
  await expect(call("agent.strigoi.renew", { actorSessionId: f.actor, reason: "x", mutationId: "late-renew" }, f.control)).rejects.toThrow("CAPABILITY_DENIED");
});
it("resident grant toggles use CAS, preserve identity, and survive replay without legacy put", async () => {
  const f = await setup(), put = vi.spyOn(f.bindings, "put"), prior = await f.bindings.strigoi.read();
  await f.manager.fableWorkers({ cwd: f.root, scope: "fleet", sessionId: f.actor, enabled: true });
  await f.manager.peerCreate({ cwd: f.root, scope: "fleet", sessionId: f.actor, enabled: false });
  expect(put).not.toHaveBeenCalled();
  const state = await new OrchestratorStore(f.root).strigoi.read();
  expect(state.revision).toBe(prior.revision + 2);
  expect(state.activeBinding?.sessionId).toBe(f.actor);
  expect(state.activeBinding?.grant.capabilities).toContain("worker.start.fable");
  expect(state.activeBinding?.grant.capabilities).not.toContain("orchestrator.create");
  await expect(f.manager.reset({ cwd: f.root, scope: "fleet", sessionId: f.actor })).rejects.toThrow("STRIGOI_EVIDENCE_REFERENCED");
  await expect(f.manager.resetSessionBinding(f.actor)).rejects.toThrow("STRIGOI_EVIDENCE_REFERENCED");
});
it("explicit force after internal retirement intent suspends durably before kill", async () => {
  const f = await setup(); f.setAutoExit(false);
  await f.registry.stopResidentProcess(f.actor);
  expect((await f.bindings.strigoi.read()).desired).toBe("enabled");
  await f.registry.forceStop(f.actor);
  expect((await new OrchestratorStore(f.root).strigoi.read()).desired).toBe("suspended");
});
it.each(["session.stopOne", "session.stop"])("%s suspends; generic resume and delete cannot bypass continuity", async method => {
  const f = await setup();
  const server = { options: { registry: f.registry, orchestrators: f.manager } };
  await BROKER_METHODS[method]!(server as never, {} as never, { params: { sessionId: f.actor } } as never);
  expect((await f.bindings.strigoi.read()).desired).toBe("suspended");
  for (const method of ["session.resume", "session.delete"]) await expect(BROKER_METHODS[method]!(server as never, {} as never, { params: { sessionId: f.actor } } as never)).rejects.toThrow(/STRIGOI_(RESUME_REQUIRES_LIFECYCLE|EVIDENCE_REFERENCED)/);
});
it("native writer blocks renewal, and Fleet projects exactly one canonical row after cutover", async () => {
  const f = await setup();
  await f.registry.attach(f.actor, "human", "control", () => {});
  const turns = new StrigoiTurns(f.registry, f.transcripts, f.evidence.turnPrompt);
  expect(await turns.boundary({ sessionId: f.actor, incarnation: 1, generation: 1 })).toBe("busy");
  f.setBoundary("busy");
  const t = await call("strigoi.renew", { expectedIncarnation: 1, mutationId: "renew" }, f.control) as { id: string };
  await f.drive(t.id, 1); f.tick(120_001); expect((await f.drive(t.id, 1)).hold?.code).toBe("awaiting-safe-boundary");
  expect(f.spawn).toHaveBeenCalledTimes(1); expect(f.writes).not.toHaveBeenCalled();
  await f.registry.detach(f.actor, "human"); f.setBoundary("safe");
  const next = await f.drive(t.id);
  expect(next.activeBinding!.sessionId).not.toBe(f.actor);
  expect(f.registry.get(next.activeBinding!.sessionId).attachmentState).toBe("detached");
  const projection = await new FleetProjection({ registry: f.registry, strigoi: f.control, socketPath: "fixture", orchestratorBindings: f.bindings }).read();
  expect(projection.retained.snapshot.threads.filter(t => t.strigoi?.canonical).map(t => t.record.id)).toEqual([next.activeBinding!.sessionId]);
  expect(projection.retained.snapshot.threads.find(t => t.record.id === f.actor)?.strigoi?.canonical).toBe(false);
});

import { AgentControlService } from "../../src/orchestration/agent-control-service.js";
it("agent stop of an exited resident durably suspends instead of allowing recovery", async () => {
  const f = await setup();
  const peer = await f.manager.create({ provider: "codex", model: "gpt-5.6-sol", cwd: f.root, scope: "fleet" });
  f.emitExit(1);
  await vi.waitFor(() => expect(f.registry.get(f.actor).exitCode).not.toBeNull());
  const agents = new AgentControlService(f.registry, f.bindings, f.transcripts, undefined, { strigoi: f.runtime.admission });
  const result = await agents.stopOrchestrator({ actorSessionId: peer.session.id, targetSessionId: f.actor, expectedGeneration: 1, reason: "operator-directed cleanup" });
  expect(result.outcome).toBe("ALREADY_TERMINAL");
  expect((await f.bindings.strigoi.read()).desired).toBe("suspended");
});
it("force is never a first stop and internal shutdown never suspends", async () => {
  const f = await setup();
  await expect(f.registry.forceStop(f.actor)).rejects.toThrow("Graceful stop must be requested before force");
  expect((await f.bindings.strigoi.read()).desired).toBe("enabled");
  await f.registry.stopAll();
  expect((await f.bindings.strigoi.read()).desired).toBe("enabled");
});

import { WorkerControlService } from "../../src/orchestration/worker-control-service.js";
it("generic agent worker controls cannot stop the resident through a worker lease", async () => {
  const f = await setup();
  const peer = await f.manager.create({ provider: "codex", model: "gpt-5.6-sol", cwd: f.root, scope: "fleet" });
  const control = new WorkerControlService({ registry: f.registry, orchestrators: f.bindings, strigoi: f.runtime.admission, coordination: {} as never });
  await expect(control.control({ actorSessionId: peer.session.id, workerId: f.actor, action: "stop", reason: "x" })).rejects.toMatchObject({ code: "STRIGOI_LIFECYCLE_REQUIRED" });
  expect((await f.bindings.strigoi.read()).desired).toBe("enabled");
  expect(f.registry.get(f.actor).exitCode).toBeNull();
});
it("a delayed explicit predecessor stop cannot suspend the successor", async () => {
  const f = await setup();
  const t = await f.runtime.succession!.renew(1, "renew", "race-renew");
  const setDesired = f.runtime.lifecycle.setDesired.bind(f.runtime.lifecycle);
  vi.spyOn(f.runtime.lifecycle, "setDesired").mockImplementationOnce(async (...args) => {
    const next = await f.drive(t.id);
    expect(next.activeBinding?.sessionId).not.toBe(f.actor);
    return setDesired(...args);
  });
  await expect(f.registry.stop(f.actor)).rejects.toThrow("STRIGOI_STALE_INCARNATION");
  const state = await f.bindings.strigoi.read();
  expect(state.desired).toBe("enabled");
  expect(f.registry.get(state.activeBinding!.sessionId).exitCode).toBeNull();
});
it("an enable response cannot overwrite a suspension that won after its configuration commit", async () => {
  const f = await setup(), configure = f.runtime.lifecycle.configure.bind(f.runtime.lifecycle);
  vi.spyOn(f.runtime.lifecycle, "configure").mockImplementationOnce(async (...args) => {
    const result = await configure(...args);
    await f.runtime.lifecycle.setDesired("suspended", "later-suspend");
    return result;
  });
  await call("strigoi.configure", { ...f.original.selection, mutationId: "repeat-configure" }, f.control);
  expect((await f.bindings.strigoi.read()).desired).toBe("suspended");
});
