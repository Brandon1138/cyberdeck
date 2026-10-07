import { expect, it } from "vitest";
import { FleetProjection } from "../../src/broker/fleet-projection.js";
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
