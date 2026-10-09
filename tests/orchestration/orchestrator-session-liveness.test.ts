import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkerCoordinationService } from "../../src/broker/worker-coordination.js";
import { WorkerEventChannel } from "../../src/broker/worker-event-channel.js";
import { BrokerWorkerLeaseCredentialCustodian } from "../../src/broker/worker-lease-credential-custodian.js";
import { fleetWorkerCoordinationView } from "../../src/broker/worker-coordination-view.js";
import { orchestratorController, type OrchestratorBinding } from "../../src/domain/orchestrator.js";
import type { SessionRecord } from "../../src/domain/session.js";
import { OrchestratorControllerDirectory } from "../../src/orchestration/orchestrator-controller-directory.js";
import { OrchestratorSessionLiveness } from "../../src/orchestration/orchestrator-session-liveness.js";
import { WorkerControlService } from "../../src/orchestration/worker-control-service.js";
import { WorkerCoordinationStore } from "../../src/persistence/worker-coordination-store.js";

const ORC = "11111111-1111-4111-8111-111111111111";
const PEER = "22222222-2222-4222-8222-222222222222";
const baseMs = Date.parse("2026-10-09T10:00:00.000Z");
const directories: string[] = [];
const monitors: OrchestratorSessionLiveness[] = [];
afterEach(async () => {
  monitors.splice(0).forEach((monitor) => monitor.dispose());
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function binding(sessionId = ORC, key = "fleet"): OrchestratorBinding {
  return {
    key, sessionId, kind: key.includes(":peer:") ? "peer" : "primary", provider: "codex",
    cwd: "/repo", sandbox: "workspace-write", scope: { kind: "fleet" },
    grant: { subjectSessionId: sessionId, capabilities: ["thread.read", "worker.start"], scope: { kind: "fleet" } },
    createdAt: new Date(baseMs).toISOString(), updatedAt: new Date(baseMs).toISOString(),
  };
}

function session(id: string, kind: "worker" | "orchestrator" = "orchestrator"): SessionRecord {
  return {
    id, kind, provider: "codex", cwd: "/repo", sandbox: "workspace-write", detached: true,
    createdAt: new Date(baseMs).toISOString(), updatedAt: new Date(baseMs).toISOString(),
    executionState: "active", attentionState: "done", attachmentState: "detached",
    pid: 123, generation: 1, exitCode: null, childIds: [],
  };
}

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), "cyberdeck-orc-liveness-"));
  directories.push(directory);
  let nowMs = baseMs;
  const now = () => new Date(nowMs).toISOString();
  const store = new WorkerCoordinationStore(directory);
  const createCoordination = async () => {
    const coordination = new WorkerCoordinationService({ store, now, gracePeriodMs: 5_000 });
    await coordination.initialize();
    return coordination;
  };
  const coordination = await createCoordination();
  const bindings = new Map([[ORC, binding()], [PEER, binding(PEER, `fleet:peer:${PEER}`)]]);
  const records = new Map([[ORC, session(ORC)], [PEER, session(PEER)]]);
  const listeners = new Set<(id: string) => void>();
  const registry = {
    get: (id: string) => {
      const record = records.get(id);
      if (record === undefined) throw Object.assign(new Error("missing session"), { code: "SESSION_NOT_FOUND" });
      return structuredClone(record);
    },
    onSessionUpdate: (listener: (id: string) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
  const bindingDirectory = {
    list: async () => [...bindings.values()],
    findBySessionId: async (id: string) => bindings.get(id),
  };
  const errors = vi.fn();
  const createMonitor = (service = coordination) => {
    const monitor = new OrchestratorSessionLiveness({
      directory: new OrchestratorControllerDirectory(bindingDirectory), registry, coordination: service, onError: errors,
    });
    monitors.push(monitor);
    return monitor;
  };
  const monitor = createMonitor();
  await monitor.start();
  const credentials = new BrokerWorkerLeaseCredentialCustodian();
  const channel = new WorkerEventChannel(coordination, registry, bindingDirectory, {} as never, now, credentials);
  const control = new WorkerControlService({
    coordination, registry: registry as never, orchestrators: bindingDirectory as never,
    instructions: {} as never, now: () => nowMs, credentials,
  });
  return {
    coordination, store, monitor, records, bindings, now, errors, createCoordination, createMonitor, channel, control,
    advance: (ms: number) => { nowMs += ms; },
    notify: (id: string) => { for (const listener of listeners) listener(id); },
    async dispatch(owner = orchestratorController(binding())) {
      const id = randomUUID();
      records.set(id, { ...session(id, "worker"), parentSessionId: ORC, attentionState: "working" });
      const result = await coordination.registerSubject({
        mutationId: `dispatch:${id}`, actor: owner, controller: owner, subjectId: id,
        origin: { creatorControllerId: owner.controllerId, creatorSessionId: ORC,
          taskId: id, threadId: id, createdAt: now() },
        lifecycle: "working", resources: { sessionId: id, worktreePath: "/repo", eventStreamId: `events:${id}` }, reason: "worker dispatch",
      });
      const outcome = result.outcomes[0]!;
      credentials.set(owner.controllerId, id, { leaseToken: outcome.leaseToken!, leaseVersion: outcome.leaseVersion! });
      return { id, owner, token: outcome.leaseToken!, version: outcome.leaseVersion! };
    },
  };
}

describe("orchestrator session lease liveness", () => {
  it.each(["primary", "peer"])("keeps dormant %s leases valid for five minutes and accepts worker-side progress", async (kind) => {
    const bench = await harness();
    const owner = orchestratorController(kind === "peer" ? bench.bindings.get(PEER)! : binding());
    const worker = await bench.dispatch(owner);
    bench.advance(300_000);
    expect(bench.coordination.getSubject(worker.id)?.lease).toMatchObject({ state: "active", version: worker.version });
    expect(Date.parse(bench.coordination.getSubject(worker.id)!.lease.expiresAt)).toBeGreaterThan(Date.parse(bench.now()));
    const sweep = await bench.coordination.expireLeases({ mutationId: "quiet-sweep", reason: "sweep" });
    expect(sweep.outcomes).toEqual([]);
    await expect(bench.channel.submit({ workerId: worker.id, kind: "PROGRESS", summary: "five minutes later", eventId: "late-progress" }))
      .resolves.toMatchObject({ code: "accepted" });
    expect(bench.coordination.getSubject(worker.id)?.lease.version).toBe(worker.version);
    expect(fleetWorkerCoordinationView(bench.coordination.listSubjects())[0]).toMatchObject({ leaseHealth: "active", adoptable: false });
  });

  it("starts grace on confirmed death, refuses adoption before grace, and permits it at the boundary", async () => {
    const bench = await harness();
    const worker = await bench.dispatch();
    bench.advance(300_000);
    bench.records.set(ORC, { ...bench.records.get(ORC)!, executionState: "exited", exitCode: 0 });
    bench.notify(ORC);
    await bench.monitor.flush();
    const deadline = new Date(Date.parse(bench.now()) + 5_000).toISOString();
    expect(bench.coordination.getSubject(worker.id)?.lease).toMatchObject({ state: "active", expiresAt: deadline });
    bench.advance(4_999);
    // A worker report during grace must not resurrect its dead owner or reset the deadline.
    await expect(bench.channel.submit({ workerId: worker.id, kind: "PROGRESS", summary: "within grace", eventId: "grace-progress" }))
      .resolves.toMatchObject({ code: "accepted" });
    const before = await bench.control.lease({ actorSessionId: PEER, action: "adopt", scope: "worker", workerId: worker.id, preview: true, reason: "recover" });
    expect(before.plan?.eligible).toEqual([]);
    expect(before.plan?.blocked[0]?.code).toBe("LEASE_CONFLICT");
    bench.advance(1);
    const after = await bench.control.lease({ actorSessionId: PEER, action: "adopt", scope: "worker", workerId: worker.id, preview: true, reason: "recover" });
    expect(after.plan?.eligible[0]).toMatchObject({ leaseState: "orphaned", leaseExpiresAt: deadline });
    expect(fleetWorkerCoordinationView(bench.coordination.listSubjects())[0]).toMatchObject({ leaseHealth: "orphaned", adoptable: true });
    const adopted = await bench.control.lease({ actorSessionId: PEER, action: "adopt", scope: "worker", workerId: worker.id, reason: "recover" });
    expect(adopted.results[0]).toMatchObject({ code: "ACQUIRED", leaseVersion: worker.version + 1 });
    const fenced = await bench.coordination.renew({ mutationId: "old-owner", actor: worker.owner, controller: worker.owner,
      selector: { scope: "single", subjectId: worker.id }, leaseToken: worker.token, leaseVersion: worker.version, reason: "stale owner" });
    expect(fenced.outcomes[0]?.code).toBe("OWNERSHIP_LOST");
  });

  it("keeps stalled, blocked, failed and stopping sessions alive until their process exits", async () => {
    const bench = await harness();
    const worker = await bench.dispatch();
    for (const executionState of ["active", "errored", "failed", "cancelled"] as const) {
      bench.records.set(ORC, { ...bench.records.get(ORC)!, executionState, attentionState: "needs-input", exitCode: null });
      bench.notify(ORC);
      await bench.monitor.flush();
      bench.advance(300_000);
      expect(bench.coordination.getSubject(worker.id)?.lease.state).toBe("active");
    }
    expect(bench.coordination.listControllerLiveness().find((entry) => entry.controller.controllerId === worker.owner.controllerId)?.state).toBe("connected");
  });

  it("expires external holders on the original 30-second schedule and projects honest lease and adopt reads", async () => {
    const bench = await harness();
    const external = { controllerId: "external", familyId: "external", scope: { kind: "fleet" as const, scopeId: "external" } };
    const worker = await bench.dispatch(external);
    bench.advance(29_999);
    expect(bench.coordination.getSubject(worker.id)?.lease.state).toBe("active");
    bench.advance(2);
    const raw = (await bench.store.load()).subjects.find((subject) => subject.subjectId === worker.id)!;
    expect(raw.lease.state).toBe("active"); // Reads do not mutate durable history.
    expect(bench.coordination.getSubject(worker.id)?.lease.state).toBe("orphaned");
    const preview = await bench.control.lease({ actorSessionId: ORC, action: "adopt", scope: "worker", workerId: worker.id, preview: true, reason: "preview" });
    expect(preview.plan?.eligible[0]).toMatchObject({ leaseState: "orphaned", leaseExpiresAt: raw.lease.expiresAt });
    const events = await bench.control.events({ actorSessionId: ORC, workerId: worker.id });
    expect(events.state[0]).toMatchObject({ leaseState: "orphaned", leaseExpiresAt: raw.lease.expiresAt });
    expect(fleetWorkerCoordinationView(bench.coordination.listSubjects())[0]).toMatchObject({ leaseHealth: "orphaned", adoptable: true });
    await expect(bench.channel.submit({ workerId: worker.id, kind: "PROGRESS", summary: "late external" }))
      .rejects.toMatchObject({ code: "OWNERSHIP_LOST" });
  });

  it("replays liveness idempotently across restart without extending dead-session grace", async () => {
    const bench = await harness();
    const worker = await bench.dispatch();
    const disconnected = { mutationId: "stable-death", actor: worker.owner, controller: worker.owner,
      state: "disconnected" as const, session: { sessionId: ORC, generation: 1 }, reason: "confirmed death" };
    const first = await bench.coordination.observeControllerLiveness(disconnected);
    bench.records.set(ORC, { ...bench.records.get(ORC)!, executionState: "failed", exitCode: 1 });
    bench.advance(4_000);
    bench.monitor.dispose();
    const restarted = await bench.createCoordination();
    const count = (await bench.store.load()).receipts.length;
    await expect(restarted.observeControllerLiveness(disconnected)).resolves.toEqual({ ...first, idempotentReplay: true });
    const monitor = bench.createMonitor(restarted);
    await monitor.start();
    expect((await bench.store.load()).receipts).toHaveLength(count);
    expect(restarted.getSubject(worker.id)?.lease.state).toBe("active");
    bench.advance(1_000);
    expect(restarted.getSubject(worker.id)?.lease.state).toBe("orphaned");
  });

  it("rechecks persisted connected observations at restart including reset bindings and missing sessions", async () => {
    const bench = await harness();
    const worker = await bench.dispatch();
    bench.monitor.dispose();
    bench.bindings.delete(ORC);
    bench.records.delete(ORC);
    bench.advance(300_000);
    const restarted = await bench.createCoordination();
    const monitor = bench.createMonitor(restarted);
    await monitor.start();
    expect(restarted.getSubject(worker.id)?.lease.state).toBe("active");
    bench.advance(5_000);
    expect(restarted.getSubject(worker.id)?.lease.state).toBe("orphaned");
  });

  it("observes binding before launch, failed creation, and a resumed generation without reviving orphaned tokens", async () => {
    const bench = await harness();
    await bench.monitor.bindingSession(binding(), session(ORC));
    const worker = await bench.dispatch();
    await bench.monitor.bindingSession(binding());
    bench.advance(5_000);
    expect((await bench.store.load()).subjects.find((subject) => subject.subjectId === worker.id)?.lease.state).toBe("active");
    bench.records.set(ORC, { ...session(ORC), generation: 2 });
    bench.notify(ORC);
    await bench.monitor.flush();
    expect(bench.coordination.getSubject(worker.id)?.lease.state).toBe("orphaned");
    const fresh = await bench.dispatch();
    bench.advance(300_000);
    expect(bench.coordination.getSubject(fresh.id)?.lease.state).toBe("active");
    expect(bench.errors).not.toHaveBeenCalled();
  });

  it("captures ordered death and resume edges and ignores duplicate session updates", async () => {
    const bench = await harness();
    const observe = vi.spyOn(bench.coordination, "observeControllerLiveness");
    bench.records.set(ORC, { ...session(ORC), executionState: "exited", exitCode: 0 });
    bench.notify(ORC);
    bench.records.set(ORC, { ...session(ORC), generation: 2 });
    bench.notify(ORC);
    bench.notify(ORC);
    await bench.monitor.flush();
    expect(observe.mock.calls.map(([input]) => input.state)).toEqual(["disconnected", "connected"]);
  });

  it("upgrades legacy call-driven observations only after verifying the bound session", async () => {
    const bench = await harness();
    const worker = await bench.dispatch();
    await bench.coordination.observeControllerLiveness({ mutationId: "legacy-heartbeat", actor: worker.owner,
      controller: worker.owner, state: "connected", reason: "pre-upgrade observation" });
    bench.monitor.dispose();
    bench.advance(300_000);
    const restarted = await bench.createCoordination();
    const monitor = bench.createMonitor(restarted);
    await monitor.start();
    expect(restarted.getSubject(worker.id)?.lease).toMatchObject({ state: "active", version: worker.version });
  });

  it("preserves durable execution-renewal fencing while read horizons move", async () => {
    const bench = await harness();
    const worker = await bench.dispatch();
    bench.advance(300_000);
    const renewed = await bench.coordination.renew({ mutationId: "renew-execution", actor: worker.owner,
      controller: worker.owner, selector: { scope: "single", subjectId: worker.id }, leaseToken: worker.token, reason: "renew" });
    const input = { sessionId: worker.id, controllerId: worker.owner.controllerId,
      leaseVersion: worker.version, leaseExpiresAt: renewed.outcomes[0]!.leaseExpiresAt! };
    bench.advance(10);
    expect(bench.coordination.getSubject(worker.id)?.lease.expiresAt).not.toBe(input.leaseExpiresAt);
    expect(bench.coordination.hasCurrentLease(input)).toBe(true);
    expect(bench.coordination.hasCurrentLease({ ...input, leaseVersion: input.leaseVersion + 1 })).toBe(false);
    expect(bench.coordination.hasCurrentLease({ ...input, controllerId: "other" })).toBe(false);
    expect(bench.coordination.hasCurrentLease({ ...input, leaseExpiresAt: bench.now() })).toBe(false);
    expect(bench.coordination.hasCurrentLease({ ...input, sessionId: randomUUID() })).toBe(false);
    bench.advance(30_000);
    expect(bench.coordination.hasCurrentLease(input)).toBe(false);
    expect(bench.coordination.getSubject(worker.id)?.lease.state).toBe("active");
  });
});
