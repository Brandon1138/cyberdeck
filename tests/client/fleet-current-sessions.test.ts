import { expect, it } from "vitest";
import { createFleetState, renderFleet, transitionFleet, type FleetSnapshot, type FleetThread } from "../../src/client/fleet.js";
import { fleetListRows } from "../../src/client/fleet/list-rows.js";
import { projectWorkerTruth } from "../../src/domain/worker-truth.js";
import type { SessionRecord } from "../../src/domain/session.js";
import { revealFleetThread } from "../../src/client/fleet/transition-visit.js";
const NOW = "2026-11-10T12:00:00.000Z";
function thread(id: string, native = false): FleetThread {
  return { record: { id, name: id, kind: native ? "worker" : "orchestrator", role: native ? "worker" : "orchestrator", provider: "codex", cwd: native ? "/repo/worker" : "/repo",
    sandbox: "read-only", detached: true, createdAt: NOW, updatedAt: NOW, executionState: "active", attachmentState: "detached",
    pid: native ? 0 : 42, exitCode: null, childIds: [] } as SessionRecord,
    runtimePresence: native ? "unknown" : "present",
    workerTruth: projectWorkerTruth({ executionState: "active", exitCode: null, activity: "working",
      composer: { occupied: false, modalOpen: false }, completedTurns: 0, canonicalTurns: 0, pendingInstructions: 0 }),
    ...(native ? { nativeAgent: { threadId: id, parentThreadId: "native-parent", parentName: "Astra", rootSessionId: "parent" } } : {}) };
}
const snapshot: FleetSnapshot = { currentLayout: "sessions", threads: [thread("parent"), thread("publication", true)], projects: ["/repo", "/empty"] };
it("shows native workers and unconfirmed sessions directly without topology disclosures", () => {
  const rows = fleetListRows(snapshot, createFleetState(snapshot));
  expect(rows.filter(row => row.kind === "thread").map(row => row.thread.record.id)).toEqual(["parent", "publication"]);
  expect(rows.some(row => ["folder", "history", "unconfirmed", "ownership"].includes(row.kind))).toBe(false);
  const body = renderFleet(snapshot, createFleetState(snapshot), { width: 140, height: 30, color: false });
  expect(body).toContain("publication"); expect(body).toContain("Astra"); expect(body).not.toContain("/empty");
});
it.each(["enter", "right", " ", "ctrl+x", "ctrl+d", "ctrl+r", "ctrl+t", "ctrl+n", "shift+up", "alt+2"])("keeps native observation read-only for %s", key => {
  const result = transitionFleet({ ...createFleetState(snapshot), selectedSessionId: "publication" }, snapshot, key);
  expect(result.action).toBeUndefined();
  expect(result.state.notice).toContain("Native worker");
});
it("filters current sessions by project and retains row order through status changes", () => {
  const state = createFleetState(snapshot);
  const changed = { ...snapshot, threads: snapshot.threads.map(thread => ({ ...thread, record: { ...thread.record, meaningfulUpdatedAt: new Date().toISOString() } })) };
  expect(fleetListRows(changed, state).filter(row => row.kind === "thread").map(row => row.thread.record.id)).toEqual(["parent", "publication"]);
  const filtered = transitionFleet({ ...state, draft: "/filter /elsewhere" }, snapshot, "enter");
  expect(filtered.action).toBeUndefined();
  expect(fleetListRows(snapshot, filtered.state).filter(row => row.kind === "thread")).toEqual([]);
});
it("allows spaces in a draft and independent picker actions while a native child is selected", () => {
  const state = { ...createFleetState(snapshot), selectedSessionId: "publication", draft: "/view" };
  expect(transitionFleet(state, snapshot, " ").state.draft).toBe("/view ");
  const picked = transitionFleet({ ...state, draft: "", orchestratorPicker: { step: "target", focus: { kind: "existing", sessionId: "parent" } } }, snapshot, "enter");
  expect(picked.action).toBeDefined();
  expect(picked.state.notice ?? "").not.toContain("Native worker");
});
it("closes the palette and resets scroll when applying a typed project filter", () => {
  let state = { ...createFleetState(snapshot), threadListScrollOffset: 50 };
  for (const key of "/filter /repo") state = transitionFleet(state, snapshot, key).state;
  state = transitionFleet(state, snapshot, "enter").state;
  expect(state.projectFilter).toBe("/repo"); expect(state.commandPalette).toBeUndefined();
  expect(state.threadListScrollOffset).toBe(0);
});
it("keeps a stopped session selected through the stop and delete confirmation ladder", () => {
  const before = { ...snapshot, threads: [thread("parent")] };
  const requested = transitionFleet(createFleetState(before), before, "ctrl+x");
  expect(requested.action).toEqual({ type: "stop", sessionId: "parent" });
  const stopped: FleetThread = { ...before.threads[0]!, runtimePresence: "absent", record: {
    ...before.threads[0]!.record, executionState: "exited", attentionState: "stopped", exitCode: 0 } };
  const after = { ...before, threads: [stopped] };
  const confirmation = transitionFleet(requested.state, after, "ctrl+x");
  expect(confirmation.state.selectedSessionId).toBe("parent");
  expect(confirmation.state.deleteConfirmation?.sessionId).toBe("parent");
  expect(fleetListRows(after, confirmation.state).filter(row => row.kind === "thread").map(row => row.thread.record.id)).toEqual(["parent"]);
  expect(transitionFleet(confirmation.state, after, "ctrl+x").action).toEqual({ type: "delete", sessionId: "parent" });
});
it("reveals one inspected historical session even outside the current project filter", () => {
  const archived: FleetThread = { ...thread("history"), runtimePresence: "absent", record: { ...thread("history").record, executionState: "exited", exitCode: 0 } };
  const other: FleetThread = { ...archived, record: { ...archived.record, id: "other-history" } };
  const historical = { ...snapshot, threads: [archived, other] };
  const revealed = revealFleetThread({ ...createFleetState(historical), projectFilter: "/elsewhere" }, historical, "history");
  expect(fleetListRows(historical, revealed).filter(row => row.kind === "thread").map(row => row.thread.record.id)).toEqual(["history"]);
});
