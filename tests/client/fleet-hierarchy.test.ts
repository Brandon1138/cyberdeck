import { expect, it } from "vitest";
import { createFleetState, transitionFleet, renderFleet, type FleetSnapshot, type FleetState } from "../../src/client/fleet.js";
import { fleetListRows } from "../../src/client/fleet/list-rows.js";
import { focusRow } from "../../src/client/fleet/list-groups.js";
import { normalizeState } from "../../src/client/fleet/normalize.js";
import { revealFleetThread } from "../../src/client/fleet/transition-visit.js";
import { restoreFolderDispositions } from "../../src/client/fleet/visit-state.js";
import { sessionTree, workerTreeKey, FLEET_ORCS_KEY } from "../../src/client/fleet/session-tree.js";
import { displayWidth } from "../../src/client/display-width.js";
import { hierarchyFixture, treeThread, TREE_NOW } from "../fixtures/fleet-hierarchy.js";
const now = Date.parse(TREE_NOW);
const visible = (snapshot: FleetSnapshot, state = createFleetState(snapshot)) => fleetListRows(snapshot, state)
  .filter(row => row.kind === "thread").map(row => row.thread.record.id);

it("keeps Fleet Orcs above projects, follows native edges and current leases, and contains old inventories", () => {
  const snapshot = hierarchyFixture();
  const tree = sessionTree(snapshot);
  expect(tree[0]?.key).toBe(FLEET_ORCS_KEY);
  expect(tree[0]?.nodes.map(n => n.thread.record.id)).toContain("Executive");
  const project = tree.find(g => g.key === "/projects/parking")!;
  expect(project.nodes.map(n => n.thread.record.id)).toEqual(["Parking Orc"]);
  expect(project.nodes[0]?.children.map(n => n.thread.record.id)).toContain("Browser verification");
  expect(visible(snapshot)).toEqual(["Executive", "Standalone", "Parking Orc", "Browser verification", "Implement presence", "Nested review"]);
  const rows = fleetListRows(snapshot, createFleetState(snapshot));
  expect(rows.find(row => row.kind === "folder" && row.label === "Unconfirmed workers")).toMatchObject({ collapsed: true, threadCount: 54 });
  expect(rows.find(row => row.kind === "folder" && row.label === "History")).toMatchObject({ collapsed: true, threadCount: 80 });
  expect(rows.length).toBeLessThan(25);
});

it("folds an Orc without attaching it, preserves its focus and persists the fold", () => {
  const snapshot = hierarchyFixture();
  let state: FleetState = { ...createFleetState(snapshot), selectedSessionId: "Parking Orc" };
  const folded = transitionFleet(state, snapshot, "left", now);
  expect(folded.action).toMatchObject({ type: "folder-disposition", cwd: workerTreeKey("Parking Orc"), disposition: { collapsed: true } });
  state = normalizeState(folded.state, snapshot, now);
  expect(state.selectedSessionId).toBe("Parking Orc");
  expect(state.focusedFolderCwd).toBeUndefined();
  expect(visible(snapshot, state)).not.toContain("Browser verification");
  expect(fleetListRows(snapshot, state).some(row => row.kind === "section" && row.label.includes("needs attention"))).toBe(true);
  const restored = restoreFolderDispositions(createFleetState(snapshot), snapshot, {
    [workerTreeKey("Parking Orc")]: { collapsed: true, expanded: false },
  });
  expect(visible(snapshot, restored)).not.toContain("Implement presence");
  const expanded = transitionFleet(state, snapshot, "right", now);
  expect(visible(snapshot, expanded.state)).toContain("Nested review");
  expect(transitionFleet(expanded.state, snapshot, "enter", now).action).toEqual({ type: "attach", sessionId: "Parking Orc" });
});

it("supports left-to-parent and folding nested native workers without sending provider controls", () => {
  const snapshot = hierarchyFixture();
  const nested = { ...createFleetState(snapshot), selectedSessionId: "Nested review" };
  const parent = transitionFleet(nested, snapshot, "left", now);
  expect(parent.state.selectedSessionId).toBe("Implement presence");
  expect(parent.action).toBeUndefined();
  const folded = transitionFleet(parent.state, snapshot, "left", now);
  expect(folded.action).toMatchObject({ type: "folder-disposition", cwd: workerTreeKey("Implement presence") });
  expect(visible(snapshot, folded.state)).not.toContain("Nested review");
  expect(transitionFleet(folded.state, snapshot, "enter", now).action).toBeUndefined();
});

it("makes all workers reachable independently of Orc folds", () => {
  const snapshot = hierarchyFixture();
  const folded = { ...createFleetState(snapshot), collapsedCwds: [workerTreeKey("Parking Orc")] };
  const state = transitionFleet({ ...folded, draft: "/view workers" }, snapshot, "enter", now).state;
  expect(state.listView).toBe("workers");
  expect(visible(snapshot, state)).toContain("Nested review");
  expect(visible(snapshot, state)).not.toContain("Parking Orc");
  const row = fleetListRows(snapshot, state).find(row => row.kind === "folder" && row.label === "Unconfirmed workers")!;
  const expanded = transitionFleet(focusRow(state, row), snapshot, "enter", now);
  expect(visible(snapshot, expanded.state).filter(id => id.startsWith("old-native"))).toHaveLength(54);
});

it("reveals only the inspected historical or unconfirmed target through closed ancestors", () => {
  const snapshot = hierarchyFixture();
  for (const id of ["old-native-3", "retired-orc-4"]) {
    const state = revealFleetThread({ ...createFleetState(snapshot), projectFilter: "/elsewhere",
      collapsedCwds: [FLEET_ORCS_KEY, "/projects/parking", workerTreeKey("Parking Orc")] }, snapshot, id);
    expect(visible(snapshot, state)).toContain(id);
    expect(visible(snapshot, state).filter(candidate => candidate.startsWith("old-native") || candidate.startsWith("retired-orc"))).toEqual([id]);
  }
});

it("retains a live worker under its ended parent and never infers the worker ended with it", () => {
  const snapshot: FleetSnapshot = { currentLayout: "sessions", threads: [
    treeThread("ended", "exited", { kind: "orchestrator" }), treeThread("active-child", "working", { nativeParent: "ended" }),
  ] };
  expect(visible(snapshot)).toEqual(["ended", "active-child"]);
});

it("keeps orphaned workers outside their former creator and follows a handoff", () => {
  const snapshot = hierarchyFixture();
  const managed = snapshot.threads.find(t => t.record.id === "Browser verification")!;
  delete managed.coordination!.currentController;
  expect(sessionTree(snapshot).find(g => g.key === "/projects/parking")!.nodes.map(n => n.thread.record.id)).toContain(managed.record.id);
  const executive = snapshot.threads.find(t => t.record.id === "Executive")!;
  executive.controllerId = "new-controller";
  managed.coordination = { ...managed.coordination!, currentController: { controllerId: "new-controller", familyId: "new", scope: "fleet" } };
  expect(sessionTree(snapshot)[0]!.nodes.find(n => n.thread.record.id === "Executive")!.children.map(n => n.thread.record.id)).toContain(managed.record.id);
});

it("does not lose or duplicate malformed native cycles", () => {
  const snapshot: FleetSnapshot = { currentLayout: "sessions", threads: [
    treeThread("a", "working", { nativeParent: "b" }), treeThread("b", "working", { nativeParent: "a" }),
  ] };
  expect(visible(snapshot).sort()).toEqual(["a", "b"]);
});

it("keeps action focus inert when a selected session disappears", () => {
  const snapshot = hierarchyFixture();
  const state = { ...createFleetState(snapshot), selectedSessionId: "Implement presence" };
  const after = { ...snapshot, threads: snapshot.threads.filter(t => t.record.id !== state.selectedSessionId) };
  expect(transitionFleet(state, after, "ctrl+x", now).action).toBeUndefined();
});

it.each([32, 48, 60, 100, 160])("bounds the tree at width %s and keeps the counts honest", width => {
  const snapshot = hierarchyFixture();
  const frame = renderFleet(snapshot, createFleetState(snapshot), { width, height: 45, color: false, now });
  expect(frame.split("\n").length).toBeLessThanOrEqual(45);
  expect(frame.split("\n").every(line => displayWidth(line) <= width)).toBe(true);
  if (width >= 60) { expect(frame).toContain("native discovered"); expect(frame).toContain("unconfirmed"); }
  expect(frame).not.toContain("57 native workers");
});


it("keeps empty registered projects navigable without treating synthetic groups as paths", () => {
  const snapshot: FleetSnapshot = { currentLayout: "sessions", projects: ["/projects/empty"], threads: [] };
  const state = createFleetState(snapshot);
  const project = fleetListRows(snapshot, state).find(row => row.kind === "folder" && row.cwd === "/projects/empty");
  expect(project).toBeDefined();
  expect(transitionFleet(focusRow(state, project), snapshot, "ctrl+n", now).action)
    .toEqual({ type: "open-checkout", cwd: "/projects/empty" });
  const populated = hierarchyFixture();
  const group = fleetListRows(populated, createFleetState(populated)).find(row => row.kind === "folder" && row.cwd === FLEET_ORCS_KEY);
  expect(transitionFleet(focusRow(createFleetState(populated), group), populated, "ctrl+n", now).action).toBeUndefined();
});

it("honors manual sibling order while keeping pinned workers first", () => {
  const a = treeThread("a", "idle");
  const b = treeThread("b", "idle");
  a.record.displayOrder = 2; b.record.displayOrder = 1;
  expect(visible({ currentLayout: "sessions", threads: [a, b] })).toEqual(["b", "a"]);
  a.record.pinned = true;
  expect(visible({ currentLayout: "sessions", threads: [a, b] })).toEqual(["a", "b"]);
});

it("retains handoff marks and attributed PR badges on tree rows", () => {
  const snapshot = hierarchyFixture();
  const state = { ...createFleetState(snapshot), selectedSessionId: "Browser verification", handoffMarks: ["Browser verification"] };
  const frame = renderFleet(snapshot, state, { width: 160, height: 55, color: false, now,
    pullRequests: new Map([["Browser verification", { state: "open", number: 164 }]]) });
  const row = frame.split("\n").find(line => line.includes("managed Browser verification"))!;
  expect(row).toContain("#164");
  expect(row).toContain("Needs you");
  expect(row.slice(0, 2).trim()).toHaveLength(2);
});


it("counts native and managed unconfirmed records once without calling them live", () => {
  const snapshot: FleetSnapshot = { currentLayout: "sessions", threads: [
    treeThread("managed-unknown", "unknown"), treeThread("native-unknown", "unknown", { nativeParent: "missing" }),
  ] };
  const frame = renderFleet(snapshot, createFleetState(snapshot), { width: 160, height: 40, color: false, now });
  expect(frame).toContain("0 live Orcs · 0 live managed workers · 1 native discovered");
  expect(frame.match(/2 runtime unconfirmed/g)).toHaveLength(1);
});
