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
  let closed = false;
  return {
    fleetProjection: true,
    request: vi.fn(async (method: string): Promise<unknown> => {
      if (closed) throw Object.assign(new Error("Broker connection is closed"), { code: "BROKER_DISCONNECTED" });
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
    disconnect: () => { closed = true; for (const fn of closes) fn(); },
    disconnectSilently: () => { closed = true; },
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

it("reconnects when closure occurs after the first snapshot but before start installs subscription listeners", async () => {
  vi.useFakeTimers();
  const first = transport(), replacement = transport("replacement:1"), reconnect = vi.fn(async () => replacement as never);
  const closed = vi.fn(), feed = new FleetSnapshotFeed(first as never);
  try {
    await feed.refresh();
    first.disconnect();
    feed.start(vi.fn(), { reconnect, closed });
    await vi.advanceTimersByTimeAsync(200);
    expect(reconnect).toHaveBeenCalledOnce();
    expect(closed).not.toHaveBeenCalled();
    expect(replacement.request).toHaveBeenCalledWith("fleet.snapshot", { version: undefined });
    expect(feed.error).toBeUndefined();
  } finally { feed.dispose(); }
});

it.each(["collection", "subscription"])("reconnects on BROKER_DISCONNECTED from %s even without a close notification", async (source) => {
  vi.useFakeTimers();
  const first = transport(), replacement = transport("replacement:1"), reconnect = vi.fn(async () => replacement as never);
  const feed = new FleetSnapshotFeed(first as never);
  try {
    await feed.refresh();
    if (source === "subscription") first.disconnectSilently();
    feed.start(vi.fn(), { reconnect });
    await vi.advanceTimersByTimeAsync(200);
    if (source === "collection") {
      first.disconnectSilently();
      await expect(feed.refresh()).rejects.toMatchObject({ code: "BROKER_DISCONNECTED" });
      await vi.advanceTimersByTimeAsync(200);
    }
    expect(reconnect).toHaveBeenCalledOnce();
    expect(replacement.request).toHaveBeenCalledWith("fleet.snapshot", { version: undefined });
    expect(feed.error).toBeUndefined();
  } finally { feed.dispose(); }
});

it("reconnects runFleet when the broker closes while initial preferences are loading", async () => {
  vi.useFakeTimers();
  class Input extends EventEmitter { isTTY = true; setRawMode() {} }
  const first = transport(), replacement = transport("replacement:1"), signals = new EventEmitter();
  const request = first.request.getMockImplementation()!;
  first.request.mockImplementation(async (method) => {
    if (method === "fleet.preferences") { first.disconnect(); return {}; }
    return request(method);
  });
  const reconnectTransport = vi.fn(async () => replacement as never);
  const running = runFleet(first as never, new Input(), { isTTY: false, columns: 86, rows: 24, write: vi.fn() }, signals, { reconnectTransport });
  try {
    await vi.advanceTimersByTimeAsync(200);
    expect(reconnectTransport).toHaveBeenCalledOnce();
    expect(replacement.request).toHaveBeenCalledWith("fleet.snapshot", { version: undefined });
  } finally { signals.emit("SIGTERM"); await running; }
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

it("applies insertion, removal, and explicit order deltas without leaving a version-matched stale row", async () => {
  const client = transport(), feed = new FleetSnapshotFeed(client as never);
  await feed.refresh();
  const second = { ...record, id: "22222222-2222-4222-8222-222222222222" };
  client.request.mockImplementationOnce(async () => ({ kind: "delta", baseVersion: "epoch:1", version: "epoch:2",
    upsert: [{ record: second }], remove: [], order: [second.id, record.id] }));
  await feed.refresh();
  expect(feed.snapshot.threads.map((thread) => thread.record.id)).toEqual([second.id, record.id]);
  client.request.mockImplementationOnce(async () => ({ kind: "delta", baseVersion: "epoch:2", version: "epoch:3",
    upsert: [], remove: [record.id], order: [second.id] }));
  await feed.refresh();
  expect(feed.snapshot.threads.map((thread) => thread.record.id)).toEqual([second.id]);
  feed.dispose();
});

it("fences a refresh response started before an action and fully resyncs the action snapshot", async () => {
  vi.useFakeTimers();
  const client = transport(), feed = new FleetSnapshotFeed(client as never);
  await feed.refresh(); feed.start(vi.fn()); await vi.advanceTimersByTimeAsync(200);
  let finish: (value: unknown) => void = () => {};
  client.request.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const slow = feed.refresh(), latest = { threads: [{ record: { ...record, name: "action result" } }] };
  feed.resync(latest);
  finish({ kind: "full", version: "epoch:old", snapshot: { threads: [{ record }] } });
  await slow;
  expect(feed.snapshot).toEqual(latest);
  client.request.mockImplementationOnce(async () => ({ kind: "full", version: "epoch:new", snapshot: latest }));
  await vi.advanceTimersByTimeAsync(100);
  expect(client.request).toHaveBeenLastCalledWith("fleet.snapshot", { version: undefined });
  expect(feed.snapshot).toEqual(latest);
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
