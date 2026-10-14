import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetProjection } from "../../src/broker/fleet-projection.js";
import { BrokerServer } from "../../src/broker/server.js";
import { RpcClient } from "../../src/client/rpc-client.js";
import type { FleetProjectionReply } from "../../src/domain/fleet-projection.js";
import type { SessionRecord } from "../../src/domain/session.js";
import type { BrokerServerOptions } from "../../src/broker/server/options.js";
import type { WorkerTruth } from "../../src/domain/worker-truth.js";

function truth(state: WorkerTruth["state"] = "idle"): WorkerTruth {
  return { state, terminal: false, completedTurns: 0, canonicalTurns: 0, pendingInstructions: 0,
    composerOccupied: false, modalOpen: false, detail: "Current broker observation" };
}

it("keeps historical rows, filters unmatched projections, omits launch payloads and resyncs unknown versions", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  let sessions = [{ id, executionState: "exited", latestPreview: "old history", launchRecord: { args: ["large launch detail"] } }] as unknown as SessionRecord[];
  const options = {
    registry: { list: () => sessions, workerTruth: () => truth("exited") },
    workerCoordination: { listSubjects: () => [{ subjectKind: "worker", resources: { sessionId: "unmatched" } }] },
    orchestratorBindings: { list: async () => [{ sessionId: "unmatched" }] },
    fleetProjects: { list: async () => ["/repo"] },
  } as unknown as BrokerServerOptions;
  const projection = new FleetProjection(options);
  const initial = await projection.read();
  expect(initial.reply).toMatchObject({ kind: "full", snapshot: { threads: [{ record: { id, latestPreview: "old history" } }] } });
  expect(initial.retained.snapshot.threads[0]!.record.launchRecord).toBeUndefined();
  expect(await projection.read(initial.retained.version, initial.retained)).toMatchObject({ reply: { kind: "unchanged" } });
  sessions = [];
  const changed = await projection.read(initial.retained.version, initial.retained);
  expect(changed.retained.snapshot.threads).toEqual([]);
  expect((await projection.read("unknown", changed.retained)).reply.kind).toBe("full");
  expect((await new FleetProjection(options).read(initial.retained.version)).reply.kind).toBe("full");
});

it("includes truth for workers and orchestrators and sends bounded truth-only deltas", async () => {
  const sessions = Array.from({ length: 8 }, (_, index) => ({ id: `session-${index}`,
    kind: index === 0 ? "orchestrator" : "worker", executionState: "active", latestPreview: "unchanged" })) as SessionRecord[];
  let current = truth("idle");
  const projection = new FleetProjection({ registry: {
    list: () => sessions, workerTruth: (id: string) => id === sessions[0]!.id ? current : truth("working"),
  } } as unknown as BrokerServerOptions);
  const first = await projection.read();
  expect(first.retained.snapshot.threads[0]!.workerTruth).toEqual(current);
  expect(first.retained.snapshot.threads[1]!.workerTruth?.state).toBe("working");
  // The provider's input boundary changes without any persisted record field changing.
  current = { ...current, state: "blocked-composer", composerOccupied: true, pendingInstructions: 1,
    detail: "Rendered instruction remains unsent" };
  const second = await projection.read(first.retained.version, first.retained);
  expect(second.reply).toMatchObject({ kind: "delta", baseVersion: first.retained.version,
    upsert: [{ record: sessions[0], workerTruth: current }], remove: [] });
  expect(second.retained.version).not.toBe(first.retained.version);
  expect(await projection.read(second.retained.version, second.retained)).toMatchObject({ reply: { kind: "unchanged" } });
  // A retained generation must be immune to subsequent in-memory observation mutations.
  current.pendingInstructions = 2;
  expect(second.retained.snapshot.threads[0]!.workerTruth?.pendingInstructions).toBe(1);
  expect((await projection.read(second.retained.version, second.retained)).reply.kind).toBe("delta");
});

it("coalesces updates for every session kind on the wire, retains full details and resyncs new connections", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cyberdeck-fleet-wire-"));
  const id = "11111111-1111-4111-8111-111111111111";
  const record = { id, kind: "orchestrator", executionState: "exited", latestPreview: "retained history",
    launchRecord: { args: ["full launch detail"] } } as unknown as SessionRecord;
  let currentTruth = truth("exited");
  const listeners = new Set<(sessionId: string) => void>();
  const server = new BrokerServer({ socketPath: join(directory, "broker.sock"), registry: {
    list: () => [record], get: () => record, workerTruth: () => currentTruth, launchRecord: () => record.launchRecord, releaseClient: async () => {},
    onSessionUpdate: (listener: (sessionId: string) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  } } as unknown as BrokerServerOptions);
  let client: RpcClient | undefined, reconnected: RpcClient | undefined;
  try {
    await server.listen(); client = await RpcClient.connect(join(directory, "broker.sock"));
    const initial = await client.request<FleetProjectionReply>("fleet.snapshot", {});
    expect(initial.kind).toBe("full");
    expect(await client.request("session.list", {})).toMatchObject([{ launchRecord: record.launchRecord }]);
    expect(await client.request("session.launchRecord", { sessionId: id })).toMatchObject({ launchRecord: record.launchRecord });
    await client.request("fleet.subscribe", {});
    let invalidations = 0;
    const received = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Missing Fleet invalidation")), 3000);
      client!.onFrame((frame) => {
        if (frame.type === "fleet-invalidated") { invalidations++; clearTimeout(timeout); resolve(); }
      });
    });
    currentTruth = truth("blocked-composer");
    for (let index = 0; index < 1000; index++) for (const listener of listeners) listener(id);
    await received;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(invalidations).toBe(1);
    const updated = await client.request<FleetProjectionReply>("fleet.snapshot", { version: initial.version });
    expect(updated.version).not.toBe(initial.version);
    expect(updated).toMatchObject({ kind: "full", snapshot: { threads: [{
      record: { id, latestPreview: record.latestPreview }, workerTruth: currentTruth,
    }] } });
    reconnected = await RpcClient.connect(join(directory, "broker.sock"));
    expect((await reconnected.request<FleetProjectionReply>("fleet.snapshot", { version: updated.version })).kind).toBe("full");
    await client.request("fleet.unsubscribe", {});
    expect(listeners.size).toBe(0);
  } finally { client?.close(); reconnected?.close(); await server.close(); await rm(directory, { recursive: true, force: true }); }
});
