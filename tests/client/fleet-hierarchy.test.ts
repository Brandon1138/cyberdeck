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
  expect(rows.some(row => row.kind === "folder" && row.label === "Unconfirmed workers")).toBe(false);
  expect(rows.some(row => row.kind === "folder" && row.label === "History")).toBe(false);
  expect(rows.length).toBeLessThan(25);
});

it("opens on Fleet Orcs and adds a project only while it has live sessions", () => {
  const resident = treeThread("Strigoi", "idle", { kind: "orchestrator", controller: "resident" });
  resident.record.orchestratorScope = "fleet";
  const root = "/projects/cyberdeck";
  const fresh: FleetSnapshot = { currentLayout: "sessions", projects: [root], threads: [resident] };
  const rows = (snapshot: FleetSnapshot) => fleetListRows(snapshot, createFleetState(snapshot));
  expect(createFleetState(fresh).listView).toBe("live");
  expect(rows(fresh).map(row => row.kind)).toEqual(["views", "folder", "thread"]);
  expect(rows(fresh)[1]).toMatchObject({ label: "Fleet Orcs" });
  const astra = treeThread("Astra", "idle", { kind: "orchestrator", controller: "astra" });
  astra.record.orchestratorScope = "fleet";
  astra.record.projectRoot = root;
  const worker = hierarchyFixture().threads.find(t => t.record.id === "Browser verification")!;
  for (const owner of [resident, astra]) {
    worker.coordination!.currentController!.controllerId = owner.controllerId!;
    const active = { ...fresh, threads: [resident, astra, worker] };
    expect(rows(active).filter(row => row.kind === "folder").map(row => row.label)).toEqual(["Fleet Orcs", root]);
    expect(rows(active).find(row => row.kind === "thread" && row.thread === worker))
      .toMatchObject({ tree: { parentKey: workerTreeKey(owner.record.id) } });
    expect(visible(active, { ...createFleetState(active), collapsedCwds: [workerTreeKey(owner.record.id)] }))
      .not.toContain(worker.record.id);
  }
  const unknown = { ...worker, runtimePresence: "unknown" as const };
  expect(rows({ ...fresh, threads: [resident, unknown, { ...astra, runtimePresence: "absent" }] }))
    .toEqual(rows(fresh));
});

it("folds both leased providers under the current Orc even when a native parent points elsewhere", () => {
  const fixture = hierarchyFixture();
  const owner = fixture.threads.find(t => t.record.id === "Parking Orc")!;
  const previous = treeThread("previous", "idle", { kind: "orchestrator", controller: "previous" });
  const lease = fixture.threads.find(t => t.record.id === "Browser verification")!.coordination!;
  const luna = treeThread("Luna", "idle", { nativeParent: previous.record.id });
  const grok = treeThread("Grok", "blocked-modal");
  grok.record.provider = "cursor";
  for (const thread of [luna, grok]) thread.coordination = { ...lease, sessionId: thread.record.id, subjectId: thread.record.id };
  const snapshot = { ...fixture, threads: [owner, previous, grok, luna] };
  const state = { ...createFleetState(snapshot), selectedSessionId: owner.record.id };
  const folded = transitionFleet(state, snapshot, "left", now).state;
  expect(visible(snapshot, folded)).toEqual(expect.arrayContaining([owner.record.id, previous.record.id]));
  for (const worker of [luna, grok]) expect(visible(snapshot, folded)).not.toContain(worker.record.id);
  const expanded = transitionFleet(folded, snapshot, "right", now).state;
  expect(visible(snapshot, expanded)).toEqual(expect.arrayContaining(["Grok", "Luna"]));
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
  expect(fleetListRows(snapshot, state).some(row => row.kind === "section" && row.label.includes("needs attention"))).toBe(false);
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

it("groups a Fleet Orc under its chosen project and folds its workers there", () => {
  const snapshot = hierarchyFixture();
  const orc = snapshot.threads.find(t => t.record.id === "Parking Orc")!;
  orc.record.orchestratorScope = "fleet";
  orc.record.projectRoot = "/projects/parking";
  const project = sessionTree(snapshot).find(group => group.key === "/projects/parking")!;
  expect(project.nodes.map(node => node.thread.record.id)).toEqual(["Parking Orc"]);
  expect(project.nodes[0]!.children.map(node => node.thread.record.id)).toContain("Browser verification");
  const state = { ...createFleetState(snapshot), selectedSessionId: orc.record.id };
  expect(visible(snapshot, transitionFleet(state, snapshot, "left", now).state)).not.toContain("Browser verification");
  const frame = renderFleet(snapshot, state, { width: 120, height: 45, color: false, now });
  expect(frame).toContain("[Live]  Unread  History");
});

it("reveals only the inspected historical or unconfirmed target through closed ancestors", () => {
  const snapshot = hierarchyFixture();
  for (const id of ["old-native-3", "retired-orc-4"]) {
    const state = revealFleetThread({ ...createFleetState(snapshot), projectFilter: "/elsewhere",
      collapsedCwds: [FLEET_ORCS_KEY, "/projects/parking", workerTreeKey("Parking Orc")] }, snapshot, id);
    expect(visible(snapshot, state)).toContain(id);
    expect(state.listView).toBe("history");
    expect(visible(snapshot, { ...state, listView: "live" })).not.toContain(id);
  }
});

it("retains a live worker when its ended parent is hidden and never infers the worker ended with it", () => {
  const snapshot: FleetSnapshot = { currentLayout: "sessions", threads: [
    treeThread("ended", "exited", { kind: "orchestrator" }), treeThread("active-child", "working", { nativeParent: "ended" }),
  ] };
  expect(visible(snapshot)).toEqual(["active-child"]);
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
  expect(frame).not.toContain("unconfirmed");
  expect(frame).not.toContain("57 native workers");
});


it("hides empty registered projects without treating synthetic groups as paths", () => {
  const snapshot: FleetSnapshot = { currentLayout: "sessions", projects: ["/projects/empty"], threads: [] };
  const state = createFleetState(snapshot);
  const project = fleetListRows(snapshot, state).find(row => row.kind === "folder" && row.cwd === "/projects/empty");
  expect(project).toBeUndefined();
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
  const row = frame.split("\n").find(line => line.includes("· Browser verification"))!;
  expect(row).toContain("#164");
  expect(row).toContain("Needs you");
  expect(row.slice(0, 2).trim()).toHaveLength(2);
});

it("names only Orcs and native workers, and says which sessions a terminal holds", () => {
  const snapshot = hierarchyFixture();
  const record = (id: string) => snapshot.threads.find(t => t.record.id === id)!.record;
  record("Parking Orc").attachmentState = "controlled";
  record("Browser verification").attachmentState = "watched";
  const lines = renderFleet(snapshot, createFleetState(snapshot), { width: 120, height: 40, color: false, now }).split("\n");
  const row = (name: string) => lines.find(line => line.includes(` ${name} `))!;
  expect(row("Orc Parking Orc")).toMatch(/Working · open\b/u);
  expect(row("Orc Executive")).not.toMatch(/ · (open|watching)\b/u);
  expect(row("· Browser verification")).toMatch(/Needs you · watching\b/u);
  expect(row("native Nested review")).toBeDefined();
  expect(lines.join("\n")).not.toMatch(/\b(ORC|managed) /u);
});


it("counts native and managed unconfirmed records once without calling them live", () => {
  const snapshot: FleetSnapshot = { currentLayout: "sessions", threads: [
    treeThread("managed-unknown", "unknown"), treeThread("native-unknown", "unknown", { nativeParent: "missing" }),
  ] };
  const frame = renderFleet(snapshot, createFleetState(snapshot), { width: 160, height: 40, color: false, now });
  expect(frame).toContain("0 live ·");
  expect(frame).not.toContain("unconfirmed");
  expect(visible(snapshot)).toEqual([]);
});


it("filters cross-project descendants and rollups in Live", () => {
  const fleet = treeThread("Fleet", "idle", { kind: "orchestrator", cwd: "/home/operator", controller: "fleet-controller" });
  fleet.record.orchestratorScope = "fleet";
  const parking = treeThread("parking-worker", "working", { nativeParent: "Fleet", cwd: "/projects/parking" });
  const other = treeThread("other-worker", "working", { nativeParent: "Fleet", cwd: "/projects/other" });
  const parent = treeThread("cross-project-parent", "idle", { nativeParent: "Fleet", cwd: "/projects/other" });
  const nested = treeThread("parking-grandchild", "working", { nativeParent: parent.record.id, root: "Fleet", cwd: "/projects/parking" });
  const snapshot: FleetSnapshot = { currentLayout: "sessions", projects: ["/projects/parking", "/projects/other"],
    threads: [fleet, parking, other, parent, nested] };
  const state: FleetState = { ...createFleetState(snapshot), listView: "live", projectFilter: "/projects/parking" };
  const ids = visible(snapshot, state);
  expect(ids).toContain("parking-worker");
  expect(ids).toContain("parking-grandchild");
  expect(ids).not.toContain("other-worker");
  expect(ids).toContain("cross-project-parent");
  const rows = fleetListRows(snapshot, state);
  expect(rows.filter(row => row.kind === "section").map(row => row.label).join(" ")).not.toContain("3 working");
});
