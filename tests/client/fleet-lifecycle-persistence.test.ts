import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FleetPreferenceStore } from "../../src/persistence/fleet-preference-store.js";
import { createFleetState, type FleetThread } from "../../src/client/fleet.js";
import { restoreVisitPreferences, isUnreadThread } from "../../src/client/fleet/visit-state.js";
import { acknowledgeLifecycleNotices } from "../../src/client/fleet/lifecycle-state.js";
import { createVisitPreferenceSaver } from "../../src/client/fleet/visit-preferences.js";
import { normalizeState } from "../../src/client/fleet/normalize.js";
import type { FleetVisitPreferences } from "../../src/domain/fleet-preferences.js";
import type { FleetTransport } from "../../src/client/fleet/state.js";
import type { SessionRecord } from "../../src/domain/session.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const at = "2026-10-17T18:00:00.000Z";
function entry(absent = false): FleetThread {
  return { runtimePresence: absent ? "absent" : "present", record: {
    id: "one", name: "One", provider: "codex", cwd: "/repo", generation: 1, pid: absent ? 0 : 42,
    executionState: absent ? "cancelled" : "active", attentionState: absent ? "interrupted" : undefined,
    exitCode: absent ? -1 : null, createdAt: at, updatedAt: at, meaningfulUpdatedAt: at,
    latestPreview: absent ? "A newer assistant reply" : "Existing reply", latestPreviewKind: "assistant",
  } as SessionRecord, workerTruth: { state: absent ? "interrupted" : "idle", terminal: absent,
    canonicalTurns: absent ? 2 : 1, completedTurns: absent ? 2 : 1, pendingInstructions: 0,
    modalOpen: false, composerOccupied: false, detail: "Current observation" } };
}

it("saves the baseline, notices a recovery while Fleet was closed, and durably acknowledges only lifecycle attention", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cyberdeck-fleet-lifecycle-")); directories.push(directory);
  const store = new FleetPreferenceStore(directory);
  const errors: string[] = [];
  const client = { request: async (_method: string, params: unknown) => {
    await store.setVisitPreferences(params as FleetVisitPreferences); return { saved: true };
  } } as FleetTransport;
  const before = { threads: [entry()] }, after = { threads: [entry(true)] };
  const initial = await store.visitPreferences();
  const state = normalizeState(restoreVisitPreferences(createFleetState(before), before, initial, {}), before, Date.parse(at));
  await createVisitPreferenceSaver(client, initial, (error) => errors.push(error))(state);

  const persisted = await new FleetPreferenceStore(directory).visitPreferences();
  expect(persisted.lifecycleInitialized).toBe(true);
  const recovered = normalizeState(restoreVisitPreferences(createFleetState(after), after, persisted, {}), after, Date.parse(at));
  expect(recovered.lifecycleWatermarks?.one?.notice?.kind).toBe("interrupted");
  expect(isUnreadThread(recovered, "one")).toBe(true);
  const saver = createVisitPreferenceSaver(client, persisted, (error) => errors.push(error));
  await saver(recovered);
  expect((await new FleetPreferenceStore(directory).visitPreferences()).lifecycle?.one?.notice?.generation).toBe(1);
  await saver(acknowledgeLifecycleNotices(recovered, { one: 1 }));
  const acknowledged = await new FleetPreferenceStore(directory).visitPreferences();
  const restored = restoreVisitPreferences(createFleetState(after), after, acknowledged, {});
  expect(restored.lifecycleWatermarks?.one?.notice).toBeUndefined();
  expect(isUnreadThread(restored, "one")).toBe(true);
  expect(after.threads[0]!.workerTruth!.state).toBe("interrupted");
  expect(errors).toEqual([]);
});

it("does not claim durable lifecycle support from an older broker", async () => {
  const requests: FleetVisitPreferences[] = [];
  const initial = { replies: {} };
  const client = { request: async (_method: string, params: unknown) => { requests.push(params as FleetVisitPreferences); return {}; } } as FleetTransport;
  const before = { threads: [entry()] }, after = { threads: [entry(true)] };
  const state = normalizeState(createFleetState(before), after, Date.parse(at));
  expect(state.lifecycleWatermarks?.one?.notice).toBeDefined();
  await createVisitPreferenceSaver(client, initial, () => {})(state);
  expect(requests).toHaveLength(1);
  expect(requests[0]!.lifecycle).toBeUndefined();
  expect(requests[0]!.lifecycleInitialized).toBeUndefined();
});

it("retries the same pending notice save through the replacement transport after reconnect", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cyberdeck-fleet-lifecycle-")); directories.push(directory);
  const store = new FleetPreferenceStore(directory), errors: string[] = [];
  let attempts = 0;
  let client = { request: async () => { attempts++; throw new Error("Broker disconnected"); } } as FleetTransport;
  const before = { threads: [entry()] }, after = { threads: [entry(true)] };
  const state = normalizeState(createFleetState(before), after, Date.parse(at));
  const saver = createVisitPreferenceSaver(() => client, await store.visitPreferences(), (message) => errors.push(message));
  await saver(state); await saver(state);
  expect(attempts).toBe(1);
  client = { request: async (_method: string, params: unknown) => {
    await store.setVisitPreferences(params as FleetVisitPreferences); return {};
  } } as FleetTransport;
  await saver(state);
  expect((await new FleetPreferenceStore(directory).visitPreferences()).lifecycle?.one?.notice?.kind).toBe("interrupted");
  expect(errors).toHaveLength(1);
});

it("does not let a racing first-use baseline acknowledge another client's fresh notice", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cyberdeck-fleet-lifecycle-")); directories.push(directory);
  const store = new FleetPreferenceStore(directory);
  await store.setVisitPreferences({ replies: {}, lifecycleInitialized: true, lifecycle: {
    one: { generation: 1, acknowledgedGeneration: 0, notice: { generation: 1, kind: "interrupted", occurredAt: at } },
  } });
  await store.setVisitPreferences({ replies: {}, lifecycleInitialized: true, lifecycle: {
    one: { generation: 1, acknowledgedGeneration: 0, baselineGeneration: 1 },
  } });
  expect((await store.visitPreferences()).lifecycle?.one?.notice?.generation).toBe(1);
});
