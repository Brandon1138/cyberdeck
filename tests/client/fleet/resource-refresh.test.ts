import { expect, it } from "vitest";
import { FleetFrameCache, fleetFrameLayout } from "../../../src/client/fleet/runtime-frame.js";
import { renderFleet } from "../../../src/client/fleet/render-frame.js";
import { createFleetState } from "../../../src/client/fleet/transport.js";
import type { FleetSnapshot } from "../../../src/client/fleet/state.js";
import type { ResolvedFleetRenderOptions } from "../../../src/client/fleet/runtime-options.js";

const now = Date.parse("2026-09-16T10:00:00.000Z");
const snapshot: FleetSnapshot = { threads: Array.from({ length: 64 }, (_, i) => ({ record: {
  id: `session-${i}`, provider: "codex", cwd: "/workspace", detached: true, sandbox: "read-only",
  createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), executionState: "active",
  attachmentState: "detached", pid: i + 1, exitCode: null, childIds: [],
} })) };
const options: ResolvedFleetRenderOptions = { now, width: 120, height: 32, color: false,
  home: "/home/fixture", pullRequests: new Map(), background: undefined };

it("reuses an identical 64-row frame across fresh snapshots without delaying age boundaries", () => {
  const cache = new FleetFrameCache(), state = createFleetState(snapshot);
  const first = cache.render(snapshot, state, options);
  const second = cache.render(structuredClone(snapshot), structuredClone(state), { ...options, now: now + 10 });
  expect(second).toBe(first);
  for (const elapsed of [1_000, 60_000, 3_600_000]) {
    const timed = { ...options, now: now + elapsed };
    const result = cache.render(snapshot, state, timed);
    expect(result.body).toBe(renderFleet(snapshot, state, timed));
    expect(result.layout).toEqual(fleetFrameLayout(snapshot, state, timed));
  }
});

it("invalidates on state, catalog, viewport, appearance, PR status and expired confirmations", () => {
  const cache = new FleetFrameCache(), state = createFleetState(snapshot);
  const first = cache.render(snapshot, state, options);
  expect(cache.render(snapshot, { ...state, draft: "typed" }, options)).not.toBe(first);
  const changed = structuredClone(snapshot);
  changed.threads[0]!.record.name = "new title";
  expect(cache.render(changed, state, options).body).toBe(renderFleet(changed, state, options));
  for (const modified of [{ ...options, width: 72 }, { ...options, height: 15 }, { ...options, color: true }]) {
    expect(cache.render(snapshot, state, modified).body).toBe(renderFleet(snapshot, state, modified));
  }
  const confirming = { ...state, quitConfirmation: { expiresAt: now + 50 }, notice: "confirm" };
  cache.render(snapshot, confirming, options);
  expect(cache.render(snapshot, confirming, { ...options, now: now + 51 }).body)
    .toBe(renderFleet(snapshot, confirming, { ...options, now: now + 51 }));
  const without = cache.render(snapshot, state, options);
  const withPR = { ...options, pullRequests: new Map([["session-0", { state: "open" as const, number: 12, url: "https://example.test/12", title: "fixture" }]]) };
  expect(cache.render(snapshot, state, withPR)).not.toBe(without);
  expect(cache.render(snapshot, state, withPR).body).toBe(renderFleet(snapshot, state, withPR));
});
