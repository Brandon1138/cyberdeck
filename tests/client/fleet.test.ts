import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { SessionRecord } from "../../src/domain/session.js";
import {
  collectFleetSnapshot,
  createFleetState,
  FleetKeyDecoder,
  renderFleet,
  runFleet,
  startFleetSession,
  threadStatus,
  transitionFleet,
  type FleetSnapshot,
  type FleetState,
} from "../../src/client/fleet.js";
import type { PullRequestState } from "../../src/client/pr-status.js";
import type { FleetWorkerCoordinationView } from "../../src/broker/worker-coordination-view.js";

const NOW = "2026-07-22T10:00:00.000Z";
const NOW_MS = Date.parse(NOW);

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    provider: "claude",
    cwd: "/Users/brandon/code/personal/cyberdeck",
    detached: true,
    sandbox: "read-only",
    name: "Implement modular cryptographic scheme",
    model: "provider-native-model",
    role: "orchestrator",
    createdAt: NOW,
    updatedAt: NOW,
    executionState: "active",
    attachmentState: "detached",
    pid: 4321,
    exitCode: null,
    childIds: [],
    ...overrides,
  } as SessionRecord;
}

function fleet(...records: Array<{
  record: SessionRecord;
  replay?: string;
  coordination?: FleetWorkerCoordinationView;
}>): FleetSnapshot {
  return {
    threads: records.map(({ record, replay = "", coordination }) => ({
      record,
      replay,
      ...(coordination === undefined ? {} : { coordination }),
    })),
  };
}

function coordination(
  sessionId: string,
  leaseHealth: FleetWorkerCoordinationView["leaseHealth"],
  overrides: { creatorControllerId?: string; adoptable?: boolean } = {},
): FleetWorkerCoordinationView {
  const creatorControllerId = overrides.creatorControllerId ?? `creator-${leaseHealth}`;
  const controlled = leaseHealth === "active" || leaseHealth === "contested";
  return {
    sessionId,
    subjectId: sessionId,
    origin: {
      creatorControllerId,
      taskId: `task-${leaseHealth}`,
      threadId: sessionId,
      createdAt: NOW,
    },
    ...(controlled
      ? {
        currentController: {
          controllerId: `controller-${leaseHealth}`,
          familyId: `family-${leaseHealth}`,
          scope: "fleet:local",
        },
      }
      : {}),
    leaseHealth,
    orphaned: leaseHealth === "orphaned",
    adoptable: overrides.adoptable
      ?? (leaseHealth === "orphaned" || leaseHealth === "expired"),
  };
}

/** A fleet state with one folder already opened past the show-more cap. */
function expandedState(snapshot: FleetSnapshot, cwd: string): FleetState {
  return { ...createFleetState(snapshot), expandedCwds: [cwd] };
}

/** A fleet of orchestrators alone, newest first, each launched in its own folder. */
function orcFleet(count: number): FleetSnapshot {
  return fleet(...Array.from({ length: count }, (_, index) => ({
    record: session({
      id: `99999999-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      kind: "orchestrator",
      role: "orchestrator",
      cwd: `/repo/${String(index + 1).padStart(2, "0")}`,
      name: `Orc ${index + 1}`,
      updatedAt: `2026-07-22T09:${String(59 - index).padStart(2, "0")}:00.000Z`,
    }),
  })));
}

function threadFleet(count: number, cwd = "/repo/one"): FleetSnapshot {
  return fleet(...Array.from({ length: count }, (_, index) => ({
    record: session({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      cwd,
      name: `Thread ${index + 1}`,
      displayOrder: index,
    }),
  })));
}

describe("fleet presentation", () => {
  it("lists every orchestrator once, at the top, above the folders its workers live in", () => {
    const worker = session({
      id: "22222222-2222-4222-8222-222222222222",
      kind: "worker",
      role: "worker",
      cwd: "/repo/zulu",
      name: "Zulu worker",
      updatedAt: "2026-07-22T09:59:59.000Z",
    });
    const staleOrc = session({
      id: "33333333-3333-4333-8333-333333333333",
      kind: "orchestrator",
      role: "orchestrator",
      cwd: "/repo/zulu",
      name: "Older orc",
      updatedAt: "2026-07-22T09:58:00.000Z",
    });
    const freshOrc = session({
      id: "55555555-5555-4555-8555-555555555555",
      kind: "orchestrator",
      role: "orchestrator",
      cwd: "/repo/alpha",
      name: "Newer orc",
      updatedAt: "2026-07-22T09:59:00.000Z",
    });
    const onlyWorker = session({
      id: "44444444-4444-4444-8444-444444444444",
      kind: "worker",
      role: "worker",
      name: "Alpha worker",
      cwd: "/repo/alpha",
      updatedAt: "2026-07-22T09:57:00.000Z",
    });
    const snapshot = fleet(
      { record: worker },
      { record: staleOrc },
      { record: freshOrc },
      { record: onlyWorker },
    );
    const rendered = renderFleet(snapshot, createFleetState(snapshot), {
      color: false, width: 150, height: 40, now: NOW_MS, home: "/Users/brandon",
    });
    const lines = rendered.split("\n");
    const lineOf = (needle: string) => lines.findIndex((line) => line.includes(needle));

    // One Orcs section for the whole fleet, most recent first. Orc rows carry no folder: an orc
    // works across repos, so the path it spawned in says nothing, and a column only orcs filled
    // knocked every column right of it out of line with the worker rows below.
    expect(rendered.match(/Orcs/g)).toHaveLength(1);
    expect(lineOf("Orcs")).toBeLessThan(lineOf("Newer orc"));
    expect(lineOf("Newer orc")).toBeLessThan(lineOf("Older orc"));
    expect(lines[lineOf("Newer orc")]).not.toContain("/repo/alpha");
    expect(lines[lineOf("Older orc")]).not.toContain("/repo/zulu");

    // Both orcs sit above the first folder header, and no folder repeats them.
    expect(lineOf("Older orc")).toBeLessThan(lineOf("▾ /repo/alpha"));
    expect(lineOf("▾ /repo/alpha")).toBeLessThan(lineOf("▾ /repo/zulu"));
    expect(rendered.match(/Newer orc/g)).toHaveLength(1);
    expect(rendered.match(/Older orc/g)).toHaveLength(1);

    // Navigation walks the same shape: orcs, then folder header, worker, folder header, worker.
    const initial = createFleetState(snapshot);
    expect(initial.selectedSessionId).toBe(freshOrc.id);
    const older = transitionFleet(initial, snapshot, "down", NOW_MS).state;
    expect(older.selectedSessionId).toBe(staleOrc.id);
    const alphaFolder = transitionFleet(older, snapshot, "down", NOW_MS).state;
    expect(alphaFolder.focusedFolderCwd).toBe("/repo/alpha");
    const alphaWorker = transitionFleet(alphaFolder, snapshot, "down", NOW_MS).state;
    expect(alphaWorker.selectedSessionId).toBe(onlyWorker.id);
    const zuluFolder = transitionFleet(alphaWorker, snapshot, "down", NOW_MS).state;
    expect(zuluFolder.focusedFolderCwd).toBe("/repo/zulu");
    expect(transitionFleet(zuluFolder, snapshot, "down", NOW_MS).state.selectedSessionId)
      .toBe(worker.id);
  });

  it("aligns orc rows with worker rows, column for column", () => {
    const orc = session({
      id: "33333333-3333-4333-8333-333333333333",
      kind: "orchestrator",
      role: "orchestrator",
      cwd: "/repo/some/deeply/nested/working/directory",
      name: "Overseer",
      updatedAt: "2026-07-22T09:58:00.000Z",
    });
    const worker = session({
      id: "22222222-2222-4222-8222-222222222222",
      kind: "worker",
      role: "worker",
      cwd: "/repo/zulu",
      name: "Minion",
      updatedAt: "2026-07-22T09:59:59.000Z",
    });
    const snapshot = fleet({ record: orc }, { record: worker });
    const lines = renderFleet(snapshot, createFleetState(snapshot), {
      color: false, width: 150, height: 40, now: NOW_MS, home: "/Users/brandon",
    }).split("\n");
    const rowOf = (needle: string) => lines.find((line) => line.includes(needle))!;

    // The orc's cwd is far longer than the worker's, so any per-row folder cell would show up
    // here as the two rows disagreeing about where the model column starts.
    expect(rowOf("Overseer")).not.toContain("/repo/some");
    expect(rowOf("Overseer").indexOf("Claude")).toBeGreaterThan(0);
    expect(rowOf("Overseer").indexOf("Claude")).toBe(rowOf("Minion").indexOf("Claude"));
  });

  it("orders workers inside a folder by last activity, most recent first", () => {
    const workerAt = (index: number, name: string, updatedAt: string, extra = {}) => session({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      kind: "worker",
      role: "worker",
      cwd: "/repo/one",
      name,
      createdAt: "2026-07-22T09:00:00.000Z",
      updatedAt,
      ...extra,
    });
    const snapshot = fleet(
      { record: workerAt(1, "Oldest", "2026-07-22T09:30:00.000Z") },
      { record: workerAt(2, "Newest", "2026-07-22T09:50:00.000Z") },
      // meaningfulUpdatedAt wins over raw updatedAt, exactly as the age column reads it.
      {
        record: workerAt(3, "Middle", "2026-07-22T09:59:00.000Z", {
          meaningfulUpdatedAt: "2026-07-22T09:40:00.000Z",
        }),
      },
    );
    const rendered = renderFleet(snapshot, createFleetState(snapshot), {
      color: false, width: 140, height: 30, now: NOW_MS,
    });

    expect(rendered.indexOf("Newest")).toBeLessThan(rendered.indexOf("Middle"));
    expect(rendered.indexOf("Middle")).toBeLessThan(rendered.indexOf("Oldest"));
  });

  it("caps a folder at five workers behind a navigable show-more row that expands and closes", () => {
    const snapshot = threadFleet(8);
    const view = { color: false, width: 100, height: 30, now: NOW_MS };
    const initial = createFleetState(snapshot);
    const capped = renderFleet(snapshot, initial, view);

    expect(capped).toContain("Thread 5");
    expect(capped).not.toContain("Thread 6");
    expect(capped).toContain("+ 3 more");

    // The show-more row is a first-class stop: five threads down lands on it, not past it.
    let onShowMore = initial;
    for (let step = 0; step < 5; step += 1) {
      onShowMore = transitionFleet(onShowMore, snapshot, "down", NOW_MS).state;
    }
    expect(onShowMore.focusedShowMoreCwd).toBe("/repo/one");
    expect(onShowMore.selectedSessionId).toBe(snapshot.threads[4]?.record.id);
    // Thread keys are inert there, exactly as they are on a folder header.
    expect(transitionFleet(onShowMore, snapshot, "ctrl+x", NOW_MS).action).toBeUndefined();

    const expanded = transitionFleet(onShowMore, snapshot, "enter", NOW_MS).state;
    expect(expanded.expandedCwds).toEqual(["/repo/one"]);
    const expandedRender = renderFleet(snapshot, expanded, view);
    expect(expandedRender).toContain("Thread 8");
    expect(expandedRender).toContain("− show less");
    expect(expandedRender).not.toMatch(/\+ \d+ more/u);

    // Focus stays on the row, so the same key rolls the folder back up.
    expect(expanded.focusedShowMoreCwd).toBe("/repo/one");
    const recapped = transitionFleet(expanded, snapshot, "enter", NOW_MS).state;
    expect(recapped.expandedCwds).toEqual([]);
    expect(renderFleet(snapshot, recapped, view)).not.toContain("Thread 6");

    // Right opens it and Left puts it back, matching the folder header's arrows.
    expect(transitionFleet(recapped, snapshot, "right", NOW_MS).state.expandedCwds)
      .toEqual(["/repo/one"]);
    expect(transitionFleet(expanded, snapshot, "left", NOW_MS).state.expandedCwds)
      .toEqual([]);
  });

  it("leaves a folder of exactly five workers with no show-more row", () => {
    const snapshot = threadFleet(5);
    const rendered = renderFleet(snapshot, createFleetState(snapshot), {
      color: false, width: 100, height: 30, now: NOW_MS,
    });

    expect(rendered).toContain("Thread 5");
    expect(rendered).not.toMatch(/\+ \d+ more/u);
    expect(rendered).not.toContain("show less");
  });

  it("caps the Orcs roster at five behind the same show-more row a folder uses", () => {
    const snapshot = orcFleet(8);
    const view = { color: false, width: 100, height: 40, now: NOW_MS };
    const initial = createFleetState(snapshot);
    const capped = renderFleet(snapshot, initial, view);

    expect(capped).toContain("Orc 5");
    expect(capped).not.toContain("Orc 6");
    expect(capped).toContain("+ 3 more");

    // Five steps down from the newest orc land on the roster's show-more row, not past it.
    let onShowMore = initial;
    for (let step = 0; step < 5; step += 1) {
      onShowMore = transitionFleet(onShowMore, snapshot, "down", NOW_MS).state;
    }
    expect(onShowMore.focusedShowMoreCwd).toBe("/@orcs");

    const expanded = transitionFleet(onShowMore, snapshot, "enter", NOW_MS).state;
    expect(expanded.expandedCwds).toEqual(["/@orcs"]);
    const expandedRender = renderFleet(snapshot, expanded, view);
    expect(expandedRender).toContain("Orc 8");
    expect(expandedRender).toContain("− show less");

    // Right opens it and left puts it back, exactly as on a folder's show-more row.
    const recapped = transitionFleet(expanded, snapshot, "left", NOW_MS).state;
    expect(recapped.expandedCwds).toEqual([]);
    expect(renderFleet(snapshot, recapped, view)).not.toContain("Orc 6");
    expect(transitionFleet(recapped, snapshot, "right", NOW_MS).state.expandedCwds)
      .toEqual(["/@orcs"]);
  });

  it("raises focus onto the Orcs show-more row when churn pushes the selected orc under the cap", () => {
    const snapshot = orcFleet(8);
    const hidden = {
      ...createFleetState(snapshot),
      selectedSessionId: snapshot.threads[7]?.record.id,
    };
    const normalized = transitionFleet(hidden, snapshot, "ctrl+x", NOW_MS);

    expect(normalized.state.focusedShowMoreCwd).toBe("/@orcs");
    expect(normalized.action).toBeUndefined();
  });

  it("folds the whole Orcs section from its header, leaving the folders below it alone", () => {
    const snapshot = fleet(
      ...orcFleet(2).threads.map(({ record }) => ({ record })),
      {
        record: session({
          id: "22222222-2222-4222-8222-222222222222",
          kind: "worker",
          role: "worker",
          cwd: "/repo/zulu",
          name: "Zulu worker",
        }),
      },
    );
    const view = { color: false, width: 100, height: 40, now: NOW_MS };
    const onHeader = transitionFleet(createFleetState(snapshot), snapshot, "home", NOW_MS).state;
    expect(onHeader.focusedFolderCwd).toBe("/@orcs");

    const folded = transitionFleet(onHeader, snapshot, "left", NOW_MS).state;
    expect(folded.collapsedCwds).toEqual(["/@orcs"]);
    const foldedRender = renderFleet(snapshot, folded, view);
    expect(foldedRender).toContain("▸ Orcs · 2 threads");
    expect(foldedRender).not.toContain("Orc 1");
    // Folding the roster is not folding a project: the folders keep their own rows.
    expect(foldedRender).toContain("▾ /repo/zulu");
    expect(foldedRender).toContain("Zulu worker");

    // Enter on the header toggles it back open, and the roster returns intact.
    const unfolded = transitionFleet(folded, snapshot, "enter", NOW_MS).state;
    expect(unfolded.collapsedCwds).toEqual([]);
    expect(renderFleet(snapshot, unfolded, view)).toContain("Orc 1");
  });

  it("lists a Cyberdeck orchestrator under a short name without renaming the record", () => {
    const record = session({ kind: "orchestrator", name: "Cyberdeck orchestrator (claude:opus)" });
    const plain = session({
      id: "22222222-2222-4222-8222-222222222222",
      kind: "orchestrator",
      name: "Some other orchestrator (claude:opus)",
    });
    const snapshot = fleet({ record }, { record: plain });
    const rendered = renderFleet(snapshot, createFleetState(snapshot), {
      color: false, width: 140, height: 30, now: NOW_MS,
    });

    expect(rendered).toContain("cd-orc (claude:opus)");
    expect(rendered).not.toContain("Cyberdeck orchestrator");
    // The stored name is untouched, and a name that does not match the pattern is left alone.
    expect(record.name).toBe("Cyberdeck orchestrator (claude:opus)");
    expect(rendered).toContain("Some other orchestrator (claude:opus)");
  });

  it("clamps every row to the pane so a narrow fleet never soft-wraps", () => {
    const snapshot = fleet(
      {
        record: session({
          kind: "orchestrator",
          cwd: "/Users/brandon/code/personal/cyberdeck/worktrees/fleet-orcs-layout",
          name: "Cyberdeck orchestrator (claude:opus)",
          latestPreview: "A reply long enough to fill the preview column many times over",
        }),
      },
      {
        record: session({
          id: "22222222-2222-4222-8222-222222222222",
          kind: "worker",
          role: "worker",
          cwd: "/Users/brandon/code/personal/cyberdeck/worktrees/fleet-orcs-layout",
          name: "A worker whose name is far wider than a split pane",
        }),
      },
    );
    const width = 50;
    const printed = (line: string) => [...line.replace(/\[[0-9;]*m/gu, "")].length;
    for (const color of [false, true]) {
      const rendered = renderFleet(snapshot, createFleetState(snapshot), {
        color, width, height: 30, now: NOW_MS, home: "/Users/brandon",
      });
      expect(Math.max(...rendered.split("\n").map(printed))).toBeLessThanOrEqual(width);
      // A cut inside painted text closes its own color rather than leaking it down the pane.
      if (color) {
        for (const line of rendered.split("\n")) {
          const opens = line.match(/\[(?!0m)[0-9;]*m/gu)?.length ?? 0;
          expect(line.match(/\[0m/gu)?.length ?? 0).toBe(opens);
        }
      }
    }
  });

  it("raises focus onto the show-more row when churn pushes the selected worker under the cap", () => {
    const snapshot = threadFleet(8);
    const hidden = {
      ...createFleetState(snapshot),
      selectedSessionId: snapshot.threads[7]?.record.id,
    };
    const normalized = transitionFleet(hidden, snapshot, "ctrl+x", NOW_MS);

    expect(normalized.state.focusedShowMoreCwd).toBe("/repo/one");
    expect(normalized.action).toBeUndefined();
  });

  it("keeps a selected orc selected when the folder it was launched in is collapsed", () => {
    const orc = session({ kind: "orchestrator", cwd: "/repo/one" });
    const snapshot = fleet(
      { record: orc },
      { record: session({ id: "22222222-2222-4222-8222-222222222222", cwd: "/repo/one" }) },
    );
    // Collapsing a folder hides its workers, but an orc's row lives in the global
    // Orcs section and stays visible, so it has no header to be pushed up onto.
    const folded = {
      ...createFleetState(snapshot),
      collapsedCwds: ["/repo/one"],
      selectedSessionId: orc.id,
    };
    const normalized = transitionFleet(folded, snapshot, "ctrl+x", NOW_MS);

    expect(normalized.state.selectedSessionId).toBe(orc.id);
    expect(normalized.state.focusedFolderCwd).toBeUndefined();
  });

  const LEASE_STATES = ["active", "expired", "released", "orphaned", "contested"] as const;

  function leaseFleet(): FleetSnapshot {
    return fleet(...LEASE_STATES.map((leaseHealth, index) => {
      const id = `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
      return {
        record: session({
          id,
          kind: "worker",
          role: "worker",
          name: `Lease ${leaseHealth}`,
          displayOrder: index,
        }),
        coordination: coordination(id, leaseHealth),
      };
    }));
  }

  it("reduces each worker's lease custody to one badge on its own row", () => {
    const snapshot = leaseFleet();
    const rendered = renderFleet(snapshot, createFleetState(snapshot), {
      color: false,
      width: 220,
      height: 50,
      now: NOW_MS,
      home: "/Users/brandon",
    });
    const lines = rendered.split("\n");
    const badges: Record<(typeof LEASE_STATES)[number], string | undefined> = {
      active: undefined,
      expired: "adoptable",
      released: "unowned",
      orphaned: "adoptable",
      contested: "conflict",
    };

    // The five-field breakdown no longer doubles the list height.
    expect(rendered).not.toContain("origin creator-");
    for (const leaseHealth of LEASE_STATES) {
      const row = lines.find((line) => line.includes(`Lease ${leaseHealth}`))!;
      const badge = badges[leaseHealth];
      for (const candidate of ["adoptable", "unowned", "conflict", "anomaly", "legacy"]) {
        expect(row.includes(candidate)).toBe(candidate === badge);
      }
    }
  });

  it("paints the badge by severity: dim for expected orphans, alert for conflicts", () => {
    const snapshot = leaseFleet();
    const rendered = renderFleet(snapshot, createFleetState(snapshot), {
      color: true,
      width: 220,
      height: 50,
      now: NOW_MS,
      home: "/Users/brandon",
    });
    const lines = rendered.split("\n");
    const row = (leaseHealth: string) =>
      lines.find((line) => line.includes(`Lease ${leaseHealth}`))!;

    // subtle is bare dim; attention and alert carry the fleet's warning and error hues.
    expect(row("released")).toContain("[2munowned");
    expect(row("orphaned")).toContain("[38;2;212;168;91madoptable");
    expect(row("contested")).toContain("[38;2;217;108;117mconflict");
  });

  it("keeps the five-field custody breakdown behind ctrl+l", () => {
    const id = "22222222-2222-4222-8222-222222222222";
    const snapshot = fleet({
      record: session({ id, kind: "worker", role: "worker", name: "Lease orphaned" }),
      coordination: coordination(id, "orphaned"),
    });
    const options = {
      color: false,
      width: 220,
      height: 50,
      now: NOW_MS,
      home: "/Users/brandon",
    } as const;
    const initial = createFleetState(snapshot);
    expect(renderFleet(snapshot, initial, options)).not.toContain("origin creator-orphaned");

    const opened = transitionFleet(initial, snapshot, "ctrl+l", NOW_MS).state;
    expect(opened.leaseDetail).toBe(true);
    const detailed = renderFleet(snapshot, opened, options);
    const detailLine = detailed.split("\n")
      .find((line) => line.includes("origin creator-orphaned"))!;
    expect(detailLine).toContain("controller none");
    expect(detailLine).toContain("lease orphaned");
    expect(detailLine).toContain("orphaned yes");
    expect(detailLine).toContain("adoptable yes");

    const closed = transitionFleet(opened, snapshot, "ctrl+l", NOW_MS).state;
    expect(closed.leaseDetail).toBe(false);
    expect(renderFleet(snapshot, closed, options)).not.toContain("origin creator-orphaned");
  });

  it("documents the lease-detail toggle in the shortcut help", () => {
    const snapshot = threadFleet(1);
    const helped = transitionFleet(createFleetState(snapshot), snapshot, "?", NOW_MS).state;
    expect(renderFleet(snapshot, helped, {
      color: false, width: 220, height: 50, now: NOW_MS, home: "/Users/brandon",
    })).toContain("ctrl+l lease detail");
  });

  it("summarises a uniformly orphaned group on its heading instead of on every row", () => {
    const entries = [1, 2, 3].map((index) => {
      const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
      return {
        record: session({
          id,
          kind: "worker" as const,
          role: "worker",
          name: `Legacy worker ${index}`,
          displayOrder: index,
        }),
        coordination: coordination(id, "orphaned", {
          creatorControllerId: "legacy-unresolved",
          adoptable: false,
        }),
      };
    });
    const snapshot = fleet(...entries);
    const lines = renderFleet(snapshot, createFleetState(snapshot), {
      color: false, width: 220, height: 50, now: NOW_MS, home: "/Users/brandon",
    }).split("\n");

    expect(lines.some((line) =>
      line.includes("Workers (3 · all orphaned, legacy — not adoptable)"))).toBe(true);
    for (const index of [1, 2, 3]) {
      expect(lines.find((line) => line.includes(`Legacy worker ${index}`))!)
        .not.toContain("legacy");
    }
  });

  it("keeps per-row badges when a group's workers disagree", () => {
    const first = "00000000-0000-4000-8000-000000000001";
    const second = "00000000-0000-4000-8000-000000000002";
    const snapshot = fleet(
      {
        record: session({
          id: first, kind: "worker", role: "worker", name: "Legacy worker", displayOrder: 0,
        }),
        coordination: coordination(first, "orphaned", {
          creatorControllerId: "legacy-unresolved",
          adoptable: false,
        }),
      },
      {
        record: session({
          id: second, kind: "worker", role: "worker", name: "Claimable worker", displayOrder: 1,
        }),
        coordination: coordination(second, "orphaned"),
      },
    );
    const lines = renderFleet(snapshot, createFleetState(snapshot), {
      color: false, width: 220, height: 50, now: NOW_MS, home: "/Users/brandon",
    }).split("\n");

    expect(lines.some((line) => line.includes("Workers ("))).toBe(false);
    expect(lines.find((line) => line.includes("Legacy worker"))!).toContain("legacy");
    expect(lines.find((line) => line.includes("Claimable worker"))!).toContain("adoptable");
  });

  it("skips section headings and lease detail rows during keyboard navigation", () => {
    const orc = session({
      id: "11111111-1111-4111-8111-111111111111",
      kind: "orchestrator",
      role: "orchestrator",
      name: "Section Orc",
      displayOrder: 0,
    });
    const firstId = "22222222-2222-4222-8222-222222222222";
    const secondId = "33333333-3333-4333-8333-333333333333";
    const snapshot = fleet(
      { record: orc },
      {
        record: session({
          id: firstId,
          kind: "worker",
          role: "worker",
          name: "First controlled worker",
          displayOrder: 1,
        }),
        coordination: coordination(firstId, "active"),
      },
      {
        record: session({
          id: secondId,
          kind: "worker",
          role: "worker",
          name: "Second orphaned worker",
          displayOrder: 2,
        }),
        coordination: coordination(secondId, "orphaned"),
      },
    );

    // Detail rows only exist while the toggle is on, which is exactly when they could
    // swallow a keypress, so navigation is checked in that state.
    const initial = { ...createFleetState(snapshot), leaseDetail: true };
    expect(initial.selectedSessionId).toBe(orc.id);
    // Below the Orcs section the next navigable row is the folder header, not a heading.
    const folder = transitionFleet(initial, snapshot, "down", NOW_MS).state;
    expect(folder.focusedFolderCwd).toBe(orc.cwd);
    const first = transitionFleet(folder, snapshot, "down", NOW_MS).state;
    expect(first.selectedSessionId).toBe(firstId);
    const second = transitionFleet(first, snapshot, "down", NOW_MS).state;
    expect(second.selectedSessionId).toBe(secondId);
    expect(transitionFleet(second, snapshot, "up", NOW_MS).state.selectedSessionId).toBe(firstId);
  });

  it("groups threads by project and shows provider, model, status, preview, and recency", () => {
    const snapshot = fleet(
      {
        record: session({ updatedAt: "2026-07-22T09:59:46.000Z" }),
        replay: "\u001b]0;cyberdeck\u0007\r\nLatest useful response",
      },
      {
        record: session({
          id: "22222222-2222-4222-8222-222222222222",
          provider: "codex",
          cwd: "/Users/brandon/code/personal/keystone",
          name: "Review key schedule",
          model: "another-model",
          role: undefined,
          executionState: "exited",
          updatedAt: "2026-07-22T09:58:00.000Z",
        }),
        replay: "Finished review",
      },
    );

    const rendered = renderFleet(snapshot, createFleetState(snapshot), {
      color: false,
      width: 150,
      height: 40,
      now: NOW_MS,
      home: "/Users/brandon",
    });

    expect(rendered).toContain("~/code/personal/cyberdeck");
    expect(rendered).toContain("~/code/personal/keystone");
    expect(rendered).toContain("Claude provider-nat…");
    expect(rendered).toContain("Codex another-model…");
    expect(rendered).toContain("Done");
    expect(rendered).toContain("Latest useful response");
    expect(rendered).toContain("14s");
    expect(rendered).not.toMatch(/recommend|preferred|fallback/i);
  });

  it("keeps multiplexed rows single-line with indented markers, aligned previews, and right-aligned time", () => {
    const done = session({
      name: "Completed task",
      attentionState: "done",
      latestPreview: "The latest reply begins here.\nIts continuation stays inline.",
      updatedAt: "2026-07-22T09:59:46.000Z",
      displayOrder: 0,
    });
    const needsInput = session({
      id: "22222222-2222-4222-8222-222222222222",
      name: "Approval task",
      attentionState: "needs-input",
      latestPreview: "Approval is required before continuing.",
      updatedAt: "2026-07-22T09:58:00.000Z",
      displayOrder: 1,
    });
    const snapshot = fleet({ record: done }, { record: needsInput });
    const rendered = renderFleet(snapshot, createFleetState(snapshot), {
      color: false,
      width: 76,
      height: 28,
      now: NOW_MS,
      home: "/Users/brandon",
    });
    const lines = rendered.split("\n");
    const doneLine = lines.find((line) => line.includes("Completed task"))!;
    const needsInputLine = lines.find((line) => line.includes("Approval task"))!;

    expect(lines).toContain("  ▾ ~/code/personal/cyberdeck");
    expect(doneLine).toMatch(/^▌ ·/u);
    expect(needsInputLine).toMatch(/^  ·/u);
    expect(doneLine).toContain("The latest reply begins");
    expect(doneLine).not.toContain("\n");
    expect(doneLine).toHaveLength(76);
    expect(needsInputLine).toHaveLength(76);
    expect(doneLine).toMatch(/14s$/u);
    expect(needsInputLine).toMatch(/ 2m$/u);
  });

  describe("pull request column", () => {
    const first = session({ name: "Ship indicator", cwd: "/repo/one", displayOrder: 0 });
    const second = session({
      id: "22222222-2222-4222-8222-222222222222",
      name: "No branch yet",
      cwd: "/repo/two",
      displayOrder: 1,
    });
    const snapshot = fleet({ record: first }, { record: second });

    const render = (pullRequests: Map<string, PullRequestState>, width = 120): string =>
      renderFleet(snapshot, createFleetState(snapshot), {
        color: false,
        width,
        height: 28,
        now: NOW_MS,
        home: "/Users/brandon",
        pullRequests,
      });

    const rowFor = (rendered: string, name: string): string =>
      rendered.split("\n").find((line) => line.includes(name))!;

    it("omits the column entirely when nothing in the fleet has a pull request", () => {
      const rendered = render(new Map());
      const row = rowFor(rendered, "Ship indicator");

      expect(row).not.toMatch(/[●○◆⊘✗]/u);
      expect(row).toHaveLength(120);
    });

    it("shows a glyph for the thread with a pull request and nothing for the one without", () => {
      const rendered = render(new Map([["/repo/one", "open" as PullRequestState]]));
      const withPr = rowFor(rendered, "Ship indicator");
      const withoutPr = rowFor(rendered, "No branch yet");

      expect(withPr).toContain("●");
      expect(withoutPr).not.toMatch(/[●○◆⊘✗]/u);
      // The empty cell still holds the column open so rows stay aligned.
      expect(withoutPr).toHaveLength(120);
      expect(withPr).toHaveLength(120);
      expect(withPr.indexOf("●")).toBe(withoutPr.indexOf("Claude") - 2);
    });

    it("renders a distinct glyph per state", () => {
      const glyphs: Array<[PullRequestState, string]> = [
        ["open", "●"],
        ["draft", "○"],
        ["merged", "◆"],
        ["closed", "⊘"],
        ["checks-failing", "✗"],
      ];
      for (const [state, glyph] of glyphs) {
        const row = rowFor(render(new Map([["/repo/one", state]])), "Ship indicator");
        expect(row).toContain(glyph);
      }
    });

    it("paints each glyph with an existing palette tone", () => {
      const rendered = renderFleet(snapshot, createFleetState(snapshot), {
        color: true,
        width: 120,
        height: 28,
        now: NOW_MS,
        pullRequests: new Map([["/repo/one", "checks-failing" as PullRequestState]]),
      });

      expect(rendered).toContain("[38;2;217;108;117m✗[0m");
    });

    it("keeps the column at narrow widths where the identity column is dropped", () => {
      const rendered = render(new Map([["/repo/one", "merged" as PullRequestState]]), 60);
      const row = rowFor(rendered, "Ship indicator");

      expect(row).toContain("◆");
      expect(row).toHaveLength(60);
      expect(rowFor(rendered, "No branch yet")).toHaveLength(60);
    });

    it("ignores pull request state for worktrees not on screen", () => {
      const rendered = render(new Map([["/repo/elsewhere", "open" as PullRequestState]]));

      expect(rowFor(rendered, "Ship indicator")).not.toMatch(/[●○◆⊘✗]/u);
    });
  });

  it("counts only running agents in the header while finished threads stay listed", () => {
    // The shape the fleet has right after a broker restart: durable history plus one live agent.
    const snapshot = fleet(
      { record: session({ name: "Still running", attentionState: "working", displayOrder: 0 }) },
      {
        record: session({
          id: "22222222-2222-4222-8222-222222222222",
          name: "Finished earlier",
          executionState: "exited",
          exitCode: 0,
          attentionState: "done",
          displayOrder: 1,
        }),
      },
      {
        record: session({
          id: "33333333-3333-4333-8333-333333333333",
          name: "Finished before that",
          executionState: "exited",
          exitCode: 0,
          attentionState: "done",
          displayOrder: 2,
        }),
      },
      {
        record: session({
          id: "44444444-4444-4444-8444-444444444444",
          name: "Died mid-task",
          executionState: "errored",
          attentionState: "failed",
          displayOrder: 3,
        }),
      },
    );

    const rendered = renderFleet(snapshot, createFleetState(snapshot), {
      color: false,
      width: 150,
      height: 40,
      now: NOW_MS,
      home: "/Users/brandon",
    });

    expect(rendered).toContain("1 agents · 0 needs input · 1 working · 2 done · 1 failed");
    expect(rendered).toContain("Finished earlier");
    expect(rendered).toContain("Finished before that");
  });

  it("reads a session that died inside a live process as failed, never as needs input", () => {
    const errored = session({ executionState: "errored", attentionState: "failed" });
    expect(threadStatus({ record: errored, replay: "Codex needs your approval\nAllow" })).toBe("Failed");
    // Even with no persisted attention state, the execution state alone settles it.
    expect(threadStatus({
      record: session({ executionState: "errored" }),
      replay: "Codex needs your approval\nAllow",
    })).toBe("Failed");
  });

  it("gives finished and blocked threads separate hues, and marks focus with a rule", () => {
    const done = session({ attentionState: "done", displayOrder: 0 });
    const needsInput = session({
      id: "22222222-2222-4222-8222-222222222222",
      attentionState: "needs-input",
      displayOrder: 1,
    });
    const snapshot = fleet({ record: done }, { record: needsInput });
    const rendered = renderFleet(snapshot, createFleetState(snapshot), {
      color: true,
      width: 120,
      height: 28,
      now: NOW_MS,
    });

    // Done is Completion Green and Needs input is Attention Amber. The focused
    // row adds weight to the dot plus a selection rule in the gutter, never a colour.
    expect(rendered).toContain("\u001b[1m\u001b[38;2;120;198;121m·\u001b[0m\u001b[0m");
    expect(rendered).toContain("\u001b[38;2;212;168;91m·\u001b[0m");
    expect(rendered).toContain("\u001b[38;2;120;198;121mDone       \u001b[0m");
    expect(rendered).toContain("\u001b[38;2;212;168;91mNeeds input\u001b[0m");
    expect(rendered).toContain("\u001b[38;2;154;163;175m▌\u001b[0m");

    // The regression this pins: "finished, go read it" and "blocked, go unblock it"
    // are different errands, so their rows must never resolve to the same hue.
    const rows = rendered.split("\n");
    const doneRow = rows.find((row) => row.includes("Done       ")) ?? "";
    const blockedRow = rows.find((row) => row.includes("Needs input")) ?? "";
    expect(doneRow).toContain("\u001b[38;2;120;198;121m");
    expect(doneRow).not.toContain("\u001b[38;2;212;168;91m");
    expect(blockedRow).toContain("\u001b[38;2;212;168;91m");
    expect(blockedRow).not.toContain("\u001b[38;2;120;198;121m");
  });

  it("marks the one live thread with its own hue and a filled glyph", () => {
    const working = session({ attentionState: "working", displayOrder: 0 });
    const stopped = session({
      id: "22222222-2222-4222-8222-222222222222",
      attentionState: "stopped",
      displayOrder: 1,
    });
    const snapshot = fleet({ record: working }, { record: stopped });
    const options = { color: true, width: 120, height: 28, now: NOW_MS };
    const rendered = renderFleet(snapshot, createFleetState(snapshot), options);

    // Working demands no action but is the one row an operator must find at a
    // glance, so it takes Live Ice rather than sitting in Cool Ash with Stopped.
    expect(rendered).toContain("\u001b[1m\u001b[38;2;169;198;214m•\u001b[0m\u001b[0m");
    expect(rendered).toContain("\u001b[38;2;169;198;214mWorking    \u001b[0m");
    expect(rendered).toContain("\u001b[38;2;154;163;175m·\u001b[0m");
    expect(rendered).toContain("\u001b[38;2;154;163;175mStopped    \u001b[0m");

    const rows = rendered.split("\n");
    const liveRow = rows.find((row) => row.includes("Working    ")) ?? "";
    const inertRow = rows.find((row) => row.includes("Stopped    ")) ?? "";
    expect(liveRow).toContain("\u001b[38;2;169;198;214m");
    expect(inertRow).not.toContain("\u001b[38;2;169;198;214m");

    // The glyph carries the same distinction with colour off, and both glyphs
    // are one cell wide so the columns do not shift.
    const plain = renderFleet(snapshot, createFleetState(snapshot), { ...options, color: false });
    expect(plain).toContain("▌ • ");
    expect(plain).toContain("  · ");
  });

  it("renders folder headers plainly, with no accent reserved for paths", () => {
    const snapshot = fleet({ record: session() });
    const rendered = renderFleet(snapshot, createFleetState(snapshot), {
      color: true,
      width: 120,
      height: 28,
      now: NOW_MS,
      home: "/Users/brandon",
    });

    expect(rendered).toContain("  ▾ ~/code/personal/cyberdeck");
    expect(rendered).not.toContain("\u001b[38;2;158;182;255m");
  });

  it("pins the summary while the thread body scrolls and shows a gutter scrollbar", () => {
    const snapshot = threadFleet(10);
    let last = expandedState(snapshot, "/repo/one");
    for (let index = 1; index < 10; index += 1) {
      last = transitionFleet(last, snapshot, "down", NOW_MS, 7).state;
    }
    const rendered = renderFleet(snapshot, last, {
      color: false,
      width: 100,
      height: 16,
      now: NOW_MS,
    });

    // Thirteen rows: the folder header, its "Workers" heading, ten threads, and the
    // show-more row the folder keeps once expanded.
    expect(last.threadListScrollOffset).toBe(5);
    expect(last.selectedSessionId).toBe(snapshot.threads.at(-1)?.record.id);
    expect(rendered).toContain("Cyberdeck");
    expect(rendered).toContain("Thread 10");
    expect(rendered).not.toContain("Thread 1 ");
    expect(rendered).toMatch(/[│┃]/u);
  });

  it("renders no scrollbar and resets the effective offset when every row fits", () => {
    // Five threads plus the folder header and its "Workers" heading fill the viewport exactly.
    const exact = threadFleet(5);
    const exactState = {
      ...createFleetState(exact),
      threadListScrollOffset: 99,
    };
    const exactRendered = renderFleet(exact, exactState, {
      color: false,
      width: 100,
      height: 16,
      now: NOW_MS,
    });

    expect(exactRendered).toContain("Thread 1");
    expect(exactRendered).toContain("Thread 5");
    expect(exactRendered).not.toMatch(/[│┃]/u);
    expect(transitionFleet(exactState, exact, "home", NOW_MS, 7).state.threadListScrollOffset).toBe(0);

    const short = threadFleet(2);
    const shortState = {
      ...createFleetState(short),
      threadListScrollOffset: -4,
    };
    const shortRendered = renderFleet(short, shortState, {
      color: false,
      width: 100,
      height: 16,
      now: NOW_MS,
    });
    expect(shortRendered).not.toMatch(/[│┃]/u);
    expect(transitionFleet(shortState, short, "down", NOW_MS, 7).state.threadListScrollOffset)
      .toBe(0);
  });

  it("re-clamps a scrolled list after the terminal grows", () => {
    const snapshot = threadFleet(10);
    const scrolled = transitionFleet(
      expandedState(snapshot, "/repo/one"),
      snapshot,
      "end",
      NOW_MS,
      7,
    ).state;
    const rendered = renderFleet(snapshot, scrolled, {
      color: false,
      width: 100,
      height: 32,
      now: NOW_MS,
    });

    expect(rendered).toContain("Thread 1");
    expect(rendered).toContain("Thread 10");
    expect(rendered).not.toMatch(/[│┃]/u);
  });

  it("does not leave an unfocused folder header orphaned at the viewport bottom", () => {
    const firstGroup = threadFleet(4).threads;
    const finalThread = session({
      id: "99999999-9999-4999-8999-999999999999",
      cwd: "/repo/two",
      name: "Final thread",
    });
    const snapshot = {
      threads: [...firstGroup, { record: finalThread, replay: "" }],
    };
    const rendered = renderFleet(snapshot, createFleetState(snapshot), {
      color: false,
      width: 100,
      height: 16,
      now: NOW_MS,
    });

    expect(rendered.split("\n").some((line) => line.includes("▾ /repo/two"))).toBe(false);
    expect(rendered).not.toContain("Final thread");
  });

  it("scrolls a focused folder header into view so collapsing it changes the screen", () => {
    const snapshot = fleet(...["/repo/one", "/repo/two", "/repo/three"].flatMap((cwd, group) =>
      Array.from({ length: 3 }, (_, index) => ({
        record: session({
          id: `00000000-0000-4000-8000-${String(group * 3 + index + 1).padStart(12, "0")}`,
          cwd,
          role: "worker",
          name: `${cwd.slice(6)} thread ${index + 1}`,
          displayOrder: group * 3 + index,
        }),
      }))));
    const view = { color: false, width: 100, height: 16, now: NOW_MS };

    // Folders read alphabetically — one, three, two. Seven steps down: the first folder's
    // three threads, the second folder's header and three threads, then the last header.
    let focused = createFleetState(snapshot);
    for (let step = 0; step < 7; step += 1) {
      focused = transitionFleet(focused, snapshot, "down", NOW_MS, 7).state;
    }
    expect(focused.focusedFolderCwd).toBe("/repo/two");

    // That header is the thirteenth of seventeen rows. A list that only clipped would have left the
    // focus off screen, and collapsing it would then have changed nothing an operator can see.
    const expanded = renderFleet(snapshot, focused, view);
    expect(expanded).toContain("▾ /repo/two");
    expect(expanded).not.toContain("one thread 1");

    const collapsed = renderFleet(
      snapshot,
      transitionFleet(focused, snapshot, "left", NOW_MS, 7).state,
      view,
    );
    expect(collapsed).not.toBe(expanded);
    expect(collapsed).toContain("▸ /repo/two · 3 threads");
    expect(collapsed).not.toContain("▾ /repo/two");
  });

  it("orders folder groups alphabetically by absolute path", () => {
    const snapshot = fleet(...["/repo/zulu", "/repo/alpha", "/repo/mid"].map((cwd, index) => ({
      record: session({
        id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        kind: "worker" as const,
        role: "worker",
        cwd,
        name: `${cwd.slice(6)} thread`,
        // Newest folder last alphabetically, so recency cannot be what orders the groups.
        updatedAt: `2026-07-22T09:5${index}:00.000Z`,
      }),
    })));
    const rendered = renderFleet(snapshot, createFleetState(snapshot), {
      color: false, width: 100, height: 30, now: NOW_MS,
    });

    expect(rendered.indexOf("▾ /repo/alpha")).toBeLessThan(rendered.indexOf("▾ /repo/mid"));
    expect(rendered.indexOf("▾ /repo/mid")).toBeLessThan(rendered.indexOf("▾ /repo/zulu"));
  });

  it("handles an empty thread list without a scrollbar", () => {
    const snapshot = fleet();
    const rendered = renderFleet(snapshot, createFleetState(snapshot), {
      color: false,
      width: 100,
      height: 16,
      now: NOW_MS,
    });

    expect(rendered).toContain("No durable agent threads yet.");
    expect(rendered).not.toMatch(/[│┃]/u);
  });

  it("reorders orcs as their activity changes while folder groups stay put", () => {
    const first = session({
      kind: "orchestrator",
      name: "First orchestrator",
      cwd: "/repo/one",
      createdAt: "2026-07-22T09:00:00.000Z",
      updatedAt: "2026-07-22T09:59:00.000Z",
    });
    const second = session({
      id: "22222222-2222-4222-8222-222222222222",
      kind: "orchestrator",
      name: "Second orchestrator",
      cwd: "/repo/one",
      createdAt: "2026-07-22T09:01:00.000Z",
      updatedAt: "2026-07-22T09:58:00.000Z",
    });
    const otherProject = session({
      id: "33333333-3333-4333-8333-333333333333",
      kind: "orchestrator",
      name: "Other project",
      cwd: "/repo/two",
      createdAt: "2026-07-22T09:02:00.000Z",
      updatedAt: "2026-07-22T09:57:00.000Z",
    });
    const before = renderFleet(
      fleet({ record: first }, { record: second }, { record: otherProject }),
      createFleetState(fleet({ record: first }, { record: second }, { record: otherProject })),
      { color: false, width: 140, height: 30, now: NOW_MS },
    );
    const afterRecords = [
      {
        record: {
          ...first,
          executionState: "cancelled" as const,
          attachmentState: "detached" as const,
          attentionState: "stopped" as const,
          exitCode: 0,
          updatedAt: "2026-07-22T10:05:00.000Z",
          meaningfulUpdatedAt: "2026-07-22T10:05:00.000Z",
        },
      },
      { record: second },
      {
        record: {
          ...otherProject,
          attentionState: "needs-input" as const,
          updatedAt: "2026-07-22T10:06:00.000Z",
          meaningfulUpdatedAt: "2026-07-22T10:06:00.000Z",
        },
      },
    ];
    const afterSnapshot = fleet(...afterRecords);
    const after = renderFleet(
      afterSnapshot,
      createFleetState(afterSnapshot),
      { color: false, width: 140, height: 30, now: NOW_MS },
    );
    // Before: 09:59, 09:58, 09:57 — the roster reads exactly in that order.
    expect(before.indexOf("First orchestrator")).toBeLessThan(before.indexOf("Second orchestrator"));
    expect(before.indexOf("Second orchestrator")).toBeLessThan(before.indexOf("Other project"));
    // After: the two that reported activity move to the front, newest first.
    expect(after.indexOf("Other project")).toBeLessThan(after.indexOf("First orchestrator"));
    expect(after.indexOf("First orchestrator")).toBeLessThan(after.indexOf("Second orchestrator"));
  });

  it("rejects a persisted provider tip instead of repeating it as the thread preview", () => {
    const snapshot = fleet({
      record: session({
        latestPreview: "Tip: Try the Desktop app. Run 'codex app' or visit",
      }),
      replay: "",
    });
    const rendered = renderFleet(snapshot, createFleetState(snapshot), {
      color: false,
      width: 120,
      height: 28,
      now: NOW_MS,
    });

    expect(rendered).toContain("No response yet");
    expect(rendered).not.toContain("Tip: Try the Desktop app");
  });

  it("uses provider activity for working but reserves Needs input for explicit blockers", () => {
    expect(threadStatus({
      record: session(),
      replay: "\u001b]0;⠹ cyberdeck\u0007",
    })).toBe("Working");
    expect(threadStatus({
      record: session(),
      replay: "\u001b]0;cyberdeck\u0007",
    })).toBe("Done");
    expect(threadStatus({
      record: session(),
      replay: "Do you trust the contents of this project?",
    })).toBe("Needs input");
    const approval = fleet({
      record: session({ provider: "claude", model: "opus" }),
      replay: [
        "Claude needs your permission to use Bash",
        "Do you want to proceed?",
        "❯ 1. Yes",
        "  2. No",
        "Esc to cancel · Tab to amend",
      ].join("\n"),
    });
    expect(threadStatus(approval.threads[0]!)).toBe("Needs input");
    const rendered = renderFleet(approval, createFleetState(approval), {
      color: false,
      width: 120,
      height: 28,
      now: NOW_MS,
    });
    expect(rendered).toContain("1 needs input");
    expect(rendered).toContain("Needs input");
    expect(threadStatus({
      record: session({ executionState: "failed" }),
      replay: "",
    })).toBe("Failed");
    expect(threadStatus({
      record: session({ executionState: "cancelled", exitCode: 0 }),
      replay: "",
    })).toBe("Stopped");
  });

  it("keeps a dedicated new-thread composer at the bottom with explicit launch context", () => {
    const snapshot = fleet({ record: session(), replay: "First line\r\nMost recent answer" });
    const rendered = renderFleet(snapshot, {
      ...createFleetState(snapshot),
      draft: "Inspect the failure",
      launchProfiles: {
        "/Users/brandon/code/personal/cyberdeck": {
          provider: "claude",
          model: "opus",
          effort: "high",
        },
      },
    }, {
      color: false,
      width: 100,
      height: 28,
      now: NOW_MS,
      home: "/Users/brandon",
    });

    const lines = rendered.split("\n");
    expect(lines.at(-4)).toBe("› Inspect the failure");
    expect(lines.at(-2)).toContain("▶ Claude Opus · high · read-only");
    expect(lines.at(-2)).toContain("cwd ~/code/personal/cyberdeck · ctrl+g change");
    expect(lines.at(-1)).toContain("enter open/start");
  });

  it("soft-wraps long composer drafts and expands the footer upward", () => {
    const snapshot = fleet({ record: session() });
    const draft = `${"a".repeat(47)}${"b".repeat(47)}${"c".repeat(10)}`;
    const rendered = renderFleet(snapshot, {
      ...createFleetState(snapshot),
      draft,
    }, {
      color: false,
      width: 50,
      height: 30,
      now: NOW_MS,
    });

    const lines = rendered.split("\n");
    expect(lines.at(-6)).toBe(`› ${"a".repeat(47)}`);
    expect(lines.at(-5)).toBe(`  ${"b".repeat(47)}`);
    expect(lines.at(-4)).toBe(`  ${"c".repeat(10)}`);
  });

  it("caps a large composer while keeping its newest wrapped rows visible", () => {
    const snapshot = fleet({ record: session() });
    const rendered = renderFleet(snapshot, {
      ...createFleetState(snapshot),
      draft: Array.from({ length: 15 }, (_, index) => `line ${index + 1}`).join("\n"),
    }, {
      color: false,
      width: 50,
      height: 30,
      now: NOW_MS,
    });

    const lines = rendered.split("\n");
    expect(lines.at(-13)).toBe("… line 6");
    expect(lines.at(-4)).toBe("  line 15");
    expect(rendered).not.toContain("line 5");
  });

  it("shows Ctrl+O as the first-class orchestrator command", () => {
    const snapshot = fleet({ record: session() });
    // Wide enough for the whole hint line: at 120 columns `fit` truncates its tail, which is what
    // the hint line is designed to do and not what this test is about.
    const rendered = renderFleet(snapshot, createFleetState(snapshot), {
      color: false,
      width: 140,
      height: 28,
      now: NOW_MS,
    });

    expect(rendered).toContain("ctrl+o to choose");
    expect(rendered.split("\n").at(-1)).toBe(
      "↑↓ · pgup/dn · ctrl+u/d half · home/end · enter open/start · ctrl+] detach/reattach · ctrl+n nvim · ? more · ctrl+x stop agent",
    );
  });

  it("preserves word boundaries from cursor-positioned provider output", () => {
    const snapshot = fleet({
      record: session(),
      replay: "-\u001b[5GCyberdeck\u001b[15Gis\u001b[18Ga\u001b[20Glocal\u001b[26Gbroker",
    });
    const rendered = renderFleet(snapshot, createFleetState(snapshot), {
      color: false,
      width: 160,
      height: 28,
      now: NOW_MS,
      home: "/Users/brandon",
    });

    expect(rendered).toContain("Cyberdeck is a local broker");
    expect(rendered).not.toContain("Cyberdeckisalocalbroker");
  });
});

describe("fleet controls", () => {
  it("walks a new model and effort then creates a distinct orchestrator", () => {
    const snapshot = fleet();
    const initial = createFleetState(snapshot, "/repo/one");
    const target = transitionFleet(initial, snapshot, "ctrl+o", NOW_MS);
    expect(target.state.orchestratorPicker).toMatchObject({ step: "target" });
    expect(renderFleet(snapshot, target.state, { color: false, width: 110, height: 30 }))
      .toContain("No interactive orchestrators");
    const effort = transitionFleet(target.state, snapshot, "enter", NOW_MS);
    expect(effort.state.orchestratorPicker).toMatchObject({ step: "effort" });
    const lowEffort = transitionFleet(effort.state, snapshot, "down", NOW_MS);
    const launched = transitionFleet(lowEffort.state, snapshot, "enter", NOW_MS);
    expect(launched.action).toEqual({
      type: "create-orchestrator",
      cockpitCwd: "/repo/one",
      request: {
        provider: "codex",
        model: "gpt-5.6-sol",
        effort: "low",
        cwd: "/repo/one",
        scope: "fleet",
      },
    });
    expect(launched.state.orchestratorPicker).toBeUndefined();
  });

  it("uses arrows in the picker and Escape moves back one step", () => {
    const snapshot = fleet();
    const initial = createFleetState(snapshot, "/repo/one");
    const target = transitionFleet(initial, snapshot, "ctrl+o", NOW_MS);
    const nextModel = transitionFleet(target.state, snapshot, "down", NOW_MS);
    const effort = transitionFleet(nextModel.state, snapshot, "enter", NOW_MS);
    const highEffort = transitionFleet(effort.state, snapshot, "down", NOW_MS);
    const back = transitionFleet(highEffort.state, snapshot, "escape", NOW_MS);

    expect(back.state.orchestratorPicker).toMatchObject({
      step: "target",
      choiceIndex: 1,
    });
  });

  it("switches to the exact selected existing orchestrator", () => {
    const current = session({
      id: "11111111-1111-4111-8111-111111111111",
      provider: "claude",
      model: "opus",
      effort: "high",
      kind: "orchestrator",
      role: "orchestrator",
      cwd: "/repo/one",
      orchestratorScope: "fleet",
      displayOrder: 0,
    });
    const peer = session({
      id: "22222222-2222-4222-8222-222222222222",
      provider: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
      kind: "orchestrator",
      role: "orchestrator",
      cwd: "/repo/one",
      orchestratorScope: "fleet",
      displayOrder: 1,
    });
    const snapshot = fleet({ record: current }, { record: peer });
    const opened = transitionFleet(createFleetState(snapshot, "/repo/one"), snapshot, "ctrl+o", NOW_MS);
    const selectedPeer = transitionFleet(opened.state, snapshot, "down", NOW_MS);
    const switched = transitionFleet(selectedPeer.state, snapshot, "enter", NOW_MS);

    expect(switched.action).toEqual({
      type: "open-orchestrator",
      sessionId: peer.id,
      cockpitCwd: "/repo/one",
      requiresResume: false,
    });
    expect(switched.state.selectedSessionId).toBe(peer.id);

    const reopened = transitionFleet(switched.state, snapshot, "ctrl+o", NOW_MS);
    const switchedBack = transitionFleet(reopened.state, snapshot, "enter", NOW_MS);
    expect(switchedBack.action).toEqual({
      type: "open-orchestrator",
      sessionId: current.id,
      cockpitCwd: "/repo/one",
      requiresResume: false,
    });
  });

  it("excludes workers and terminal orchestrators from the existing section", () => {
    const available = session({
      kind: "orchestrator",
      role: "orchestrator",
      name: "Available peer",
    });
    const worker = session({
      id: "22222222-2222-4222-8222-222222222222",
      kind: "worker",
      role: "worker",
      name: "Must not appear",
    });
    const ended = session({
      id: "33333333-3333-4333-8333-333333333333",
      kind: "orchestrator",
      role: "orchestrator",
      name: "Ended peer",
      executionState: "exited",
      exitCode: 0,
    });
    const snapshot = fleet({ record: available }, { record: worker }, { record: ended });
    const picker = transitionFleet(createFleetState(snapshot), snapshot, "ctrl+o", NOW_MS);
    const rendered = renderFleet(snapshot, picker.state, { color: false, width: 110, height: 30 });

    expect(rendered).toContain("Existing orchestrators");
    expect(rendered).toContain("Available peer");
    expect(rendered).toContain("New orchestrator");
    expect(rendered).not.toContain("Must not appear");
    expect(rendered).not.toContain("Ended peer");
  });

  it("labels a controller-held orchestrator and refuses to route somewhere else", () => {
    const controlled = session({
      kind: "orchestrator",
      role: "orchestrator",
      attachmentState: "controlled",
      name: "Busy peer",
    });
    const snapshot = fleet({ record: controlled });
    const opened = transitionFleet(createFleetState(snapshot), snapshot, "ctrl+o", NOW_MS);
    const rendered = renderFleet(snapshot, opened.state, { color: false, width: 110, height: 30 });
    const refused = transitionFleet(opened.state, snapshot, "enter", NOW_MS);

    expect(rendered).toContain("Busy peer");
    expect(rendered).toContain("in use");
    expect(refused.action).toBeUndefined();
    expect(refused.state.orchestratorPicker).toBeDefined();
    expect(refused.state.notice).toContain("another controller");
  });

  it("renders a fleet orchestrator independently of its process cwd", () => {
    const current = session({
      kind: "orchestrator",
      cwd: "/repo/one",
      orchestratorScope: "fleet",
    });
    const snapshot = fleet({ record: current });
    const rendered = renderFleet(snapshot, createFleetState(snapshot, "/repo/two"), {
      color: false,
      width: 110,
      height: 28,
      now: NOW_MS,
    });

    expect(rendered).toContain("provider-native-model · Provider managed · fleet");
    expect(rendered).not.toContain("provider-native-model · Provider managed · /repo/one");
  });

  it("decodes Ctrl+O without inserting it into the task composer", () => {
    expect(new FleetKeyDecoder().push(Buffer.from([0x0f]))).toEqual(["ctrl+o"]);
  });

  it("decodes Ctrl+] and attaches the exact selected orchestrator to the cockpit", () => {
    const decoder = new FleetKeyDecoder();
    expect(decoder.push(Buffer.from([0x1d]))).toEqual(["ctrl+]"]);
    expect(decoder.push(Buffer.from([0x1b]))).toEqual([]);
    expect(decoder.flush()).toEqual(["escape"]);

    const first = session({ kind: "orchestrator" });
    const second = session({
      id: "22222222-2222-4222-8222-222222222222",
      kind: "orchestrator",
    });
    const snapshot = fleet({ record: first }, { record: second });
    const selectedSecond = transitionFleet(createFleetState(snapshot), snapshot, "down", NOW_MS).state;

    expect(transitionFleet(selectedSecond, snapshot, "ctrl+]", NOW_MS).action).toEqual({
      type: "open-orchestrator",
      sessionId: second.id,
      cockpitCwd: process.cwd(),
      requiresResume: false,
    });
  });

  it("reaches the selected orchestrator with Ctrl+] while the Orcs header holds focus", () => {
    const orc = session({ kind: "orchestrator", role: "orchestrator", cwd: "/repo/one" });
    const snapshot = fleet({ record: orc });
    const folded: FleetState = {
      ...createFleetState(snapshot, "/repo/one"),
      collapsedCwds: ["/@orcs"],
    };

    const attached = transitionFleet(folded, snapshot, "ctrl+]", NOW_MS);

    expect(attached.state.focusedFolderCwd).toBe("/@orcs");
    expect(attached.action).toEqual({
      type: "open-orchestrator",
      sessionId: orc.id,
      cockpitCwd: "/repo/one",
      requiresResume: false,
    });
  });

  it("reaches the selected orchestrator with Ctrl+] while the show-more row holds focus", () => {
    const orcs = Array.from({ length: 6 }, (_unused, index) =>
      session({
        id: `${index + 1}${"1".repeat(7)}-1111-4111-8111-111111111111`,
        kind: "orchestrator",
        role: "orchestrator",
        cwd: "/repo/one",
        displayOrder: index,
      }));
    const hidden = orcs.at(-1)!;
    const snapshot = fleet(...orcs.map((record) => ({ record })));
    const capped: FleetState = {
      ...createFleetState(snapshot, "/repo/one"),
      selectedSessionId: hidden.id,
    };

    const attached = transitionFleet(capped, snapshot, "ctrl+]", NOW_MS);

    expect(attached.state.focusedShowMoreCwd).toBe("/@orcs");
    expect(attached.action).toEqual({
      type: "open-orchestrator",
      sessionId: hidden.id,
      cockpitCwd: "/repo/one",
      requiresResume: false,
    });
  });

  it("offers a starting orchestrator in the picker and opens it without a resume", () => {
    const starting = session({
      kind: "orchestrator",
      role: "orchestrator",
      name: "Booting peer",
      executionState: "starting",
      cwd: "/repo/one",
    });
    const snapshot = fleet({ record: starting });
    const opened = transitionFleet(createFleetState(snapshot, "/repo/one"), snapshot, "ctrl+o", NOW_MS);
    const rendered = renderFleet(snapshot, opened.state, { color: false, width: 110, height: 30 });

    expect(rendered).toContain("Booting peer");
    expect(rendered).toContain("starting");
    expect(transitionFleet(opened.state, snapshot, "enter", NOW_MS).action).toEqual({
      type: "open-orchestrator",
      sessionId: starting.id,
      cockpitCwd: "/repo/one",
      requiresResume: false,
    });
  });

  it("uses Ctrl+G for cwd navigation while leaving Tab unbound", () => {
    const decoder = new FleetKeyDecoder();
    expect(decoder.push(Buffer.from([0x07]))).toEqual(["ctrl+g"]);
    expect(decoder.push(Buffer.from([0x09]))).toEqual([]);

    const snapshot = fleet({ record: session({ cwd: "/repo/one" }) });
    expect(transitionFleet(createFleetState(snapshot), snapshot, "ctrl+g", NOW_MS).action).toEqual({
      type: "change-directory",
      cwd: "/repo/one",
    });
  });

  it("launches from the explicitly selected composer cwd rather than the selected thread cwd", () => {
    const snapshot = fleet({ record: session({ cwd: "/repo/one", sandbox: "workspace-write" }) });
    const state = {
      ...createFleetState(snapshot),
      workingDirectory: "/repo/two",
      draft: "Inspect the failure",
      launchProfiles: {
        "/repo/two": { provider: "codex" as const, model: "gpt-5.6-sol" },
      },
    };

    expect(transitionFleet(state, snapshot, "enter", NOW_MS).action).toEqual({
      type: "start",
      request: expect.objectContaining({
        cwd: "/repo/two",
        sandbox: "workspace-write",
        initialPrompt: "Inspect the failure",
      }),
    });
  });

  it("decodes shortcut-panel keys without leaking escape sequences into the composer", () => {
    const decoder = new FleetKeyDecoder();
    expect(decoder.push("\u001b[1;2A\u001b[1;2B\u001b1")).toEqual(["shift+up", "shift+down", "alt+1"]);
    expect(decoder.push(Buffer.from([0x0a, 0x0e, 0x12, 0x13, 0x14]))).toEqual([
      "ctrl+j", "ctrl+n", "ctrl+r", "ctrl+s", "ctrl+t",
    ]);
  });

  it("decodes page, half-page, Home, and End bindings", () => {
    const decoder = new FleetKeyDecoder();

    expect(decoder.push("\u001b[5~\u001b[6~\u001b[H\u001b[F")).toEqual([
      "pageup",
      "pagedown",
      "home",
      "end",
    ]);
    expect(decoder.push(Buffer.from([0x15, 0x04]))).toEqual(["ctrl+u", "ctrl+d"]);
  });

  it("names Ctrl+V rather than dropping it, and asks for the pasteboard without touching the frame", () => {
    expect(new FleetKeyDecoder().push(Buffer.from([0x16]))).toEqual(["ctrl+v"]);

    const snapshot = { threads: [] };
    const state = {
      ...createFleetState(snapshot),
      draft: "Read",
      notice: "Working directory: /repo",
      noticeTone: "neutral" as const,
    };
    const transition = transitionFleet(state, snapshot, "ctrl+v", NOW_MS);

    expect(transition.action).toEqual({ type: "attach-clipboard-image" });
    expect(transition.state).toEqual(state);
  });

  it("pages through rendered rows including folder headers, role headings, and group spacing", () => {
    const one = session({ cwd: "/repo/one", name: "One", displayOrder: 0 });
    const two = session({
      id: "22222222-2222-4222-8222-222222222222",
      cwd: "/repo/one",
      name: "Two",
      displayOrder: 1,
    });
    const three = session({
      id: "33333333-3333-4333-8333-333333333333",
      cwd: "/repo/two",
      name: "Three",
      displayOrder: 0,
    });
    const four = session({
      id: "44444444-4444-4444-8444-444444444444",
      cwd: "/repo/two",
      name: "Four",
      displayOrder: 1,
    });
    const snapshot = fleet(
      { record: one },
      { record: two },
      { record: three },
      { record: four },
    );
    const initial = createFleetState(snapshot);

    // Rows: folder /repo/one, "Workers", One, Two, spacer, folder /repo/two, "Workers", Three, Four.
    const pageDown = transitionFleet(initial, snapshot, "pagedown", NOW_MS, 4).state;
    expect(pageDown.focusedFolderCwd).toBe("/repo/two");
    expect(pageDown.threadListScrollOffset).toBe(2);

    const halfDown = transitionFleet(pageDown, snapshot, "ctrl+d", NOW_MS, 4).state;
    expect(halfDown.selectedSessionId).toBe(three.id);
    expect(halfDown.threadListScrollOffset).toBe(4);

    const pageUp = transitionFleet(halfDown, snapshot, "pageup", NOW_MS, 4).state;
    expect(pageUp.selectedSessionId).toBe(two.id);

    expect(transitionFleet(halfDown, snapshot, "home", NOW_MS, 4).state.focusedFolderCwd)
      .toBe("/repo/one");
    expect(transitionFleet(initial, snapshot, "end", NOW_MS, 4).state.selectedSessionId)
      .toBe(four.id);
  });

  it("decodes Option+Enter as one chord instead of an Escape followed by a submit", () => {
    const decoder = new FleetKeyDecoder();

    // Meta-sends-Escape encoding, whole read.
    expect(decoder.push("\u001b\r")).toEqual(["alt+enter"]);
    expect(decoder.push("\u001b\n")).toEqual(["alt+enter"]);
    // Keyboard-protocol encoding, which a provider TUI can leave switched on.
    expect(decoder.push("\u001b[13;3u")).toEqual(["alt+enter"]);
    expect(decoder.push("\u001b[13;2u")).toEqual(["shift+enter"]);
    expect(decoder.push("\u001b[13u")).toEqual(["enter"]);
    expect(decoder.push(Buffer.from([0x0d]))).toEqual(["enter"]);
  });

  it("names keyboard-protocol reports instead of swallowing them as anonymous sequences", () => {
    const decoder = new FleetKeyDecoder();

    expect(decoder.push("\u001b[27u")).toEqual(["escape"]);
    expect(decoder.push("\u001b[97u")).toEqual(["a"]);
    expect(decoder.push("\u001b[97;3u")).toEqual(["alt+a"]);
    expect(decoder.push("\u001b[50;3u")).toEqual(["alt+2"]);
    expect(decoder.push("\u001b[127u")).toEqual(["backspace"]);
  });

  it("keeps Option chords out of the composer and reads composed Option characters as text", () => {
    const decoder = new FleetKeyDecoder();

    // An unbound Meta chord does nothing at all: neither half may reach a binding or the draft.
    expect(decoder.push("\u001bb")).toEqual(["alt+b"]);
    expect(decoder.push("\u001b\u007f")).toEqual(["alt+backspace"]);
    // Option delivered as a composed character is ordinary text.
    expect(decoder.push("å")).toEqual(["å"]);
  });

  it("keeps Esc, arrow keys and function keys distinct at the same first byte", () => {
    const decoder = new FleetKeyDecoder();

    expect(decoder.push("\u001b[A")).toEqual(["up"]);
    expect(decoder.push("\u001b[1;2B")).toEqual(["shift+down"]);
    // SS3 function keys are consumed whole rather than typing their final byte into the draft.
    expect(decoder.push("\u001bOP")).toEqual([]);
    expect(decoder.hasPendingInput).toBe(false);
    // A repeated Esc stays an Esc rather than collapsing into a chord.
    expect(decoder.push("\u001b\u001b")).toEqual(["escape"]);
    expect(decoder.flush()).toEqual(["escape"]);
  });

  it("inserts a newline for Option+Enter and Shift+Enter without launching the draft", () => {
    const snapshot = fleet({ record: session({ cwd: "/repo/one", sandbox: "workspace-write" }) });
    const state = {
      ...createFleetState(snapshot),
      draft: "first",
      workingDirectory: "/repo/two",
      launchProfiles: { "/repo/two": { provider: "codex" as const, model: "gpt-5.6-sol" } },
    };

    const option = transitionFleet(state, snapshot, "alt+enter", NOW_MS);
    expect(option.state.draft).toBe("first\n");
    expect(option.action).toBeUndefined();

    const shift = transitionFleet(option.state, snapshot, "shift+enter", NOW_MS);
    expect(shift.state.draft).toBe("first\n\n");
    expect(shift.action).toBeUndefined();

    // Plain Enter still submits the composed draft.
    expect(transitionFleet(shift.state, snapshot, "enter", NOW_MS).action).toBeDefined();
  });

  it("consumes complete and fragmented terminal mouse reports instead of typing coordinates", () => {
    const decoder = new FleetKeyDecoder();

    expect(decoder.push("\u001b[<35;103;24M")).toEqual([]);
    expect(decoder.push("\u001b[<35;10")).toEqual([]);
    expect(decoder.hasPendingInput).toBe(true);
    expect(decoder.push("3;24Mhello")).toEqual(["h", "e", "l", "l", "o"]);
    expect(decoder.hasPendingInput).toBe(false);
  });

  it("buffers Escape briefly while preserving a literal Escape key", () => {
    const decoder = new FleetKeyDecoder();

    expect(decoder.push("\u001b")).toEqual([]);
    expect(decoder.flush()).toEqual(["escape"]);
  });

  it("opens a live provider TUI with Enter or Right Arrow and moves between project threads", () => {
    const first = session({ cwd: "/repo/one" });
    const second = session({ id: "22222222-2222-4222-8222-222222222222", cwd: "/repo/two" });
    const snapshot = fleet({ record: first }, { record: second });
    const initial = createFleetState(snapshot);

    expect(transitionFleet(initial, snapshot, "enter", NOW_MS).action).toEqual({
      type: "attach",
      sessionId: first.id,
    });
    expect(transitionFleet(initial, snapshot, "right", NOW_MS).action).toEqual({
      type: "attach",
      sessionId: first.id,
    });
    expect(transitionFleet(initial, snapshot, "left", NOW_MS).action).toBeUndefined();

    // Folder headers are navigable rows, so crossing projects steps onto the
    // header before reaching the next project's first thread.
    const onFolder = transitionFleet(initial, snapshot, "down", NOW_MS).state;
    expect(onFolder.focusedFolderCwd).toBe("/repo/two");
    expect(transitionFleet(onFolder, snapshot, "down", NOW_MS).state.selectedSessionId).toBe(second.id);
  });

  it("collapses and expands a focused folder with Enter and reports the hidden thread count", () => {
    const first = session({ cwd: "/repo/one" });
    const second = session({ id: "22222222-2222-4222-8222-222222222222", cwd: "/repo/two" });
    const snapshot = fleet({ record: first }, { record: second });
    const onFolder = transitionFleet(createFleetState(snapshot), snapshot, "down", NOW_MS).state;

    const collapsed = transitionFleet(onFolder, snapshot, "enter", NOW_MS).state;
    expect(collapsed.collapsedCwds).toEqual(["/repo/two"]);
    expect(renderFleet(snapshot, collapsed, { color: false, width: 100, height: 28, now: NOW_MS }))
      .toContain("▌ ▸ /repo/two · 1 thread");

    // The hidden threads are gone from the navigation model, not merely unpainted.
    expect(transitionFleet(collapsed, snapshot, "down", NOW_MS).state.focusedFolderCwd).toBe("/repo/two");

    const expanded = transitionFleet(collapsed, snapshot, "enter", NOW_MS).state;
    expect(expanded.collapsedCwds).toEqual([]);
    expect(transitionFleet(expanded, snapshot, "down", NOW_MS).state.selectedSessionId).toBe(second.id);
  });

  it("reports every fold as a persistable disposition, and repeats as nothing at all", () => {
    const second = session({ id: "22222222-2222-4222-8222-222222222222", cwd: "/repo/two" });
    const snapshot = fleet({ record: session({ cwd: "/repo/one" }) }, { record: second });
    const onFolder = transitionFleet(createFleetState(snapshot), snapshot, "down", NOW_MS).state;

    const collapsed = transitionFleet(onFolder, snapshot, "left", NOW_MS);
    expect(collapsed.action).toEqual({
      type: "folder-disposition",
      cwd: "/repo/two",
      disposition: { collapsed: true, expanded: false },
    });

    // Holding left against an already-folded folder is not a new decision to record.
    expect(transitionFleet(collapsed.state, snapshot, "left", NOW_MS).action).toBeUndefined();

    expect(transitionFleet(collapsed.state, snapshot, "right", NOW_MS).action).toEqual({
      type: "folder-disposition",
      cwd: "/repo/two",
      disposition: { collapsed: false, expanded: false },
    });
  });

  it("reports the Orcs roster fold under its own key so the roster stays folded across restarts", () => {
    const snapshot = orcFleet(2);
    const onHeader = transitionFleet(createFleetState(snapshot), snapshot, "home", NOW_MS).state;
    expect(onHeader.focusedFolderCwd).toBe("/@orcs");

    expect(transitionFleet(onHeader, snapshot, "left", NOW_MS).action).toEqual({
      type: "folder-disposition",
      cwd: "/@orcs",
      disposition: { collapsed: true, expanded: false },
    });
  });

  it("keeps thread keys inert while a folder header holds focus", () => {
    const second = session({ id: "22222222-2222-4222-8222-222222222222", cwd: "/repo/two" });
    const snapshot = fleet({ record: session() }, { record: second });
    const onFolder = transitionFleet(createFleetState(snapshot), snapshot, "down", NOW_MS).state;

    expect(transitionFleet(onFolder, snapshot, " ", NOW_MS).action).toBeUndefined();
    expect(transitionFleet(onFolder, snapshot, "ctrl+x", NOW_MS).action).toBeUndefined();
    expect(transitionFleet(onFolder, snapshot, "ctrl+t", NOW_MS).action).toBeUndefined();
  });

  it("resumes the exact provider conversation when a terminal thread is opened", () => {
    const stoppedRecord = session({ executionState: "cancelled", exitCode: 129 });
    const snapshot = fleet({ record: stoppedRecord });
    const initial = createFleetState(snapshot);

    expect(transitionFleet(initial, snapshot, "right", NOW_MS).action).toEqual({
      type: "resume",
      sessionId: stoppedRecord.id,
    });
    expect(transitionFleet(initial, snapshot, "enter", NOW_MS).action).toEqual({
      type: "resume",
      sessionId: stoppedRecord.id,
    });
  });

  it("stops a live agent, then requires two more Ctrl+X presses before deletion", () => {
    const active = fleet({ record: session() });
    const initial = createFleetState(active);
    const stop = transitionFleet(initial, active, "ctrl+x", NOW_MS);
    expect(stop.action).toEqual({ type: "stop", sessionId: session().id });
    expect(stop.state.deleteConfirmation).toBeUndefined();

    const stopped = fleet({ record: session({ executionState: "cancelled", exitCode: 0 }) });
    const armed = transitionFleet(stop.state, stopped, "ctrl+x", NOW_MS);
    expect(armed.action).toBeUndefined();
    expect(armed.state.deleteConfirmation?.sessionId).toBe(session().id);

    const rendered = renderFleet(stopped, armed.state, {
      color: true,
      width: 140,
      height: 30,
      now: NOW_MS,
      home: "/Users/brandon",
    });
    expect(rendered).toContain("Delete thread? press ctrl+x again");
    expect(rendered.match(/Delete thread\?/gu)).toHaveLength(1);

    const remove = transitionFleet(armed.state, stopped, "ctrl+x", NOW_MS + 1);
    expect(remove.action).toEqual({ type: "delete", sessionId: session().id });
  });

  it("stops an initially done thread before allowing the separate deletion sequence", () => {
    const done = fleet({
      record: session({
        executionState: "exited",
        attentionState: "done",
        exitCode: 0,
      }),
    });
    const initial = createFleetState(done);

    const stop = transitionFleet(initial, done, "ctrl+x", NOW_MS);
    expect(stop.action).toEqual({ type: "stop", sessionId: session().id });
    expect(stop.state.deleteConfirmation).toBeUndefined();
    expect(stop.state.notice).toBe("Stopping thread");
    expect(renderFleet(done, stop.state, { color: false, width: 160, height: 28 }))
      .toContain("ctrl+x delete thread");

    const armed = transitionFleet(stop.state, done, "ctrl+x", NOW_MS + 1);
    expect(armed.action).toBeUndefined();
    expect(armed.state.deleteConfirmation?.sessionId).toBe(session().id);
    expect(armed.state.notice).toBe("Delete thread? press ctrl+x again");

    const stopped = fleet({
      record: {
        ...done.threads[0]!.record,
        attentionState: "stopped",
      },
    });
    expect(threadStatus(stopped.threads[0]!)).toBe("Stopped");

    expect(transitionFleet(armed.state, done, "ctrl+x", NOW_MS + 2).action).toEqual({
      type: "delete",
      sessionId: session().id,
    });
  });

  it("stops and deletes only selected orchestrator, preserving its worker row", () => {
    const root = session({ kind: "orchestrator", childIds: ["22222222-2222-4222-8222-222222222222"] });
    const child = session({
      id: "22222222-2222-4222-8222-222222222222",
      kind: "worker",
      role: "worker",
      parentSessionId: root.id,
    });
    const active = fleet({ record: root }, { record: child });
    const stop = transitionFleet(createFleetState(active), active, "ctrl+x", NOW_MS);

    expect(stop.action).toEqual({ type: "stop", sessionId: root.id });
    expect(stop.state.notice).toBe("Stopping orchestrator");
    const stopping = renderFleet(active, stop.state, {
      color: true,
      width: 140,
      height: 30,
      now: NOW_MS,
      home: "/Users/brandon",
    });
    expect(stopping).toContain("\u001b[38;2;212;168;91mStopping orchestrator");

    const terminal = fleet(
      { record: { ...root, executionState: "cancelled", attentionState: "stopped", exitCode: 0 } },
      { record: { ...child, attentionState: "working" } },
    );
    const armed = transitionFleet(stop.state, terminal, "ctrl+x", NOW_MS);
    expect(armed.state.notice).toBe("Delete orchestrator? press ctrl+x again");
    const rendered = renderFleet(terminal, armed.state, {
      color: true,
      width: 140,
      height: 30,
      now: NOW_MS,
      home: "/Users/brandon",
    });
    expect(rendered).toContain("\u001b[38;2;217;108;117mDelete orchestrator? press ctrl+x again");
    expect(threadStatus(terminal.threads[1]!)).toBe("Working");
    expect(transitionFleet(armed.state, terminal, "ctrl+x", NOW_MS + 1).action).toEqual({
      type: "delete",
      sessionId: root.id,
    });
  });

  it("stops only selected orchestrator while worker remains independently selectable", () => {
    const root = session({
      kind: "orchestrator",
      executionState: "cancelled",
      attentionState: "stopping",
      exitCode: null,
      childIds: ["22222222-2222-4222-8222-222222222222"],
    });
    const child = session({
      id: "22222222-2222-4222-8222-222222222222",
      kind: "worker",
      parentSessionId: root.id,
      executionState: "cancelled",
      attentionState: "stopped",
      exitCode: 0,
    });
    const snapshot = fleet({ record: root }, { record: child });
    const retry = transitionFleet(createFleetState(snapshot), snapshot, "ctrl+x", NOW_MS);

    expect(retry.action).toEqual({ type: "stop", sessionId: root.id });
    expect(retry.state.notice).toBe("Stopping orchestrator");
    // The worker lives under its folder now, one header below the Orcs section.
    const onFolder = transitionFleet(retry.state, snapshot, "down", NOW_MS).state;
    expect(onFolder.focusedFolderCwd).toBe(child.cwd);
    expect(transitionFleet(onFolder, snapshot, "down", NOW_MS).state.selectedSessionId).toBe(child.id);
  });

  it("cancels pending deletion when selection moves or confirmation expires", () => {
    const second = session({
      id: "22222222-2222-4222-8222-222222222222",
      executionState: "cancelled",
      exitCode: 0,
    });
    const snapshot = fleet(
      { record: session({ executionState: "cancelled", exitCode: 0 }) },
      { record: second },
    );
    const stopped = transitionFleet(createFleetState(snapshot), snapshot, "ctrl+x", NOW_MS).state;
    const armed = transitionFleet(stopped, snapshot, "ctrl+x", NOW_MS + 1).state;
    expect(transitionFleet(armed, snapshot, "down", NOW_MS).state.deleteConfirmation).toBeUndefined();

    const expired = transitionFleet(armed, snapshot, "ctrl+x", NOW_MS + 6_000);
    expect(expired.action).toBeUndefined();
    expect(expired.state.deleteConfirmation?.expiresAt).toBe(NOW_MS + 11_000);
  });

  it("never carries a Ctrl+X deletion confirmation onto another session ID", () => {
    const stopped = session({
      executionState: "cancelled",
      attentionState: "stopped",
      exitCode: 0,
      displayOrder: 0,
    });
    const active = session({
      id: "22222222-2222-4222-8222-222222222222",
      displayOrder: 1,
    });
    const snapshot = fleet({ record: stopped }, { record: active });
    const stop = transitionFleet(createFleetState(snapshot), snapshot, "ctrl+x", NOW_MS);
    expect(stop.action).toEqual({ type: "stop", sessionId: stopped.id });
    const armed = transitionFleet(stop.state, snapshot, "ctrl+x", NOW_MS + 1);
    expect(armed.state.deleteConfirmation?.sessionId).toBe(stopped.id);

    const switched = transitionFleet(armed.state, snapshot, "alt+2", NOW_MS + 2);
    expect(switched.state.selectedSessionId).toBe(active.id);
    expect(switched.state.deleteConfirmation).toBeUndefined();

    const stopOther = transitionFleet(switched.state, snapshot, "ctrl+x", NOW_MS + 3);
    expect(stopOther.action).toEqual({ type: "stop", sessionId: active.id });
    expect(stopOther.state.deleteConfirmation).toBeUndefined();
  });

  it("requires two consecutive Ctrl+C presses and never exits on Escape", () => {
    const snapshot = fleet({ record: session() });
    const initial = createFleetState(snapshot);

    const armed = transitionFleet(initial, snapshot, "ctrl+c", NOW_MS);
    expect(armed.action).toBeUndefined();
    expect(armed.state.notice).toBe("Press ctrl+c again to exit");
    expect(armed.state.quitConfirmation?.expiresAt).toBe(NOW_MS + 5_000);

    const cancelled = transitionFleet(armed.state, snapshot, "?", NOW_MS + 1);
    expect(cancelled.state.quitConfirmation).toBeUndefined();
    expect(cancelled.state.notice).toBeUndefined();
    expect(transitionFleet(cancelled.state, snapshot, "ctrl+c", NOW_MS + 2).action).toBeUndefined();

    const confirmed = transitionFleet(armed.state, snapshot, "ctrl+c", NOW_MS + 1);
    expect(confirmed.action).toEqual({ type: "quit" });

    const expired = transitionFleet(armed.state, snapshot, "ctrl+c", NOW_MS + 5_001);
    expect(expired.action).toBeUndefined();
    expect(expired.state.quitConfirmation?.expiresAt).toBe(NOW_MS + 10_001);

    expect(transitionFleet(initial, snapshot, "escape", NOW_MS).action).toBeUndefined();
    const help = transitionFleet(initial, snapshot, "?", NOW_MS).state;
    const closedHelp = transitionFleet(help, snapshot, "escape", NOW_MS);
    expect(closedHelp.action).toBeUndefined();
    expect(closedHelp.state.helpOpen).toBe(false);
  });

  it("configures a new worker through /model then effort with no confirmation", () => {
    const snapshot = fleet({ record: session() });
    const command = { ...createFleetState(snapshot), draft: "/model" };
    const model = transitionFleet(command, snapshot, "enter", NOW_MS);
    expect(model.state.workerPicker).toMatchObject({ step: "model", modelIndex: 0 });
    const rendered = renderFleet(snapshot, model.state, { color: false, width: 100, height: 28 });
    expect(rendered).toContain("Codex Luna");
    expect(rendered).toContain("Claude Opus");
    expect(rendered).toContain("Claude Fable");
    expect(rendered).toContain("Cursor Composer");
    expect(rendered).toContain("Gemini 3.6 Flash");

    const effort = transitionFleet(model.state, snapshot, "enter", NOW_MS);
    expect(effort.state.workerPicker).toMatchObject({ step: "effort" });
    const medium = transitionFleet(effort.state, snapshot, "down", NOW_MS);
    const high = transitionFleet(medium.state, snapshot, "down", NOW_MS);
    const applied = transitionFleet(high.state, snapshot, "enter", NOW_MS);
    expect(applied.state.workerPicker).toBeUndefined();
    expect(applied.state.launchProfiles["/Users/brandon/code/personal/cyberdeck"]).toEqual({
      provider: "codex",
      model: "gpt-5.6-luna",
      effort: "high",
    });

    const typed = { ...applied.state, draft: "Inspect the failing test" };
    const submitted = transitionFleet(typed, snapshot, "enter", NOW_MS);

    expect(submitted.action).toEqual({
      type: "start",
      request: {
        provider: "codex",
        cwd: "/Users/brandon/code/personal/cyberdeck",
        detached: true,
        sandbox: "read-only",
        model: "gpt-5.6-luna",
        effort: "high",
        name: "Inspect the failing test",
        initialPrompt: "Inspect the failing test",
      },
    });
    expect(submitted.state.draft).toBe("");
  });

  it("opens slash palette only from an empty composer and filters commands", () => {
    const snapshot = fleet({ record: session() });
    const opened = transitionFleet(createFleetState(snapshot), snapshot, "/", NOW_MS);

    expect(opened.state.commandPalette).toMatchObject({
      level: "commands",
      selectedIndex: 0,
      scrollOffset: 0,
    });
    expect(renderFleet(snapshot, opened.state, {
      color: false,
      width: 100,
      height: 24,
    })).toContain("/permissions  Inspect or configure provider launch permissions");

    const filtered = [..."permissions"].reduce(
      (state, key) => transitionFleet(state, snapshot, key, NOW_MS).state,
      opened.state,
    );
    const rendered = renderFleet(snapshot, filtered, {
      color: false,
      width: 100,
      height: 24,
    });
    expect(rendered).toContain("/permissions");
    expect(rendered).not.toContain("/model  ");

    const existingDraft = { ...createFleetState(snapshot), draft: "task" };
    const appended = transitionFleet(existingDraft, snapshot, "/", NOW_MS).state;
    expect(appended.draft).toBe("task/");
    expect(appended.commandPalette).toBeUndefined();
  });

  it("navigates and scrolls slash commands, then Escape closes and clears them", () => {
    const snapshot = fleet({ record: session() });
    const opened = transitionFleet(createFleetState(snapshot), snapshot, "/", NOW_MS);
    const second = transitionFleet(opened.state, snapshot, "down", NOW_MS);
    const third = transitionFleet(second.state, snapshot, "down", NOW_MS);
    const fourth = transitionFleet(third.state, snapshot, "down", NOW_MS);

    expect(fourth.state.commandPalette).toMatchObject({
      selectedIndex: 3,
      scrollOffset: 1,
    });
    const rendered = renderFleet(snapshot, fourth.state, {
      color: false,
      width: 100,
      height: 24,
    });
    expect(rendered).toContain("2-4 of 5");
    expect(rendered).not.toContain("/model  ");

    expect(transitionFleet(fourth.state, snapshot, "escape", NOW_MS).state)
      .toMatchObject({ draft: "", commandPalette: undefined });
  });

  it("exposes nested command values and completes the selected value", () => {
    const orchestrator = session({
      kind: "orchestrator",
      cwd: "/repo/one",
      orchestratorScope: "workspace",
    });
    const snapshot = fleet({ record: orchestrator });
    const opened = transitionFleet(createFleetState(snapshot), snapshot, "/", NOW_MS);
    const permissions = transitionFleet(opened.state, snapshot, "down", NOW_MS);
    const fable = transitionFleet(permissions.state, snapshot, "down", NOW_MS);
    const values = transitionFleet(fable.state, snapshot, "enter", NOW_MS);

    expect(values.state).toMatchObject({
      draft: "/fable-workers ",
      commandPalette: { level: "values", command: "/fable-workers" },
    });
    expect(renderFleet(snapshot, values.state, {
      color: false,
      width: 100,
      height: 24,
    })).toContain("on  Enable Fable workers");

    const on = transitionFleet(values.state, snapshot, "down", NOW_MS);
    expect(transitionFleet(on.state, snapshot, "enter", NOW_MS)).toMatchObject({
      state: { draft: "", commandPalette: undefined },
      action: {
        type: "fable-workers",
        request: { cwd: "/repo/one", scope: "workspace", enabled: true },
      },
    });
  });

  it("inspects and persists explicit provider permission policies", () => {
    const snapshot = fleet({ record: session() });
    const command = { ...createFleetState(snapshot), draft: "/permissions" };
    const providers = transitionFleet(command, snapshot, "enter", NOW_MS);
    const claude = transitionFleet(providers.state, snapshot, "down", NOW_MS);
    const policies = transitionFleet(claude.state, snapshot, "enter", NOW_MS);
    const automatic = transitionFleet(policies.state, snapshot, "down", NOW_MS);
    const applied = transitionFleet(automatic.state, snapshot, "enter", NOW_MS);

    expect(renderFleet(snapshot, automatic.state, {
      color: false,
      width: 100,
      height: 24,
    })).toContain("automatic  auto mode · --permission-mode auto");
    expect(applied.state.permissionPolicies.claude).toBe("automatic");
    expect(applied.action).toEqual({
      type: "permission-policy",
      provider: "claude",
      policy: "automatic",
      previousPolicy: "permissioned",
    });
    expect(applied.state.notice).toBe("Claude permissions: auto mode");
  });

  it("fails visibly for an unsupported provider permission policy", () => {
    const snapshot = fleet({ record: session() });
    const command = { ...createFleetState(snapshot), draft: "/permissions" };
    let state = transitionFleet(command, snapshot, "enter", NOW_MS).state;
    state = transitionFleet(state, snapshot, "down", NOW_MS).state;
    state = transitionFleet(state, snapshot, "down", NOW_MS).state;
    state = transitionFleet(state, snapshot, "down", NOW_MS).state;
    state = transitionFleet(state, snapshot, "enter", NOW_MS).state;
    state = transitionFleet(state, snapshot, "down", NOW_MS).state;
    const refused = transitionFleet(state, snapshot, "enter", NOW_MS);

    expect(refused.action).toBeUndefined();
    expect(refused.state.permissionPicker).toMatchObject({
      step: "policy",
      providerIndex: 3,
      policyIndex: 1,
    });
    expect(refused.state.notice).toBe(
      "Antigravity does not support automatic permission policy",
    );
    expect(renderFleet(snapshot, refused.state, {
      color: false,
      width: 100,
      height: 24,
    })).toContain("Antigravity does not support automatic permission policy");
  });

  it("applies Composer automatic mode before submitting the initial prompt", async () => {
    const snapshot = fleet({ record: session({ provider: "cursor", model: "composer" }) });
    const state = {
      ...createFleetState(snapshot),
      draft: "Fix the failing test",
      permissionPolicies: {
        ...createFleetState(snapshot).permissionPolicies,
        cursor: "automatic" as const,
      },
      launchProfiles: {
        "/Users/brandon/code/personal/cyberdeck": {
          provider: "cursor",
          model: "composer",
        },
      },
    };
    const transition = transitionFleet(state, snapshot, "enter", NOW_MS);
    expect(transition.action).toMatchObject({
      type: "start",
      permissionLaunch: {
        provider: "cursor",
        policy: "automatic",
        nativeMode: "/run-everything",
        application: {
          kind: "post-launch-command",
          command: "/run-everything",
        },
      },
    });

    const started = session({
      id: "22222222-2222-4222-8222-222222222222",
      provider: "cursor",
      model: "composer",
    });
    const request = vi.fn(async (method: string, _params: unknown) => {
      if (method === "session.startWithPrompt") return started;
      throw new Error(`unexpected ${method}`);
    });
    await expect(startFleetSession(
      { request } as never,
      transition.action as Extract<NonNullable<typeof transition.action>, { type: "start" }>,
    )).resolves.toEqual(started);

    expect(request.mock.calls.map(([method, params]) => [method, params])).toEqual([
      [
        "session.startWithPrompt",
        expect.objectContaining({
          provider: "cursor",
          model: "composer",
          cwd: "/Users/brandon/code/personal/cyberdeck",
          approvalMode: "auto",
          initialPrompt: "Fix the failing test",
        }),
      ],
    ]);
  });

  it("applies persisted Codex automatic mode to newly spawned sessions", () => {
    const snapshot = fleet({ record: session({ provider: "codex" }) });
    const state = {
      ...createFleetState(snapshot),
      draft: "Run the checks",
      permissionPolicies: {
        ...createFleetState(snapshot).permissionPolicies,
        codex: "automatic" as const,
      },
      launchProfiles: {
        "/Users/brandon/code/personal/cyberdeck": {
          provider: "codex",
          model: "gpt-5.6-sol",
        },
      },
    };

    expect(transitionFleet(state, snapshot, "enter", NOW_MS).action).toMatchObject({
      type: "start",
      request: {
        provider: "codex",
        model: "gpt-5.6-sol",
        approvalMode: "auto",
        initialPrompt: "Run the checks",
      },
    });
  });

  it("opens /model instead of parsing provider syntax when no launch profile exists", () => {
    const snapshot = fleet();
    const initial = { ...createFleetState(snapshot, "/repo/empty"), draft: "Fix the failing test" };
    const picker = transitionFleet(initial, snapshot, "enter", NOW_MS);
    expect(picker.action).toBeUndefined();
    expect(picker.state.workerPicker).toMatchObject({ cwd: "/repo/empty", returnDraft: "Fix the failing test" });
  });

  it("routes /fable-workers on to the selected durable orchestrator binding", () => {
    const orchestrator = session({
      kind: "orchestrator",
      provider: "claude",
      model: "fable",
      cwd: "/repo/one",
      orchestratorScope: "workspace",
    });
    const snapshot = fleet({ record: orchestrator });
    const state = { ...createFleetState(snapshot), draft: "/fable-workers on" };

    expect(transitionFleet(state, snapshot, "enter", NOW_MS)).toMatchObject({
      state: { draft: "" },
      action: {
        type: "fable-workers",
        request: { cwd: "/repo/one", scope: "workspace", enabled: true },
      },
    });
  });

  it("routes /caveman-workers on to the box preference without an orchestrator", () => {
    const snapshot = fleet();
    const state = { ...createFleetState(snapshot), draft: "/caveman-workers on" };

    expect(transitionFleet(state, snapshot, "enter", NOW_MS)).toMatchObject({
      state: { draft: "" },
      action: {
        type: "caveman-workers",
        request: { enabled: true },
      },
    });
  });

  it("reports and toggles machine-local automatic nvim layout", () => {
    const snapshot = fleet();
    const on = createFleetState(snapshot);
    const status = transitionFleet(
      { ...on, draft: "/nvim-settings status" },
      snapshot,
      "enter",
      NOW_MS,
    );
    expect(status.action).toBeUndefined();
    expect(status.state.notice).toBe("Automatic nvim layout: ON");

    expect(transitionFleet(
      { ...on, nvimLayoutEnabled: false, draft: "/nvim-settings on" },
      snapshot,
      "enter",
      NOW_MS,
    )).toMatchObject({
      state: { draft: "" },
      action: { type: "nvim-layout", enabled: true },
    });
    expect(transitionFleet(
      { ...on, draft: "/nvim-settings status" },
      snapshot,
      "enter",
      NOW_MS,
    ).state.notice).toBe("Automatic nvim layout: ON");
    expect(transitionFleet(
      { ...on, draft: "/nvim-settings off" },
      snapshot,
      "enter",
      NOW_MS,
    ).action).toEqual({ type: "nvim-layout", enabled: false });
  });

  it("reports the missing orchestrator instead of treating /fable-workers as a task", () => {
    const snapshot = fleet();
    const state = { ...createFleetState(snapshot), draft: "/fable-workers status" };
    const transition = transitionFleet(state, snapshot, "enter", NOW_MS);

    expect(transition.action).toBeUndefined();
    expect(transition.state.notice).toContain("No orchestrator is bound");
  });

  it("toggles the shortcut panel and exposes keyboard interactions", () => {
    const snapshot = fleet({ record: session() });
    const open = transitionFleet(createFleetState(snapshot), snapshot, "?", NOW_MS);
    const rendered = renderFleet(snapshot, open.state, { color: false, width: 120, height: 30 });
    expect(rendered).toContain("shift+↑↓ reorder");
    expect(rendered).toContain("ctrl+r rename");
    expect(rendered).toContain("ctrl+t pin to top");
    expect(rendered).toContain("ctrl+n nvim");
    expect(transitionFleet(open.state, snapshot, "?", NOW_MS).state.helpOpen).toBe(false);
  });

  it("opens the selected worker's worktree in nvim on ctrl+n", () => {
    const worker = session({ kind: "worker" });
    const snapshot = fleet({ record: worker });
    const transition = transitionFleet(createFleetState(snapshot), snapshot, "ctrl+n", NOW_MS);

    expect(transition.action).toEqual({ type: "open-worktree", sessionId: worker.id });
    expect(transition.state.notice).toBeUndefined();
  });

  it("declines to open an Orc's cwd, which no agent is rewriting", () => {
    const orc = session({ kind: "orchestrator" });
    const snapshot = fleet({ record: orc });
    const transition = transitionFleet(createFleetState(snapshot), snapshot, "ctrl+n", NOW_MS);

    expect(transition.action).toBeUndefined();
    expect(transition.state.notice).toBe("Select a worker to open its worktree in nvim");
  });

  it("maps rename, pin, reorder, view, mention, and numbered-open shortcuts", () => {
    const second = session({ id: "22222222-2222-4222-8222-222222222222", name: "Second thread" });
    const snapshot = fleet({ record: session() }, { record: second });
    const initial = createFleetState(snapshot);

    expect(transitionFleet(initial, snapshot, "ctrl+t", NOW_MS).action).toEqual({
      type: "pin", sessionId: session().id,
    });
    expect(transitionFleet(initial, snapshot, "shift+down", NOW_MS).action).toEqual({
      type: "reorder", sessionId: session().id, direction: "down",
    });
    expect(transitionFleet(initial, snapshot, "alt+2", NOW_MS).action).toEqual({
      type: "attach", sessionId: second.id,
    });
    expect(transitionFleet(initial, snapshot, "ctrl+s", NOW_MS).state.view).toBe("diagnostics");
    expect(transitionFleet(initial, snapshot, "@", NOW_MS).state.draft).toContain("@Implement-modular");

    const renaming = transitionFleet(initial, snapshot, "ctrl+r", NOW_MS);
    expect(renaming.state.rename?.sessionId).toBe(session().id);
    expect(transitionFleet(renaming.state, snapshot, "enter", NOW_MS).action).toEqual({
      type: "rename",
      sessionId: session().id,
      name: "Implement modular cryptographic scheme",
    });
  });
});

describe("collectFleetSnapshot", () => {
  it("loads replay for every durable session", async () => {
    const record = session();
    const request = vi.fn(async (method: string) => {
      if (method === "session.list") return [record];
      if (method === "session.snapshot") return { data: Buffer.from("latest").toString("base64") };
      throw new Error(`unexpected ${method}`);
    });

    await expect(collectFleetSnapshot({ request } as never)).resolves.toEqual({
      threads: [{ record, replay: "latest" }],
    });
    expect(request).toHaveBeenCalledWith("session.snapshot", { sessionId: record.id });
  });

  it("joins broker lease projection onto matching worker sessions", async () => {
    const record = session({
      id: "22222222-2222-4222-8222-222222222222",
      kind: "worker",
      role: "worker",
    });
    const ownership = coordination(record.id, "contested");
    const request = vi.fn(async (method: string) => {
      if (method === "session.list") return [record];
      if (method === "fleet.workerCoordination") return [ownership];
      if (method === "session.snapshot") return { data: Buffer.from("latest").toString("base64") };
      throw new Error(`unexpected ${method}`);
    });

    await expect(collectFleetSnapshot({ request } as never)).resolves.toEqual({
      threads: [{ record, replay: "latest", coordination: ownership }],
    });
  });

  it("takes a worker's custody hue from the projection and an orc's from its binding", async () => {
    const orc = session();
    const workerRecord = session({
      id: "22222222-2222-4222-8222-222222222222",
      kind: "worker",
      role: "worker",
    });
    const ownership = {
      ...coordination(workerRecord.id, "released"),
      custodyColor: { slot: 3, intensity: "faded" as const },
    };
    const request = vi.fn(async (method: string) => {
      if (method === "session.list") return [orc, workerRecord];
      if (method === "fleet.workerCoordination") return [ownership];
      if (method === "fleet.custodyColors") return [{ sessionId: orc.id, slot: 1 }];
      if (method === "session.snapshot") return { data: Buffer.from("latest").toString("base64") };
      throw new Error(`unexpected ${method}`);
    });

    await expect(collectFleetSnapshot({ request } as never)).resolves.toEqual({
      threads: [
        // An orchestrator wears its own slot, and is always live on it.
        { record: orc, replay: "latest", custodyColor: { slot: 1, intensity: "active" } },
        {
          record: workerRecord,
          replay: "latest",
          coordination: ownership,
          custodyColor: { slot: 3, intensity: "faded" },
        },
      ],
    });
  });

  it("leaves every row neutral when the broker cannot answer for custody colors", async () => {
    const record = session();
    const request = vi.fn(async (method: string) => {
      if (method === "session.list") return [record];
      if (method === "fleet.custodyColors") throw new Error("unknown method");
      if (method === "session.snapshot") return { data: Buffer.from("latest").toString("base64") };
      throw new Error(`unexpected ${method}`);
    });

    await expect(collectFleetSnapshot({ request } as never)).resolves.toEqual({
      threads: [{ record, replay: "latest" }],
    });
  });
});

describe("runFleet", () => {
  it("visibly applies a Ctrl+G cwd selection before launch", async () => {
    class Input extends EventEmitter {
      isTTY = true;
      isRaw = false;
      setRawMode(raw: boolean): this { this.isRaw = raw; return this; }
      resume(): this { return this; }
      pause(): this { return this; }
    }
    class Output {
      isTTY = false;
      columns = 120;
      rows = 30;
      chunks: Buffer[] = [];
      write(chunk: string | Uint8Array): boolean {
        this.chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
        return true;
      }
    }
    const closeListeners = new Set<() => void>();
    const transport = {
      request: vi.fn(async (method: string) => {
        if (method === "session.list") return [];
        if (method === "fleet.preferences") return {};
        throw new Error(`unexpected ${method}`);
      }),
      sendFrame: vi.fn(),
      onFrame: vi.fn(() => () => undefined),
      onClose(listener: () => void) { closeListeners.add(listener); return () => closeListeners.delete(listener); },
      close: vi.fn(),
    };
    const input = new Input();
    const output = new Output();
    const changeDirectory = vi.fn(async () => "/repo/two");
    const running = runFleet(
      transport as never,
      input,
      output,
      new EventEmitter(),
      { changeDirectory, detachIdentity: "operator:one" },
    );
    await vi.waitFor(() => expect(input.isRaw).toBe(true));

    input.emit("data", Buffer.from([0x07]));
    await vi.waitFor(() => expect(changeDirectory).toHaveBeenCalledWith(process.cwd()));
    await vi.waitFor(() => expect(Buffer.concat(output.chunks).toString()).toContain(
      "cwd /repo/two · ctrl+g change",
    ));

    input.emit("data", Buffer.from([0x1d]));
    await vi.waitFor(() => expect(Buffer.concat(output.chunks).toString()).toContain(
      "Select a detached orchestrator to attach to the cockpit",
    ));

    input.emit("data", Buffer.from([0x03, 0x03]));
    await expect(running).resolves.toBeUndefined();
  });

  it("creates and presents a second independent orchestrator through the cockpit", async () => {
    class Input extends EventEmitter {
      isTTY = true;
      isRaw = false;
      setRawMode(raw: boolean): this { this.isRaw = raw; return this; }
      resume(): this { return this; }
      pause(): this { return this; }
    }
    class Output {
      isTTY = false;
      columns = 120;
      rows = 30;
      write(_chunk: string | Uint8Array): boolean { return true; }
    }

    const current = session({
      id: "11111111-1111-4111-8111-111111111111",
      kind: "orchestrator",
      role: "orchestrator",
      provider: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
      attachmentState: "detached",
    });
    const created = session({
      id: "22222222-2222-4222-8222-222222222222",
      kind: "orchestrator",
      role: "orchestrator",
      provider: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
      attachmentState: "detached",
    });
    const sessions = [current];
    const closeListeners = new Set<() => void>();
    const transport = {
      request: vi.fn(async (method: string) => {
        if (method === "session.list") return sessions;
        if (method === "session.snapshot") return { data: "" };
        if (method === "fleet.preferences") return {};
        throw new Error(`unexpected ${method}`);
      }),
      sendFrame: vi.fn(),
      onFrame: vi.fn(() => () => undefined),
      onClose(listener: () => void) {
        closeListeners.add(listener);
        return () => closeListeners.delete(listener);
      },
      close: vi.fn(),
    };
    const input = new Input();
    const openOrchestrator = vi.fn(async () => {
      sessions.push(created);
      return created;
    });
    const running = runFleet(
      transport as never,
      input,
      new Output(),
      new EventEmitter(),
      { detachIdentity: "operator:one", openOrchestrator },
    );
    await vi.waitFor(() => expect(input.isRaw).toBe(true));

    input.emit("data", Buffer.from([0x0f]));
    input.emit("data", Buffer.from("\u001b[B\r"));
    input.emit("data", Buffer.from("\u001b[B\u001b[B\u001b[B\r"));
    await vi.waitFor(() => expect(openOrchestrator).toHaveBeenCalledWith({
      type: "create",
      cockpitCwd: process.cwd(),
      request: {
        provider: "codex",
        model: "gpt-5.6-sol",
        effort: "high",
        cwd: process.cwd(),
        scope: "fleet",
      },
    }));
    expect(current.executionState).toBe("active");
    expect(current.id).not.toBe(created.id);
    expect(sessions).toEqual([current, created]);

    await vi.waitFor(() => expect(input.isRaw).toBe(true));
    input.emit("data", Buffer.from([0x03, 0x03]));
    await expect(running).resolves.toBeUndefined();
  });

  it("attaches the selected detached orchestrator to the cockpit", async () => {
    class Input extends EventEmitter {
      isTTY = true;
      isRaw = false;
      setRawMode(raw: boolean): this { this.isRaw = raw; return this; }
      resume(): this { return this; }
      pause(): this { return this; }
    }
    class Output {
      isTTY = false;
      columns = 120;
      rows = 30;
      chunks: Buffer[] = [];
      write(chunk: string | Uint8Array): boolean {
        this.chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
        return true;
      }
    }

    const first = session({
      kind: "orchestrator",
      name: "First orchestrator",
      displayOrder: 0,
    });
    const second = session({
      id: "22222222-2222-4222-8222-222222222222",
      kind: "orchestrator",
      name: "Second orchestrator",
      displayOrder: 1,
    });
    const closeListeners = new Set<() => void>();
    const transport = {
      request: vi.fn(async (method: string) => {
        if (method === "session.list") return [first, second];
        if (method === "session.snapshot") return { data: "" };
        if (method === "fleet.preferences") return {};
        throw new Error(`unexpected ${method}`);
      }),
      sendFrame: vi.fn(),
      onFrame: vi.fn(() => () => undefined),
      onClose(listener: () => void) { closeListeners.add(listener); return () => closeListeners.delete(listener); },
      close: vi.fn(),
    };
    const input = new Input();
    const output = new Output();
    const openOrchestrator = vi.fn(async () => second);
    const running = runFleet(
      transport as never,
      input,
      output,
      new EventEmitter(),
      { detachIdentity: "operator:one", openOrchestrator },
    );

    await vi.waitFor(() => expect(transport.request).toHaveBeenCalledWith("session.list", {}));
    await vi.waitFor(() => expect(input.isRaw).toBe(true));
    input.emit("data", Buffer.from("\u001b[B"));
    input.emit("data", Buffer.from([0x1d]));
    await vi.waitFor(() => expect(openOrchestrator).toHaveBeenCalledWith({
      type: "existing",
      session: second,
      cockpitCwd: process.cwd(),
      requiresResume: false,
    }));
    expect(transport.request).not.toHaveBeenCalledWith("fleet.reattach", expect.anything());

    await vi.waitFor(() => expect(input.isRaw).toBe(true));
    input.emit("data", Buffer.from([0x03, 0x03]));

    await expect(running).resolves.toBeUndefined();
    expect(transport.close).toHaveBeenCalledOnce();
  });

  it("hands the selected worker to the nvim opener and shows what it reported", async () => {
    class Input extends EventEmitter {
      isTTY = true;
      isRaw = false;
      setRawMode(raw: boolean): this { this.isRaw = raw; return this; }
      resume(): this { return this; }
      pause(): this { return this; }
    }
    class Output {
      isTTY = false;
      columns = 120;
      rows = 30;
      chunks: Buffer[] = [];
      write(chunk: string | Uint8Array): boolean {
        this.chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
        return true;
      }
    }

    const worker = session({ cwd: "/repo/one", role: "worker", kind: "worker", name: "One worker" });
    const closeListeners = new Set<() => void>();
    const transport = {
      request: vi.fn(async (method: string) => {
        if (method === "session.list") return [worker];
        if (method === "session.snapshot") return { data: "" };
        if (method === "fleet.preferences") return {};
        throw new Error(`unexpected ${method}`);
      }),
      sendFrame: vi.fn(),
      onFrame: vi.fn(() => () => undefined),
      onClose(listener: () => void) { closeListeners.add(listener); return () => closeListeners.delete(listener); },
      close: vi.fn(),
    };
    const input = new Input();
    const output = new Output();
    const openWorktree = vi.fn(async () => "One worker opened in %2 · 3 changes · read-only while it runs");
    const running = runFleet(
      transport as never,
      input,
      output,
      new EventEmitter(),
      { detachIdentity: "operator:one", openWorktree },
    );

    await vi.waitFor(() => expect(transport.request).toHaveBeenCalledWith("session.list", {}));
    await vi.waitFor(() => expect(input.isRaw).toBe(true));
    input.emit("data", Buffer.from([0x0e]));

    await vi.waitFor(() => expect(openWorktree).toHaveBeenCalledWith(worker, {
      enabled: true,
      orchestratorSessionIds: [],
    }));
    await vi.waitFor(() => expect(
      Buffer.concat(output.chunks).toString("utf8"),
    ).toContain("read-only while it runs"));

    input.emit("data", Buffer.from([0x03, 0x03]));
    await expect(running).resolves.toBeUndefined();
  });

  it("starts with the folds the operator last left, and writes each new one back", async () => {
    class Input extends EventEmitter {
      isTTY = true;
      isRaw = false;
      setRawMode(raw: boolean): this { this.isRaw = raw; return this; }
      resume(): this { return this; }
      pause(): this { return this; }
    }
    class Output {
      isTTY = false;
      columns = 120;
      rows = 30;
      chunks: Buffer[] = [];
      write(chunk: string | Uint8Array): boolean {
        this.chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
        return true;
      }
    }

    const first = session({ cwd: "/repo/one", role: "worker", kind: "worker", name: "One worker" });
    const second = session({
      id: "22222222-2222-4222-8222-222222222222",
      cwd: "/repo/two",
      role: "worker",
      kind: "worker",
      name: "Two worker",
    });
    const closeListeners = new Set<() => void>();
    const transport = {
      request: vi.fn(async (method: string) => {
        if (method === "session.list") return [first, second];
        if (method === "session.snapshot") return { data: "" };
        if (method === "fleet.preferences") return {};
        if (method === "fleet.folderDispositions") {
          return { "/repo/two": { collapsed: true, expanded: false } };
        }
        if (method === "fleet.folderDisposition.set") return { saved: true };
        throw new Error(`unexpected ${method}`);
      }),
      sendFrame: vi.fn(),
      onFrame: vi.fn(() => () => undefined),
      onClose(listener: () => void) { closeListeners.add(listener); return () => closeListeners.delete(listener); },
      close: vi.fn(),
    };
    const input = new Input();
    const output = new Output();
    const running = runFleet(transport as never, input, output, new EventEmitter());
    await vi.waitFor(() => expect(input.isRaw).toBe(true));

    // The persisted fold is in force before the operator touches anything.
    await vi.waitFor(() => {
      const screen = Buffer.concat(output.chunks).toString();
      expect(screen).toContain("▸ /repo/two");
      expect(screen).not.toContain("Two worker");
    });

    input.emit("data", Buffer.from("\u001b[B"));
    input.emit("data", Buffer.from("\u001b[C"));
    await vi.waitFor(() => expect(transport.request).toHaveBeenCalledWith("fleet.folderDisposition.set", {
      key: "/repo/two",
      disposition: { collapsed: false, expanded: false },
    }));

    input.emit("data", Buffer.from([0x03, 0x03]));
    await expect(running).resolves.toBeUndefined();
  });

  it("places the cursor on the final soft-wrapped composer row", async () => {
    class Input extends EventEmitter {
      isTTY = true;
      isRaw = false;
      setRawMode(raw: boolean): this { this.isRaw = raw; return this; }
      resume(): this { return this; }
      pause(): this { return this; }
    }
    class Output {
      isTTY = false;
      columns = 50;
      rows = 30;
      chunks: Buffer[] = [];
      write(chunk: string | Uint8Array): boolean {
        this.chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
        return true;
      }
    }

    const record = session();
    const closeListeners = new Set<() => void>();
    const transport = {
      request: vi.fn(async (method: string) => {
        if (method === "session.list") return [record];
        if (method === "session.snapshot") return { data: "" };
        throw new Error(`unexpected ${method}`);
      }),
      sendFrame: vi.fn(),
      onFrame: vi.fn(() => () => undefined),
      onClose(listener: () => void) {
        closeListeners.add(listener);
        return () => closeListeners.delete(listener);
      },
      close: vi.fn(),
    };
    const input = new Input();
    const output = new Output();
    const running = runFleet(transport as never, input, output, new EventEmitter());
    await vi.waitFor(() => expect(input.isRaw).toBe(true));

    input.emit("data", Buffer.from(`${"a".repeat(47)}${"b".repeat(13)}`));
    await vi.waitFor(() => {
      const screen = Buffer.concat(output.chunks).toString();
      expect(screen).toContain(`› ${"a".repeat(47)}\n  ${"b".repeat(13)}`);
      expect(screen).toContain("\u001b[27;16H\u001b[?25h");
    });

    input.emit("data", Buffer.from([0x03, 0x03]));
    await expect(running).resolves.toBeUndefined();
  });

  it("stops a detached orchestrator on the first Ctrl+X without deleting it", async () => {
    class Input extends EventEmitter {
      isTTY = true;
      isRaw = false;
      setRawMode(raw: boolean): this { this.isRaw = raw; return this; }
      resume(): this { return this; }
      pause(): this { return this; }
    }
    class Output {
      isTTY = false;
      columns = 120;
      rows = 30;
      write(_chunk: string | Uint8Array): boolean { return true; }
    }

    const orchestrator = session({
      kind: "orchestrator",
      executionState: "active",
      attachmentState: "detached",
      detached: true,
      exitCode: null,
    });
    const closeListeners = new Set<() => void>();
    const transport = {
      request: vi.fn(async (method: string) => {
        if (method === "session.list") return [orchestrator];
        if (method === "session.snapshot") return { data: "" };
        if (method === "session.stopOne") return { stopped: true };
        throw new Error(`unexpected ${method}`);
      }),
      sendFrame: vi.fn(),
      onFrame: vi.fn(() => () => undefined),
      onClose(listener: () => void) { closeListeners.add(listener); return () => closeListeners.delete(listener); },
      close: vi.fn(),
    };
    const input = new Input();
    const running = runFleet(transport as never, input, new Output(), new EventEmitter());
    await vi.waitFor(() => expect(input.isRaw).toBe(true));

    input.emit("data", Buffer.from([0x18]));
    await vi.waitFor(() => expect(transport.request).toHaveBeenCalledWith("session.stopOne", {
      sessionId: orchestrator.id,
    }));
    expect(transport.request).not.toHaveBeenCalledWith("session.deleteTree", expect.anything());

    input.emit("data", Buffer.from([0x03, 0x03]));
    await expect(running).resolves.toBeUndefined();
  });

  it("keeps the selector at the deleted row position instead of resetting to the top", async () => {
    class Input extends EventEmitter {
      isTTY = true;
      isRaw = false;
      setRawMode(raw: boolean): this { this.isRaw = raw; return this; }
      resume(): this { return this; }
      pause(): this { return this; }
    }
    class Output {
      isTTY = false;
      columns = 100;
      rows = 30;
      chunks: Buffer[] = [];
      write(chunk: string | Uint8Array): boolean {
        this.chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
        return true;
      }
    }

    const first = session({
      name: "First thread",
      executionState: "cancelled",
      attentionState: "stopped",
      exitCode: 0,
      displayOrder: 0,
    });
    const second = session({
      id: "22222222-2222-4222-8222-222222222222",
      name: "Second thread",
      executionState: "cancelled",
      attentionState: "stopped",
      exitCode: 0,
      displayOrder: 1,
    });
    const third = session({
      id: "33333333-3333-4333-8333-333333333333",
      name: "Third thread",
      executionState: "cancelled",
      attentionState: "stopped",
      exitCode: 0,
      displayOrder: 2,
    });
    let records = [first, second, third];
    const transport = {
      request: vi.fn(async (method: string, params: { sessionId?: string }) => {
        if (method === "session.list") return records;
        if (method === "session.snapshot") return { data: "" };
        if (method === "session.stopOne") return { stopped: true };
        if (method === "session.delete") {
          records = records.filter((record) => record.id !== params.sessionId);
          return { deleted: true };
        }
        throw new Error(`unexpected ${method}`);
      }),
      sendFrame: vi.fn(),
      onFrame: vi.fn(() => () => undefined),
      onClose: vi.fn(() => () => undefined),
      close: vi.fn(),
    };
    const input = new Input();
    const output = new Output();
    const running = runFleet(transport as never, input, output, new EventEmitter());
    await vi.waitFor(() => expect(input.isRaw).toBe(true));

    input.emit("data", Buffer.from("\u001b[B"));
    input.emit("data", Buffer.from([0x18, 0x18, 0x18]));
    await vi.waitFor(() => expect(transport.request).toHaveBeenCalledWith("session.delete", {
      sessionId: second.id,
    }));
    await vi.waitFor(() => {
      const latestScreen = Buffer.concat(output.chunks).toString().split("\u001b[2J\u001b[H").at(-1) ?? "";
      expect(latestScreen).toContain("Deleted thread");
      expect(latestScreen).toContain("▌ · Third thread");
      expect(latestScreen).not.toContain("▌ · First thread");
    });

    input.emit("data", Buffer.from([0x03, 0x03]));
    await expect(running).resolves.toBeUndefined();
  });

  it("splices a pasted image path into the composer and leaves the draft alone without one", async () => {
    class Input extends EventEmitter {
      isTTY = true;
      isRaw = false;
      setRawMode(raw: boolean): this { this.isRaw = raw; return this; }
      resume(): this { return this; }
      pause(): this { return this; }
    }
    class Output {
      isTTY = false;
      columns = 120;
      rows = 30;
      chunks: Buffer[] = [];
      write(chunk: string | Uint8Array): boolean {
        this.chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
        return true;
      }
    }
    const closeListeners = new Set<() => void>();
    const transport = {
      request: vi.fn(async (method: string) => {
        if (method === "session.list") return [];
        if (method === "fleet.preferences") return {};
        throw new Error(`unexpected ${method}`);
      }),
      sendFrame: vi.fn(),
      onFrame: vi.fn(() => () => undefined),
      onClose(listener: () => void) { closeListeners.add(listener); return () => closeListeners.delete(listener); },
      close: vi.fn(),
    };
    const input = new Input();
    const output = new Output();
    let pasted: string | undefined = "/state/Application Support/Cyberdeck/pasted-images/paste-a.png";
    const pasteboardImage = vi.fn(async () => pasted);
    const running = runFleet(
      transport as never,
      input,
      output,
      new EventEmitter(),
      { pasteboardImage },
    );
    await vi.waitFor(() => expect(input.isRaw).toBe(true));

    input.emit("data", Buffer.from("Read"));
    input.emit("data", Buffer.from([0x16]));
    await vi.waitFor(() => {
      const latestScreen = Buffer.concat(output.chunks).toString().split("\u001b[2J\u001b[H").at(-1) ?? "";
      expect(latestScreen).toContain(
        "Read \"/state/Application Support/Cyberdeck/pasted-images/paste-a.png\"",
      );
      expect(latestScreen).toContain("Attached paste-a.png");
    });

    // A pasteboard holding text or nothing must not disturb the frame the operator is looking at.
    pasted = undefined;
    output.chunks.length = 0;
    input.emit("data", Buffer.from([0x16]));
    await vi.waitFor(() => expect(pasteboardImage).toHaveBeenCalledTimes(2));
    const afterEmptyPaste = Buffer.concat(output.chunks).toString().split("\u001b[2J\u001b[H").at(-1) ?? "";
    expect(afterEmptyPaste).toContain(
      "Read \"/state/Application Support/Cyberdeck/pasted-images/paste-a.png\"",
    );
    expect(afterEmptyPaste).toContain("Attached paste-a.png");

    input.emit("data", Buffer.from([0x03, 0x03]));
    await expect(running).resolves.toBeUndefined();
  });

  it("installs and removes the nvim hook on toggle, then removes it again on clean shutdown", async () => {
    class Input extends EventEmitter {
      isTTY = true;
      isRaw = false;
      setRawMode(raw: boolean): this { this.isRaw = raw; return this; }
      resume(): this { return this; }
      pause(): this { return this; }
    }
    class Output {
      isTTY = false;
      columns = 120;
      rows = 30;
      write(_chunk: string | Uint8Array): boolean { return true; }
    }
    const transport = {
      request: vi.fn(async (method: string, params?: { enabled?: boolean }) => {
        if (method === "session.list") return [];
        if (method === "fleet.preferences") return {};
        if (method === "fleet.folderDispositions") return {};
        if (method === "fleet.nvimLayout") return false;
        if (method === "fleet.nvimLayout.set") return { saved: params?.enabled };
        throw new Error(`unexpected ${method}`);
      }),
      sendFrame: vi.fn(),
      onFrame: vi.fn(() => () => undefined),
      onClose: vi.fn(() => () => undefined),
      close: vi.fn(),
    };
    const hooks = {
      install: vi.fn(),
      rebalance: vi.fn(),
      remove: vi.fn(),
    };
    const input = new Input();
    const running = runFleet(
      transport as never,
      input,
      new Output(),
      new EventEmitter(),
      {
        nvimLayoutHooks: hooks,
        permissionPreferences: {
          list: async () => ({}),
          set: async () => {},
        },
      },
    );
    await vi.waitFor(() => expect(input.isRaw).toBe(true));

    input.emit("data", Buffer.from("/nvim-settings on\r"));
    await vi.waitFor(() => expect(hooks.install).toHaveBeenCalledWith([]));
    await vi.waitFor(() => expect(transport.request).toHaveBeenCalledWith(
      "fleet.nvimLayout.set",
      { enabled: true },
    ));

    input.emit("data", Buffer.from("/nvim-settings off\r"));
    await vi.waitFor(() => expect(transport.request).toHaveBeenCalledWith(
      "fleet.nvimLayout.set",
      { enabled: false },
    ));
    expect(hooks.remove).toHaveBeenCalledTimes(1);

    input.emit("data", Buffer.from("/nvim-settings on\r"));
    await vi.waitFor(() => expect(hooks.install).toHaveBeenCalledTimes(2));
    input.emit("data", Buffer.from([0x03, 0x03]));
    await expect(running).resolves.toBeUndefined();
    expect(hooks.remove).toHaveBeenCalledTimes(2);
  });
});
