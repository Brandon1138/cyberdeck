import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { AgentActivitySchema, type ActivityInput, type AgentActivity } from "../../../src/domain/agent-activity.js";
import type { ResourceSummary } from "../../../src/domain/resource-summary.js";
import type { AgentActivityPort } from "../../../src/orchestration/agent-activity-port.js";
import { AgentActivityStore } from "../../../src/persistence/agent-activity-store.js";
import { BoundedExportQueue } from "../../../src/observability/bounded-export-queue.js";
import { ResourceActivityBridge, type ResourceActivityBridgeOptions } from "../../../src/runtime/resources/resource-activity-bridge.js";

const roots: string[] = [];
const stores: AgentActivityStore[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(stores.splice(0).map(store => store.close())); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const sample: ResourceSummary = { observedBytes: null, reservedBytes: 100, limitBytes: 200, peakBytes: null, uncertainBytes: 20,
  active: 1, parked: 2, queued: 3, queueDelayMs: 4, eventLoopP99Ms: 5, sampleDurationMs: 6, enforcement: "operational", reason: "healthy" };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "resource-activity-bridge-")); roots.push(root);
  const events: AgentActivity[] = [];
  const activity: AgentActivityPort = { append: vi.fn(async (input: ActivityInput) => {
    const existing = events.find(event => event.sourceKey === input.sourceKey);
    if (existing) return existing;
    const event = AgentActivitySchema.parse({ ...input, sequence: events.length + 1 }); events.push(event); return event;
  }), pin: vi.fn(async () => undefined), read: async () => events, health: () => ({ degraded: false, dropped: 0, retained: events.length }) };
  const current = { summary: { ...sample }, now: Date.parse("2026-09-16T10:00:00.000Z"), owner: true };
  const options: ResourceActivityBridgeOptions = { path: join(root, "bridge", "resource.json"), installationId: randomUUID(), brokerId: randomUUID(), activity,
    readSummary: vi.fn(() => current.summary), now: () => current.now,
    assertOwner: vi.fn(() => { if (!current.owner) throw new Error("stale owner"); }) };
  return { root, events, activity, current, options, bridge: await ResourceActivityBridge.open(options) };
}
it("samples at most once per minute with null metrics, private bounded state and no per-poll fsync", async () => {
  const f = await fixture();
  const probe = await open(join(f.root, "probe"), "w");
  const sync = vi.spyOn(Object.getPrototypeOf(probe), "sync"); await probe.close();
  await f.bridge.tick();
  expect(f.events).toHaveLength(1);
  expect(f.events[0]).toMatchObject({ kind: "resource.summary", resource: { observedBytes: null, peakBytes: null }, runId: f.options.installationId,
    workerId: f.options.brokerId, sessionId: f.options.brokerId });
  expect(sync.mock.calls.length).toBeGreaterThan(0);
  sync.mockClear();
  const before = await stat(f.options.path);
  for (let i = 0; i < 30; i++) { f.current.now += 1_000; await f.bridge.tick(); }
  expect(f.events).toHaveLength(1); expect(sync).not.toHaveBeenCalled();
  expect((await stat(f.options.path)).ino).toBe(before.ino);
  expect((await stat(f.options.path)).mode & 0o777).toBe(0o600);
  expect((await stat(dirname(f.options.path))).mode & 0o777).toBe(0o700);
  expect((await stat(f.options.path)).size).toBeLessThan(16 * 1024);
  f.current.now += 30_000; await f.bridge.tick(); expect(f.events).toHaveLength(2);
  expect(await readdir(dirname(f.options.path))).toEqual(["resource.json"]);
});
it("emits only incident transitions and one recovery, durably across restart", async () => {
  const f = await fixture(); f.current.summary.reason = "host-pressure";
  await f.bridge.tick();
  for (let i = 0; i < 4; i++) await f.bridge.tick();
  expect(f.events.map(event => event.kind)).toEqual(["resource.summary", "resource.incident"]);
  const restarted = await ResourceActivityBridge.open(f.options); await restarted.tick();
  expect(f.events).toHaveLength(2);
  f.current.summary.reason = "budget-breach"; await restarted.tick();
  f.current.summary.reason = "healthy"; await restarted.tick(); await restarted.tick();
  expect(f.events.filter(event => event.kind === "resource.incident").map(event => [event.resource?.reason, event.outcome]))
    .toEqual([["host-pressure", "observed"], ["budget-breach", "observed"], ["recovered", "succeeded"]]);
  expect(JSON.parse(await readFile(f.options.path, "utf8")).state).toMatchObject({ incidentState: null, pending: null });
});
it.each(["before", "after"])("replays exactly the durable intent when capture fails %s append", async when => {
  const f = await fixture(); f.current.summary.reason = "host-pressure";
  const store = await AgentActivityStore.open(join(f.root, "activity")); stores.push(store);
  let failed = false;
  const attempts: ActivityInput[] = [];
  f.options.activity = { ...f.activity, pin: (id, pinned) => store.pin(id, pinned), append: async input => {
    attempts.push(structuredClone(input));
    const pending = JSON.parse(await readFile(f.options.path, "utf8")).state.pending;
    expect(pending.events[0].eventId).toBe(input.eventId);
    if (when === "after" || failed) await store.append(input);
    if (!failed) { failed = true; throw new Error("capture crashed"); }
    return store.append(input);
  } };
  const bridge = await ResourceActivityBridge.open(f.options); await bridge.tick();
  expect(bridge.health()).toMatchObject({ degraded: true, failure: "capture-failed", pending: 2 });
  const intent = JSON.parse(await readFile(f.options.path, "utf8")).state.pending.events;
  const restarted = await ResourceActivityBridge.open({ ...f.options, activity: store, readSummary: () => { throw new Error("sampler failed too"); } });
  f.current.now += 120_000; await restarted.tick();
  const actual = await store.read(f.options.installationId, 0, 100);
  expect(actual.map(({ sequence: _sequence, ...event }) => event)).toEqual(intent);
  expect(restarted.health()).toMatchObject({ degraded: false, pending: 0, lastSummaryAt: f.current.now });
  const healthy = await ResourceActivityBridge.open({ ...f.options, activity: store }); await healthy.tick();
  expect(await store.read(f.options.installationId, 0, 100)).toHaveLength(2);
});
it("recovers a complete staging transaction left before rename without inventing new event identities", async () => {
  const f = await fixture(); let checks = 0;
  f.options.assertOwner = () => { if (++checks === 4) throw new Error("crashed before rename"); };
  const bridge = await ResourceActivityBridge.open(f.options); await bridge.tick();
  expect(bridge.health().failure).toBe("ownership-lost");
  const staging = JSON.parse(await readFile(f.options.path + ".pending", "utf8"));
  expect(f.events).toHaveLength(0);
  const recovered = await ResourceActivityBridge.open({ ...f.options, assertOwner: () => undefined }); await recovered.tick();
  expect(f.events[0]?.eventId).toBe(staging.state.pending.events[0].eventId);
  expect(recovered.health().degraded).toBe(false);
  expect(await readdir(dirname(f.options.path))).toEqual(["resource.json"]);
});
it("retains pending after ownership loss following successful append and refuses later stale writes", async () => {
  const f = await fixture();
  const original = f.activity.append;
  f.options.activity = { ...f.activity, append: async input => { const event = await original(input); f.current.owner = false; return event; } };
  const bridge = await ResourceActivityBridge.open(f.options); await bridge.tick();
  expect(f.events).toHaveLength(1);
  expect(bridge.health()).toMatchObject({ failure: "ownership-lost", pending: 1 });
  const before = await readFile(f.options.path, "utf8"); await bridge.tick();
  expect(await readFile(f.options.path, "utf8")).toBe(before);
  f.current.owner = true;
  const recovered = await ResourceActivityBridge.open({ ...f.options, activity: f.activity }); await recovered.tick();
  expect(f.events).toHaveLength(1); expect(recovered.health().pending).toBe(0);
});
it("coalesces overlapping ticks and closes only after their existing work finishes", async () => {
  const f = await fixture(); let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const original = f.activity.append;
  f.options.activity = { ...f.activity, append: async input => { entered(); await gate; return original(input); } };
  const bridge = await ResourceActivityBridge.open(f.options);
  const first = bridge.tick(), second = bridge.tick(); expect(first).toBe(second);
  await started; let closed = false;
  const closing = bridge.close().then(() => { closed = true; }); await Promise.resolve(); expect(closed).toBe(false);
  release(); await Promise.all([first, second, closing]);
  expect(f.options.readSummary).toHaveBeenCalledTimes(1); expect(f.events).toHaveLength(1);
  f.current.now += 60_000; await bridge.tick(); expect(f.events).toHaveLength(1);
});
it.each([{ reason: "secret-token" }, { path: "/private/secret" }, { observedBytes: NaN }, { reservedBytes: Infinity }, { active: -1 }])("rejects malicious summary %j before persistence or capture", async extra => {
  const f = await fixture(); f.current.summary = { ...sample, ...extra } as ResourceSummary;
  await f.bridge.tick(); expect(f.events).toHaveLength(0);
  expect(f.bridge.health()).toMatchObject({ failure: "summary-invalid", pending: 0 });
  expect(await readdir(dirname(f.options.path))).toEqual([]);
  expect(JSON.stringify(f.bridge.health())).not.toContain("secret");
  f.current.summary = { ...sample }; await f.bridge.tick(); expect(f.bridge.health().degraded).toBe(false);
});
it.each(["truncated", "oversized", "checksum", "staging"])("leaves corrupt %s state intact and exposes blocked health", async fault => {
  const f = await fixture(); await f.bridge.tick();
  const path = fault === "staging" ? f.options.path + ".pending" : f.options.path;
  const bad = fault === "oversized" ? "x".repeat(16 * 1024 + 1) : fault === "checksum" ? JSON.stringify({ ...JSON.parse(await readFile(f.options.path, "utf8")), checksum: "0".repeat(64) }) : "{";
  await writeFile(path, bad, { mode: 0o600 });
  const recovered = await ResourceActivityBridge.open(f.options); await recovered.tick();
  expect(recovered.health()).toMatchObject({ degraded: true, failure: "corrupt-state" });
  expect(await readFile(path, "utf8")).toBe(bad); expect(f.events).toHaveLength(1);
});
it("latches storage failure without allowing capture, and bounds the failed staging path", async () => {
  const f = await fixture(); await mkdir(f.options.path + ".pending");
  await f.bridge.tick(); await f.bridge.tick();
  expect(f.bridge.health()).toMatchObject({ failure: "storage-failed", pending: 0 });
  expect(f.events).toHaveLength(0); expect(await readdir(dirname(f.options.path))).toEqual(["resource.json.pending"]);
});
it("keeps downstream transport failure independent from durable local resource capture", async () => {
  const f = await fixture(); const queue = new BoundedExportQueue(async () => { throw new Error("sink offline"); });
  try {
    await f.bridge.tick(); queue.enqueue(JSON.stringify(f.events[0])); await queue.pump();
    expect(queue.transportHealth().transportFailed).toBe(1);
    f.current.summary.reason = "host-pressure"; await f.bridge.tick();
    expect(f.events).toHaveLength(2); expect(f.bridge.health()).toMatchObject({ degraded: false, pending: 0 });
    expect(f.current.summary.reason).toBe("host-pressure");
  } finally { queue.close(); }
});

it("keeps pending events pinned through retention and restart, then releases the pin after commit", async () => {
  const f = await fixture(); f.current.summary.reason = "host-pressure";
  const retention = { maxBytes: 1024 * 1024, maxAgeMs: 10, now: () => f.current.now };
  let store = await AgentActivityStore.open(join(f.root, "activity"), retention); stores.push(store);
  const bridge = await ResourceActivityBridge.open({ ...f.options, activity: { ...f.activity,
    pin: (id, pinned) => store.pin(id, pinned), append: async input => { await store.append(input); throw new Error("crash after append"); } } });
  await bridge.tick(); expect(store.health().pinned).toBe(1);
  const [first] = await store.read(f.options.installationId, 0, 100);
  f.current.now += 1_000;
  await store.append({ ...first!, eventId: randomUUID(), sourceKey: randomUUID(), runId: randomUUID(), observedAt: new Date(f.current.now).toISOString() });
  expect((await store.read(f.options.installationId, 0, 100))[0]?.eventId).toBe(first?.eventId);
  await store.close(); stores.pop();
  store = await AgentActivityStore.open(join(f.root, "activity"), retention); stores.push(store);
  expect(store.health().pinned).toBe(1);
  const recovered = await ResourceActivityBridge.open({ ...f.options, activity: store }); await recovered.tick();
  const events = await store.read(f.options.installationId, 0, 100);
  expect(events).toHaveLength(2); expect(events[0]?.eventId).toBe(first?.eventId);
  expect(store.health().pinned).toBe(0); expect(recovered.health()).toMatchObject({ degraded: false, pending: 0, pinned: false });
});
it("recovers the pin obligation after commit before unpin without appending an event again", async () => {
  const f = await fixture();
  const pin = vi.fn(async (_id: string, pinned: boolean) => { if (!pinned) throw new Error("unpin unavailable"); });
  const bridge = await ResourceActivityBridge.open({ ...f.options, activity: { ...f.activity, pin } });
  await bridge.tick();
  expect(bridge.health()).toMatchObject({ pending: 0, pinned: true, failure: "capture-failed" });
  const prior = JSON.parse(await readFile(f.options.path, "utf8")).state;
  expect(prior).toMatchObject({ pending: null, pinned: true, lastSummaryAt: f.current.now });
  const recovered = await ResourceActivityBridge.open(f.options); await recovered.tick();
  expect(f.events).toHaveLength(1); expect(f.activity.pin).toHaveBeenCalledWith(f.options.installationId, false);
  expect(recovered.health()).toMatchObject({ degraded: false, pending: 0, pinned: false });
});
it("reports missing retention capability without appending or losing the durable intent", async () => {
  const f = await fixture(); const { pin: _pin, ...unavailable } = f.activity;
  const bridge = await ResourceActivityBridge.open({ ...f.options, activity: unavailable }); await bridge.tick();
  expect(f.events).toHaveLength(0); expect(bridge.health()).toMatchObject({ failure: "capture-failed", pending: 1, pinned: true });
});

it("does not fsync or rewrite a confirmed pin on repeated failed capture polls", async () => {
  const f = await fixture();
  f.options.activity = { ...f.activity, append: async () => { throw new Error("capture unavailable"); } };
  const bridge = await ResourceActivityBridge.open(f.options); await bridge.tick();
  const before = await stat(f.options.path);
  const pin = vi.mocked(f.activity.pin!); expect(pin).toHaveBeenCalledTimes(1);
  const probe = await open(join(f.root, "probe"), "w");
  const sync = vi.spyOn(Object.getPrototypeOf(probe), "sync"); await probe.close();
  for (let i = 0; i < 5; i++) await bridge.tick();
  expect(pin).toHaveBeenCalledTimes(1); expect(sync).not.toHaveBeenCalled();
  expect((await stat(f.options.path)).ino).toBe(before.ino);
  expect(bridge.health()).toMatchObject({ pending: 1, failure: "capture-failed", pinned: true });
});
it("contains sampler exceptions without altering admission inputs or losing future capture", async () => {
  const f = await fixture(); let failing = true;
  const bridge = await ResourceActivityBridge.open({ ...f.options, readSummary: () => { if (failing) throw new Error("private sampler detail"); return f.current.summary; } });
  await bridge.tick(); expect(bridge.health()).toMatchObject({ failure: "summary-read-failed", pending: 0 });
  expect(f.current.summary).toEqual(sample); expect(f.events).toHaveLength(0);
  failing = false; await bridge.tick(); expect(bridge.health().degraded).toBe(false); expect(f.events).toHaveLength(1);
});
