import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { FleetSnapshotFeed } from "../../src/client/fleet/snapshot-feed.js";
import { runFleet } from "../../src/client/fleet/runtime.js";
import type { SessionRecord } from "../../src/domain/session.js";
import type { ServerFrame } from "../../src/broker/protocol/frames.js";

const record = { id: "11111111-1111-4111-8111-111111111111", provider: "claude", cwd: "/repo", detached: true,
  sandbox: "read-only", kind: "worker", createdAt: "2026-10-07T00:00:00.000Z", updatedAt: "2026-10-07T00:00:00.000Z",
  executionState: "active", attachmentState: "detached", pid: 1, exitCode: null, childIds: [] } as SessionRecord;
function transport(version = "epoch:1") {
  const frames = new Set<(frame: ServerFrame) => void>(), closes = new Set<() => void>();
  return {
    fleetProjection: true,
    request: vi.fn(async (method: string): Promise<unknown> => {
      if (method === "fleet.snapshot") return { kind: "full", version, snapshot: { threads: [{ record }] } };
      if (method === "fleet.preferences" || method === "fleet.folderDispositions") return {};
      if (method === "fleet.nvimLayout") return false;
      if (method === "fleet.subscribe" || method === "fleet.unsubscribe") return {};
      throw Object.assign(new Error(method), { code: "METHOD_NOT_FOUND" });
    }),
    onFrame: (fn: (frame: ServerFrame) => void) => { frames.add(fn); return () => { frames.delete(fn); }; },
    onClose: (fn: () => void) => { closes.add(fn); return () => { closes.delete(fn); }; },
    sendFrame: vi.fn(), close: vi.fn(),
    invalidate: () => { for (const fn of frames) fn({ type: "fleet-invalidated" }); },
    disconnect: () => { for (const fn of closes) fn(); },
  };
}
afterEach(() => { vi.useRealTimers(); });

it("coalesces bursts, resyncs version gaps and reconnects with a full snapshot", async () => {
  vi.useFakeTimers();
  const first = transport(), replacement = transport("new-epoch:1");
  const feed = new FleetSnapshotFeed(first as never), connected = vi.fn();
  await feed.refresh();
  feed.start(vi.fn(), { reconnect: async () => replacement as never, connected });
  await vi.advanceTimersByTimeAsync(200);
  first.request.mockClear();
  for (let index = 0; index < 1000; index++) first.invalidate();
  await vi.advanceTimersByTimeAsync(100);
  expect(first.request.mock.calls.filter(([method]) => method === "fleet.snapshot")).toHaveLength(1);
  first.request.mockImplementationOnce(async () => ({ kind: "delta", baseVersion: "gap", version: "epoch:2", upsert: [], remove: [] }));
  await feed.refresh();
  await vi.advanceTimersByTimeAsync(100);
  expect(first.request).toHaveBeenLastCalledWith("fleet.snapshot", { version: undefined });
  first.disconnect();
  expect(feed.error).toContain("cached Fleet");
  await vi.advanceTimersByTimeAsync(200);
  expect(connected).toHaveBeenCalledWith(replacement);
  expect(replacement.request).toHaveBeenCalledWith("fleet.snapshot", { version: undefined });
  expect(feed.error).toBeUndefined();
  feed.dispose();
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps one request in flight and one follow-up when updates arrive during a slow refresh", async () => {
  vi.useFakeTimers();
  const client = transport(), feed = new FleetSnapshotFeed(client as never);
  await feed.refresh(); feed.start(vi.fn()); await vi.advanceTimersByTimeAsync(200);
  client.request.mockClear();
  let finish: (value: unknown) => void = () => {};
  client.request.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const slow = feed.refresh();
  for (let index = 0; index < 1000; index++) client.invalidate();
  await vi.advanceTimersByTimeAsync(1000);
  expect(client.request.mock.calls.filter(([method]) => method === "fleet.snapshot")).toHaveLength(1);
  finish({ kind: "unchanged", version: "epoch:1" }); await slow;
  await vi.advanceTimersByTimeAsync(100);
  expect(client.request.mock.calls.filter(([method]) => method === "fleet.snapshot")).toHaveLength(2);
  feed.dispose();
});

it("renders keyboard and resize wakeups from cached data and periodically resyncs missed events", async () => {
  vi.useFakeTimers();
  class Input extends EventEmitter { isTTY = true; setRawMode() {} }
  const client = transport(), input = new Input(), signals = new EventEmitter();
  const output = { isTTY: false, columns: 86, rows: 24, write: vi.fn() };
  const running = runFleet(client as never, input, output, signals);
  await vi.advanceTimersByTimeAsync(200);
  const count = () => client.request.mock.calls.filter(([method]) => method === "fleet.snapshot").length;
  const before = count();
  for (let index = 0; index < 20; index++) { input.emit("data", "漢"); signals.emit("SIGWINCH"); await vi.advanceTimersByTimeAsync(0); }
  expect(count()).toBe(before);
  expect(output.write.mock.calls.some(([value]) => String(value).includes("漢"))).toBe(true);
  await vi.advanceTimersByTimeAsync(2200);
  expect(count()).toBeGreaterThan(before);
  signals.emit("SIGTERM"); await running;
  expect(vi.getTimerCount()).toBe(0);
});
