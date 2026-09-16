import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { WorkerEventChannel } from "../../src/broker/worker-event-channel.js";
import type { WorkerCoordinationService } from "../../src/broker/worker-coordination.js";
import type { SessionRecord } from "../../src/domain/session.js";

it("counts reports synchronously before queueing, by worker, and clears rejection and failure paths", async () => {
  const first = randomUUID(), second = randomUUID();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const projectEvents = vi.fn(() => { throw new Error("store unavailable"); });
  const channel = new WorkerEventChannel({ projectEvents } as unknown as WorkerCoordinationService,
    { get: () => ({ kind: "worker" }) as SessionRecord },
    { findBySessionId: async () => { await gate; return undefined; } },
    { enqueue: vi.fn() });
  const checkpoint = channel.requestCheckpoint({ actorSessionId: randomUUID(), workerId: first }).catch(error => error);
  const rejected = channel.submit({ workerId: first, kind: "DECISION_REQUEST", summary: "invalid semantics" });
  const failed = channel.submit({ workerId: first, kind: "PROGRESS", summary: "valid but store fails" }).catch(error => error);
  const malformed = channel.submit({ workerId: second, kind: "PROGRESS", summary: "" }).catch(error => error);
  expect(channel.inFlightReports(first)).toBe(2);
  expect(channel.inFlightReports(second)).toBe(1);
  await Promise.resolve(); await Promise.resolve();
  expect(channel.inFlightReports(first)).toBe(2);
  expect(projectEvents).not.toHaveBeenCalled();
  release();
  expect(await checkpoint).toMatchObject({ code: "ACTOR_NOT_AUTHORIZED" });
  expect(await rejected).toMatchObject({ code: "rejected" });
  expect(await failed).toMatchObject({ message: "store unavailable" });
  expect(await malformed).toBeInstanceOf(Error);
  expect(channel.inFlightReports(first)).toBe(0);
  expect(channel.inFlightReports(second)).toBe(0);
});
