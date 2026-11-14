import { expect, it, vi } from "vitest";
import { createFleetState } from "../../src/client/fleet/transport.js";
import { normalizeState } from "../../src/client/fleet/normalize.js";
import { transitionFleet } from "../../src/client/fleet/transition.js";
import { strigoiStatus, strigoiTransition } from "../../src/client/fleet/strigoi.js";
import { executeFleetAction, type ExecuteFleetActionContext } from "../../src/client/fleet/runtime-actions.js";
import type { FleetSnapshot, FleetThread } from "../../src/client/fleet/state.js";
const thread = (id: string, canonical = true): FleetThread => ({
  record: { id, kind: "orchestrator", name: `Strigoi #${id}`, provider: "codex", cwd: "/repo", sandbox: "read-only", detached: true,
    generation: 1, createdAt: "2026-11-14T10:00:00.000Z", updatedAt: "2026-11-14T10:00:00.000Z", childIds: [], pid: 1,
    executionState: canonical ? "active" : "exited", exitCode: canonical ? null : 0, attachmentState: "detached", orchestratorScope: "fleet" },
  runtimePresence: canonical ? "present" : "absent",
  strigoi: { canonical, incarnation: Number(id), desired: "enabled", readiness: "ready", adoption: "acknowledged", continuationHolds: [] },
});
const snapshot: FleetSnapshot = { threads: [thread("1")] };
it("dispatches /strigoi through existing slash command semantics, without opening native control", () => {
  const state = createFleetState(snapshot, "/repo");
  for (const operation of ["status", "renew", "suspend", "resume"]) {
    const transition = transitionFleet({ ...state, draft: `/strigoi ${operation}` }, snapshot, "enter");
    expect(transition.action).toMatchObject({ type: "strigoi", operation });
  }
  expect(strigoiTransition(state, snapshot, "/strigoi enable")?.state.notice).toContain("Usage");
  expect(strigoiTransition(state, snapshot, "/alfred")).toBeUndefined();
});
it("resident composer uses logical delivery and preserves ambiguous retry identity", async () => {
  const state = createFleetState(snapshot, "/repo");
  const transition = transitionFleet({ ...state, draft: "Keep going" }, snapshot, "enter");
  expect(transition.action).toMatchObject({ type: "strigoi-submit", message: "Keep going" });
  expect(transition.action).not.toHaveProperty("sessionId");
  const request = vi.fn(async () => { throw new Error("lost response"); });
  const result = await executeFleetAction({ client: { request }, action: transition.action, state: transition.state, snapshot,
    setShellInterrupt: () => {}, nvimLayoutHookInstalled: false } as unknown as ExecuteFleetActionContext);
  expect(result.state.draft).toBe("Keep going");
  const retry = transitionFleet(result.state, snapshot, "enter");
  expect(retry.action).toEqual(transition.action);
  expect(request).toHaveBeenCalledWith("strigoi.submit", expect.objectContaining({ message: "Keep going" }));
});
it("logical focus follows the canonical row but explicit history and stop intent remain pinned", () => {
  const state = normalizeState(createFleetState(snapshot, "/repo"), snapshot, Date.now());
  const next = { threads: [thread("1", false), thread("2")] };
  expect(normalizeState(state, next, Date.now()).selectedSessionId).toBe("2");
  expect(normalizeState({ ...state, listView: "history" }, next, Date.now()).selectedSessionId).toBe("1");
  expect(normalizeState({ ...state, stopAcknowledgement: { sessionId: "1" } }, next, Date.now()).selectedSessionId).toBe("1");
  expect(strigoiTransition({ ...state, selectedSessionId: "1" }, next, "continue")).toBeUndefined();
});
it("distinguishes a continuation limitation from a blocking hold, with original IDs", () => {
  const view = { ...thread("1").strigoi!, continuationHolds: [{ code: "workflow", detail: "Continue explicitly", sourceIds: ["run-original", "message-original"] }] };
  expect(strigoiStatus(view)).toContain("ready");
  expect(strigoiStatus(view)).toContain("Continuation workflow");
  expect(strigoiStatus(view)).toContain("run-original, message-original");
  expect(strigoiStatus(view)).not.toContain("HOLD");
  expect(strigoiStatus({ ...view, readiness: "held", hold: { code: "awaiting-safe-boundary", detail: "Release native writer", sourceIds: ["1"] } })).toContain("HOLD awaiting-safe-boundary");
});

import { renderFleet } from "../../src/client/fleet.js";
it("labels the resident composer as a durable message without requiring a worker launch profile", () => {
  const output = renderFleet(snapshot, createFleetState(snapshot), { width: 120, height: 35, color: false });
  expect(output).toContain("Message Strigoi");
  expect(output).toContain("durable resident input");
  expect(output).not.toContain("/model required");
});
