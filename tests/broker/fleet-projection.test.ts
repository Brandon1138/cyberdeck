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

it("keeps historical rows, filters unmatched projections, omits launch payloads and resyncs unknown versions", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  let sessions = [{ id, executionState: "exited", latestPreview: "old history", launchRecord: { args: ["large launch detail"] } }] as unknown as SessionRecord[];
  const options = {
    registry: { list: () => sessions },
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

it("coalesces updates for every session kind on the wire, retains full details and resyncs new connections", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cyberdeck-fleet-wire-"));
  const id = "11111111-1111-4111-8111-111111111111";
  let record = { id, kind: "orchestrator", executionState: "exited", latestPreview: "retained history",
    launchRecord: { args: ["full launch detail"] } } as unknown as SessionRecord;
  const listeners = new Set<(sessionId: string) => void>();
  const server = new BrokerServer({ socketPath: join(directory, "broker.sock"), registry: {
    list: () => [record], get: () => record, launchRecord: () => record.launchRecord, releaseClient: async () => {},
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
    record = { ...record, latestPreview: "updated orchestrator" };
    for (let index = 0; index < 1000; index++) for (const listener of listeners) listener(id);
    await received;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(invalidations).toBe(1);
    const updated = await client.request<FleetProjectionReply>("fleet.snapshot", { version: initial.version });
    expect(updated.version).not.toBe(initial.version);
    reconnected = await RpcClient.connect(join(directory, "broker.sock"));
    expect((await reconnected.request<FleetProjectionReply>("fleet.snapshot", { version: updated.version })).kind).toBe("full");
    await client.request("fleet.unsubscribe", {});
    expect(listeners.size).toBe(0);
  } finally { client?.close(); reconnected?.close(); await server.close(); await rm(directory, { recursive: true, force: true }); }
});
