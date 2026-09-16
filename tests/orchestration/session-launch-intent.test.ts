import { cp, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionLaunchAuthority } from "../../src/broker/session-launch-authority.js";
import { WorkerCoordinationService } from "../../src/broker/worker-coordination.js";
import { WorkerCoordinationStore } from "../../src/persistence/worker-coordination-store.js";
import { BrokerWorkerLeaseCredentialCustodian } from "../../src/broker/worker-lease-credential-custodian.js";
import { SessionRegistry } from "../../src/broker/session-registry.js";
import { BrokerRuntimeConfigSchema } from "../../src/config.js";
import type { SessionRecord, StartSessionRequest } from "../../src/domain/session.js";
import type { SessionRuntime } from "../../src/domain/session-runtime.js";
import { ORCHESTRATOR_GRANT_CAPABILITIES, orchestratorController, peerOrchestratorKey } from "../../src/domain/orchestrator.js";
import { ResourcePolicySchema } from "../../src/domain/resource-budget.js";
import { OrchestratorStore } from "../../src/persistence/orchestrator-store.js";
import { SessionStore } from "../../src/persistence/session-store.js";
import { SessionLaunchIntentStore } from "../../src/persistence/session-launch-intent-store.js";
import { ResourceReservationStore } from "../../src/persistence/resource-reservation-store.js";
import { ResourceRuntimeBindingStore } from "../../src/persistence/resource-runtime-binding-store.js";
import { ResourceAdmissionService } from "../../src/orchestration/resource-admission-service.js";
import { ResourceExecutionGate } from "../../src/orchestration/resource-execution-gate.js";
import { WorkerTurnObservationAdapter } from "../../src/runtime/worker-turn-observation-adapter.js";
import { threadStatus } from "../../src/client/fleet/transport.js";

const GiB = 1024 ** 3;
const directories: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "session-launch-intent-")); directories.push(path); return path;
}
const request: StartSessionRequest = { provider: "cursor", kind: "orchestrator", cwd: "/fixture", detached: true, sandbox: "read-only" };
async function fixture(inputPath?: string, memoryBytes = 6 * GiB) {
  const path = inputPath ?? await directory();
  const ledger = await ResourceReservationStore.open(path, "fixture");
  const bindings = await ResourceRuntimeBindingStore.open(path, () => ledger.assertOwner());
  const intents = await SessionLaunchIntentStore.open(path, () => ledger.assertOwner());
  const sessions = new SessionStore(path), grants = new OrchestratorStore(path);
  let now = Date.now();
  const credentials = new BrokerWorkerLeaseCredentialCustodian();
  const coordination = new WorkerCoordinationService({ store: new WorkerCoordinationStore(path),
    now: () => new Date(now).toISOString(), leaseDurationMs: 30_000 });
  await coordination.initialize();
  let registry!: SessionRegistry;
  let gate!: ResourceExecutionGate;
  let pressure: "normal" | "critical" = "critical";
  let terminated = false;
  const admission = new ResourceAdmissionService(ledger, ResourcePolicySchema.parse({ fixedBytes: GiB,
    uncertainBytes: GiB / 2, controlMarginBytes: GiB / 2, maxPids: 2048 }),
    () => ({ observedAt: Date.now(), availableBytes: 20 * GiB, pressure, attributionComplete: true }),
    (reservation, evidence) => gate.verifyTermination(reservation, evidence));
  gate = new ResourceExecutionGate({ installationId: "fixture", admission, bindings, pollMs: 5,
    assertAuthority: sessionLaunchAuthority({ orchestrators: grants, coordination: () => coordination, credentials,
      session: id => { try { return registry?.get(id); } catch { return undefined; } } }),
    resolveFamily: async record => {
      const binding = await grants.findBySessionId(record.id);
      if (!binding) throw new Error("RESOURCE_CANONICAL_FAMILY_UNAVAILABLE");
      return orchestratorController(binding).familyId;
    }, resolveDemand: () => ({ memoryBytes, cpuWeight: 100, pidLimit: 32, profileId: "fixture", profileVersion: "1" }),
    capture: async () => [{ kind: "native", pid: 42, startTime: "libproc:1234.000001" }],
    inspect: async () => ({ state: terminated ? "terminated" : "unknown", inventoryComplete: terminated, identities: [] }),
  });
  const writes = vi.fn(), prepare = vi.fn(async () => {}), launch = vi.fn((): SessionRuntime => ({
    pid: 42, write: writes, snapshot: () => Buffer.alloc(0), resize() {}, kill() {}, onExit: () => () => {}, onOutput: () => () => {},
  }));
  registry = new SessionRegistry({ config: BrokerRuntimeConfigSchema.parse({}),
    adapters: { cursor: { id: "cursor", deferInitialPrompt: () => true, prepareLaunch: prepare,
      buildLaunchSpec: record => ({ executable: "fixture", args: [], cwd: record.cwd, env: {} }),
      buildResumeSpec: record => ({ executable: "fixture", args: [], cwd: record.cwd, env: {} }) } },
    sessionRuntimeFactory: launch, workerTurnObservation: new WorkerTurnObservationAdapter(),
    journal: { append: async () => {} }, validateCwd: async () => {}, resourceExecution: gate, launchIntents: intents,
    store: sessions, recoveredSessions: await sessions.load(),
  });
  await registry.ready();
  const activate = vi.fn(async (record: SessionRecord) => {
    const now = new Date().toISOString();
    await grants.put({ key: peerOrchestratorKey("fleet", record.id), kind: "peer", sessionId: record.id,
      provider: record.provider, cwd: record.cwd, sandbox: record.sandbox, scope: { kind: "fleet" },
      grant: { subjectSessionId: record.id, capabilities: [...ORCHESTRATOR_GRANT_CAPABILITIES], scope: { kind: "fleet" } },
      createdAt: now, updatedAt: now });
  });
  cleanups.push(async () => {
    for (const record of registry.list()) if (record.pendingLaunch && ["waiting-capacity", "waiting-authority"].includes(record.pendingLaunch.state))
      await registry.stop(record.id).catch(() => undefined);
    await gate.close(); await ledger.close();
  });
  return { path, ledger, bindings, intents, sessions, grants, admission, gate, registry, activate, launch, prepare, writes, coordination, credentials,
    advance: (ms: number) => { now += ms; },
    allow: () => { pressure = "normal"; }, block: () => { pressure = "critical"; },
    confirmTermination: () => { terminated = true; } };
}
async function checkpoint(f: Awaited<ReturnType<typeof fixture>>) {
  const path = await directory();
  // Copy only fsynced broker state, simulating loss of all in-memory continuations at this point.
  await cp(f.path, path, { recursive: true, filter: source => !source.endsWith("resource-owner.lock") });
  for (const record of f.registry.list()) if (record.pendingLaunch) await f.registry.stop(record.id);
  return path;
}

describe("durable interactive launch intents", () => {
  it("returns a visible pending receipt, activates once before admission, and durably cancels through stopTree", async () => {
    const f = await fixture(); await f.gate.reconcile();
    const receipt = await f.registry.start(request, "private original input", f.activate);
    expect(receipt).toMatchObject({ pid: 0, executionState: "starting", pendingLaunch: { state: "waiting-capacity" } });
    expect(threadStatus({ record: receipt })).toBe("Queued");
    expect(f.registry.workerTruth(receipt.id).state).toBe("waiting-capacity");
    expect(f.registry.list()).toHaveLength(1); expect(f.activate).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(f.admission.health().queue).toHaveLength(1));
    expect(f.prepare).not.toHaveBeenCalled(); expect(f.launch).not.toHaveBeenCalled();
    expect((await stat(join(f.path, "session-launch-intents.json"))).mode & 0o777).toBe(0o600);
    await f.registry.stopTree(receipt.id);
    expect(f.intents.get(receipt.id)?.outcome).toBe("cancelled");
    expect(f.registry.get(receipt.id).attentionState).toBe("stopped");
    f.allow(); await f.admission.refresh(); expect(f.launch).not.toHaveBeenCalled();
    await f.registry.delete(receipt.id);
    const restored = await fixture(await checkpoint(f));
    expect(restored.registry.list()).toEqual([]); expect(restored.launch).not.toHaveBeenCalled();
  });

  it("reopens actual stores preserving deferred input, session identity, FIFO, canonical grant, and exactly one launch", async () => {
    const f = await fixture(); await f.gate.reconcile();
    const first = await f.registry.start(request, "cursor initial input: first", f.activate);
    const second = await f.registry.start(request, "cursor initial input: second", f.activate);
    await vi.waitFor(() => expect(f.admission.health().queue).toHaveLength(2));
    const before = f.ledger.read().entries.map(e => ({ id: e.request.requestId, sequence: e.sequence, family: e.request.owner.familyId }));
    const restored = await fixture(await checkpoint(f));
    expect(restored.intents.get(first.id)?.initialPrompt).toBe("cursor initial input: first");
    expect(await restored.grants.findBySessionId(first.id)).toEqual(await f.grants.findBySessionId(first.id));
    restored.allow(); await restored.gate.reconcile(); await restored.admission.refresh();
    await vi.waitFor(() => expect(restored.registry.get(first.id).executionState).toBe("active"));
    expect(restored.launch).toHaveBeenCalledOnce(); expect(restored.writes).toHaveBeenCalledOnce();
    expect(restored.writes.mock.calls[0]![0].toString()).toContain("cursor initial input: first");
    expect(restored.registry.get(second.id).executionState).toBe("starting");
    expect(restored.ledger.read().entries.map(e => ({ id: e.request.requestId, sequence: e.sequence, family: e.request.owner.familyId }))).toEqual(before);
    expect(restored.activate).not.toHaveBeenCalled();
  });

  it("preserves an admitted prelaunch claim without deadlocking the recovery barrier", async () => {
    const f = await fixture(); await f.gate.reconcile();
    const receipt = await f.registry.start(request, "reserved input", f.activate);
    await vi.waitFor(() => expect(f.admission.health().queue).toHaveLength(1));
    const copy = await checkpoint(f);
    // The durable queue was admitted just before the crash, but no preparation fence was crossed.
    const ledger = await ResourceReservationStore.open(copy, "fixture");
    const snapshot = ledger.read(); snapshot.entries[0]!.state = "admitted";
    const revision = snapshot.revision; snapshot.revision++; await ledger.save(snapshot, revision); await ledger.close();
    const restored = await fixture(copy); restored.allow();
    await restored.gate.reconcile();
    await vi.waitFor(() => expect(restored.registry.get(receipt.id).executionState).toBe("active"));
    expect(restored.launch).toHaveBeenCalledOnce();
  });

  it("keeps missing canonical authority visible without inventing a grant, then cancels durably", async () => {
    const f = await fixture(); await f.gate.reconcile();
    const receipt = await f.registry.start(request, "held input", f.activate);
    await vi.waitFor(() => expect(f.admission.health().queue).toHaveLength(1));
    const copy = await checkpoint(f), grants = new OrchestratorStore(copy);
    await grants.reset(peerOrchestratorKey("fleet", receipt.id));
    const restored = await fixture(copy); restored.allow(); await restored.gate.reconcile();
    await vi.waitFor(() => expect(restored.registry.get(receipt.id).pendingLaunch?.state).toBe("waiting-authority"));
    expect(threadStatus({ record: restored.registry.get(receipt.id) })).toBe("Awaiting authority");
    expect(restored.registry.workerTruth(receipt.id).state).toBe("waiting-authority");
    expect(restored.launch).not.toHaveBeenCalled(); await restored.registry.stopTree(receipt.id);
    expect(restored.intents.get(receipt.id)?.outcome).toBe("cancelled");
  });

  it("never replays an ambiguous launch fence or its deferred first input", async () => {
    const f = await fixture(); await f.gate.reconcile();
    const receipt = await f.registry.start(request, "must not duplicate", f.activate);
    await vi.waitFor(() => expect(f.admission.health().queue).toHaveLength(1));
    const copy = await checkpoint(f);
    const intents = await SessionLaunchIntentStore.open(copy, () => {});
    await intents.put({ ...intents.get(receipt.id)!, phase: "launching" }, "ready");
    const restored = await fixture(copy); restored.allow(); await restored.gate.reconcile();
    expect(restored.registry.get(receipt.id)).toMatchObject({ attentionState: "interrupted", pendingLaunch: { state: "interrupted" } });
    expect(restored.launch).not.toHaveBeenCalled(); expect(restored.writes).not.toHaveBeenCalled();
    await expect(restored.registry.resume(receipt.id)).rejects.toThrow("cannot be resumed");
  });

  it("fails closed before admission when activation or intent persistence fails", async () => {
    const f = await fixture(); await f.gate.reconcile();
    await expect(f.registry.start(request, "activation failure", async () => { throw new Error("grant write failed"); })).rejects.toThrow("grant write failed");
    expect(f.intents.list()[0]?.outcome).toBe("interrupted");
    vi.spyOn(f.intents, "put").mockRejectedValue(new Error("disk full"));
    await expect(f.registry.start(request, "persistence failure", f.activate)).rejects.toThrow("disk full");
    expect(f.activate).not.toHaveBeenCalled(); expect(f.admission.health().queue).toEqual([]);
    expect(f.prepare).not.toHaveBeenCalled(); expect(f.launch).not.toHaveBeenCalled();
  });
  it("rechecks a revoked grant after queueing and resumes only when the existing grant returns", async () => {
    const f = await fixture(); await f.gate.reconcile();
    const receipt = await f.registry.start(request, "grant-fenced input", f.activate);
    await vi.waitFor(() => expect(f.admission.health().queue).toHaveLength(1));
    const binding = (await f.grants.findBySessionId(receipt.id))!;
    await f.grants.put({ ...binding, grant: { ...binding.grant, capabilities: [] } });
    f.allow(); await f.admission.refresh();
    await vi.waitFor(() => expect(f.registry.get(receipt.id).pendingLaunch?.state).toBe("waiting-authority"));
    expect(f.prepare).not.toHaveBeenCalled();
    await f.grants.put(binding);
    await vi.waitFor(() => expect(f.registry.get(receipt.id).executionState).toBe("active"));
    expect(f.launch).toHaveBeenCalledOnce(); expect(f.writes).toHaveBeenCalledOnce();
  });

  it("uses canonical lease authentication for expiry and loses credential custody across restart", async () => {
    const f = await fixture(); await f.gate.reconcile();
    const receipt = await f.registry.start(request, "leased input", async record => {
      await f.activate(record);
      const controller = orchestratorController((await f.grants.findBySessionId(record.id))!);
      const result = await f.coordination.registerSubject({ mutationId: `register:${record.id}`, actor: controller,
        subjectId: record.id, subjectKind: "worker", controller, lifecycle: "working", reason: "fixture lease",
        origin: { creatorControllerId: controller.controllerId, taskId: "fixture-task", threadId: record.id, createdAt: record.createdAt },
        resources: { sessionId: record.id, eventStreamId: record.id } });
      const granted = result.outcomes[0]!;
      f.credentials.set(controller.controllerId, record.id, { leaseToken: granted.leaseToken!, leaseVersion: granted.leaseVersion! });
    });
    await vi.waitFor(() => expect(f.admission.health().queue).toHaveLength(1));
    f.advance(31_000); f.allow(); await f.admission.refresh();
    await vi.waitFor(() => expect(f.registry.get(receipt.id).pendingLaunch?.state).toBe("waiting-authority"));
    expect(f.launch).not.toHaveBeenCalled();
    const restored = await fixture(await checkpoint(f)); restored.allow(); await restored.gate.reconcile();
    await vi.waitFor(() => expect(restored.registry.get(receipt.id).pendingLaunch?.state).toBe("waiting-authority"));
    expect(restored.launch).not.toHaveBeenCalled();
  });

  it("refuses a failed cancel write and requires exact terminal identity before retiring evaluator input", async () => {
    const f = await fixture(); await f.gate.reconcile();
    const receipt = await f.registry.start(request, "retain until captured", f.activate);
    await vi.waitFor(() => expect(f.admission.health().queue).toHaveLength(1));
    const intent = f.intents.get(receipt.id)!;
    await expect(f.intents.ackTerminal(receipt.id, intent.requestId, new Date().toISOString())).rejects.toThrow("ACK_MISMATCH");
    const write = vi.spyOn(f.intents, "put").mockRejectedValueOnce(new Error("cancel disk full"));
    await expect(f.registry.stopTree(receipt.id)).rejects.toThrow("cancel disk full");
    expect(f.intents.get(receipt.id)?.phase).toBe("ready"); expect(f.launch).not.toHaveBeenCalled();
    write.mockRestore(); await f.registry.stopTree(receipt.id);
    const terminal = f.intents.get(receipt.id)!;
    expect(terminal).toMatchObject({ phase: "terminal", outcome: "cancelled", terminalFromPhase: "ready" });
    expect(terminal.terminalAt).toBeDefined();
    await expect(f.intents.ackTerminal(receipt.id, "wrong", terminal.terminalAt!)).rejects.toThrow("ACK_MISMATCH");
    expect(f.intents.get(receipt.id)?.initialPrompt).toBe("retain until captured");
    await f.intents.ackTerminal(receipt.id, terminal.requestId, terminal.terminalAt!);
    await f.intents.ackTerminal(receipt.id, terminal.requestId, terminal.terminalAt!);
    expect(f.intents.get(receipt.id)).toBeUndefined();
  });

  it.each(["ready", "launching"] as const)("never prepares when the %s intent write fails", async phase => {
    const f = await fixture(); await f.gate.reconcile();
    const put = f.intents.put.bind(f.intents);
    vi.spyOn(f.intents, "put").mockImplementation(async (intent, expected) => {
      if (intent.phase === phase) throw new Error("injected intent write failure");
      return put(intent, expected);
    });
    if (phase === "ready") {
      await expect(f.registry.start(request, "held on failed write", f.activate)).rejects.toThrow("injected intent write failure");
    } else {
      f.allow();
      const receipt = await f.registry.start(request, "held on failed fence", f.activate);
      await vi.waitFor(() => expect(f.intents.get(receipt.id)?.phase).toBe("terminal"));
      expect(f.intents.get(receipt.id)?.terminalFromPhase).toBe("ready");
    }
    expect(f.prepare).not.toHaveBeenCalled(); expect(f.launch).not.toHaveBeenCalled();
    expect(f.admission.health().reservedBytes).toBe(0);
  });

  it("recovers a real coordinator preparation crash as unverified without replaying a launch", async () => {
    const f = await fixture(); await f.gate.reconcile(); f.allow();
    let prepared!: () => void;
    f.prepare.mockImplementation(() => new Promise<void>(resolve => { prepared = resolve; }));
    const receipt = await f.registry.start(request, "never replay preparation", f.activate);
    await vi.waitFor(() => expect(f.prepare).toHaveBeenCalledOnce());
    expect(f.intents.get(receipt.id)?.phase).toBe("launching");
    const copy = await checkpoint(f); prepared();
    const restored = await fixture(copy); restored.allow();
    await expect(restored.gate.reconcile()).rejects.toThrow("RECONCILIATION_REQUIRED");
    expect(restored.registry.get(receipt.id).attentionState).toBe("interrupted");
    expect(restored.launch).not.toHaveBeenCalled(); expect(restored.writes).not.toHaveBeenCalled();
  });

  it("holds a recovered child until its parent resumes and the canonical parent binding is restored", async () => {
    const f = await fixture(undefined, 3 * GiB); await f.gate.reconcile(); f.allow();
    const parent = await f.registry.start(request, undefined, f.activate);
    await vi.waitFor(() => expect(f.registry.get(parent.id).executionState).toBe("active"));
    f.block();
    const child = await f.registry.start({ ...request, kind: "worker", parentSessionId: parent.id }, "child input", f.activate);
    const other = await f.registry.start({ ...request, kind: "worker", parentSessionId: parent.id }, "other child", f.activate);
    await vi.waitFor(() => expect(f.admission.health().queue).toHaveLength(2));
    const copy = await checkpoint(f);
    // Model a recovery refresh after confirmed parent termination but before launch intents arm:
    // both child requests now hold the full pool, and neither has crossed its launch fence.
    const crashLedger = await ResourceReservationStore.open(copy, "fixture");
    const snapshot = crashLedger.read(), revision = snapshot.revision;
    for (const entry of snapshot.entries) entry.state = entry.request.owner.workloadId === parent.id ? "released" : "admitted";
    snapshot.revision++; await crashLedger.save(snapshot, revision); await crashLedger.close();
    const restored = await fixture(copy, 3 * GiB);
    await vi.waitFor(() => expect(restored.admission.health().reservedBytes).toBe(0));
    expect(restored.ledger.read().entries.filter(entry => entry.state === "waiting-capacity").map(entry => entry.eligibilityHold))
      .toEqual(["waiting-authority", "waiting-authority"]);
    await vi.waitFor(() => expect(restored.registry.get(child.id).pendingLaunch?.state).toBe("waiting-authority"));
    const parentBinding = (await restored.grants.findBySessionId(parent.id))!;
    await restored.grants.reset(parentBinding.key);
    restored.confirmTermination(); restored.allow(); await restored.gate.reconcile();
    // Restore identity for the explicit parent resume, but leave its worker-start grant revoked.
    await restored.grants.put({ ...parentBinding, grant: { ...parentBinding.grant, capabilities: [] } });
    await restored.registry.resume(parent.id);
    await vi.waitFor(() => expect(restored.registry.get(child.id).pendingLaunch?.state).toBe("waiting-authority"));
    expect(restored.launch).toHaveBeenCalledOnce(); expect(restored.writes).not.toHaveBeenCalled();
    await restored.grants.put(parentBinding);
    await vi.waitFor(() => expect(restored.registry.get(child.id).executionState).toBe("active"));
    expect(restored.launch).toHaveBeenCalledTimes(2); expect(restored.writes).toHaveBeenCalledOnce();
    expect(restored.registry.get(child.id).generation).toBe(1);
    expect(restored.registry.get(other.id).executionState).toBe("starting");
  });

});
