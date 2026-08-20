import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { SessionRecord } from "../../src/domain/session.js";
import {
  appendShellOutput,
  collectFleetSnapshot,
  composerCursor,
  createFleetState,
  FleetKeyDecoder,
  renderFleet,
  runFleet,
  startFleetSession,
  threadIdentity,
  threadStatus,
  transitionFleet,
  workerModelCatalog,
  adoptWorkerModels,
  type FleetSnapshot,
  type FleetState,
} from "../../src/client/fleet.js";
import {
  OCTOPUS_MARK,
  OCTOPUS_SPLASH,
  pixelArtWidth,
  renderPixelArt,
} from "../../src/client/octopus.js";
import type { PasteboardImageResult } from "../../src/client/clipboard-image.js";
import { displayWidth } from "../../src/client/display-width.js";
import type { PullRequestState, PullRequestSummary } from "../../src/client/pr-status.js";
import type { FleetWorkerCoordinationView } from "../../src/broker/worker-coordination-view.js";
import { HANDOFF_LIMITS } from "../../src/domain/worker-handoff.js";

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

/**
 * What `SessionRegistry.stop()` really does to a record.
 *
 * A live session is moved to cancelled/stopping while its process is still being torn down; a
 * session that has already exited is simply marked stopped. Every mock of `session.stopOne` here
 * routes through this, so a picker test cannot pass against a stop that leaves the row untouched —
 * which is exactly how the picker shipped a filter that dropped the row it had just stopped.
 */
function registryStop(record: SessionRecord): SessionRecord {
  const stoppedAt = "2026-07-22T10:05:00.000Z";
  return record.exitCode !== null
    ? { ...record, attentionState: "stopped", updatedAt: stoppedAt }
    : { ...record, executionState: "cancelled", attentionState: "stopping", updatedAt: stoppedAt };
}

/** The provider process exiting after that graceful stop, which is what makes the row terminal. */
function registryExit(record: SessionRecord): SessionRecord {
  return { ...record, exitCode: 0, attentionState: "stopped" };
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

  it("groups a Cyberdeck-provisioned sibling worktree under its repository and names it", () => {
    // The worktree is a sibling of the repository, not a directory inside it, so nothing about the
    // cwd puts the thread under its project. `workspace.repositoryPath` is what does, and the
    // worktree column falls back to the worktree's own basename.
    const worker = session({
      id: "22222222-2222-4222-8222-222222222222",
      kind: "worker",
      role: "worker",
      cwd: "/repo-mik-75",
      name: "Provisioned",
      workspace: {
        worktreePath: "/repo-mik-75",
        repositoryPath: "/repo",
        branch: "cyberdeck/mik-75",
        baseRef: "HEAD",
        provisioning: "cyberdeck-provisioned",
        writableRoots: [],
      },
    });
    const snapshot: FleetSnapshot = { ...fleet({ record: worker }), projects: ["/repo"] };
    const lines = renderFleet(snapshot, createFleetState(snapshot), {
      color: false, width: 150, height: 30, now: NOW_MS,
    }).split("\n");
    const lineOf = (needle: string) => lines.findIndex((line) => line.includes(needle));

    expect(lineOf("▾ /repo")).toBeGreaterThanOrEqual(0);
    expect(lines.some((line) => line.includes("Unregistered"))).toBe(false);
    expect(lineOf("▾ /repo")).toBeLessThan(lineOf("Provisioned"));
    expect(lines[lineOf("Provisioned")]).toContain("repo-mik-75");
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

  it("floats every pinned worker above the unpinned ones, however new their activity", () => {
    // A pin that only broke ties lost its place to the first sibling that reported newer activity,
    // which is the same as not having pinned at all. The pin outranks recency outright; recency
    // still orders each group internally.
    const workerAt = (index: number, name: string, updatedAt: string, pinned?: boolean) => session({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      kind: "worker",
      role: "worker",
      cwd: "/repo/one",
      name,
      createdAt: "2026-07-22T09:00:00.000Z",
      updatedAt,
      ...(pinned === undefined ? {} : { pinned }),
    });
    const snapshot = fleet(
      { record: workerAt(1, "Pinned stale", "2026-07-22T09:10:00.000Z", true) },
      { record: workerAt(2, "Loud unpinned", "2026-07-22T09:59:00.000Z") },
      { record: workerAt(3, "Pinned newer", "2026-07-22T09:20:00.000Z", true) },
      // Explicitly unpinned rather than absent: the two spellings must rank together.
      { record: workerAt(4, "Quiet unpinned", "2026-07-22T09:30:00.000Z", false) },
    );
    const rendered = renderFleet(snapshot, createFleetState(snapshot), {
      color: false, width: 140, height: 30, now: NOW_MS,
    });
    const at = (name: string) => rendered.indexOf(name);

    expect(at("Pinned newer")).toBeLessThan(at("Pinned stale"));
    expect(at("Pinned stale")).toBeLessThan(at("Loud unpinned"));
    expect(at("Loud unpinned")).toBeLessThan(at("Quiet unpinned"));
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
    const printed = (line: string) => [...line.replace(/\u001b\[[0-9;]*m/gu, "")].length;
    for (const color of [false, true]) {
      const rendered = renderFleet(snapshot, createFleetState(snapshot), {
        color, width, height: 30, now: NOW_MS, home: "/Users/brandon",
      });
      expect(Math.max(...rendered.split("\n").map(printed))).toBeLessThanOrEqual(width);
      // A cut inside painted text closes its own color rather than leaking it down the pane.
      if (color) {
        for (const line of rendered.split("\n")) {
          const opens = line.match(/\u001b\[(?!0m)[0-9;]*m/gu)?.length ?? 0;
          expect(line.match(/\u001b\[0m/gu)?.length ?? 0).toBe(opens);
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

  it("tags a worker row only when the broker contradicts itself", () => {
    const snapshot = leaseFleet();
    const rendered = renderFleet(snapshot, createFleetState(snapshot), {
      color: false,
      width: 220,
      height: 50,
      now: NOW_MS,
      home: "/Users/brandon",
    });
    const lines = rendered.split("\n");
    // Every unowned lease is now silent on the row. `legacy` and `adoptable` were on nearly every
    // worker and named no move the operator could make, so the width goes back to model and state.
    const badges: Record<(typeof LEASE_STATES)[number], string | undefined> = {
      active: undefined,
      expired: undefined,
      released: undefined,
      orphaned: undefined,
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

  it("paints the surviving badge in the alert hue", () => {
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

    expect(row("contested")).toContain("\u001b[38;2;217;108;117mconflict");
    // The two tones the unowned states used to wear have nothing left to paint.
    expect(row("released")).not.toContain("\u001b[2munowned");
    expect(row("orphaned")).not.toContain("\u001b[38;2;212;168;91madoptable");
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

  it("keeps the per-row badge on the contradicting worker and nothing on its neighbour", () => {
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
          id: second, kind: "worker", role: "worker", name: "Contested worker", displayOrder: 1,
        }),
        coordination: coordination(second, "contested"),
      },
    );
    const lines = renderFleet(snapshot, createFleetState(snapshot), {
      color: false, width: 220, height: 50, now: NOW_MS, home: "/Users/brandon",
    }).split("\n");

    // The two disagree, so the group has no rollup to state — and the row that survives the
    // disagreement is the one an operator would act on.
    expect(lines.some((line) => line.includes("Workers ("))).toBe(false);
    expect(lines.find((line) => line.includes("Legacy worker"))!).not.toContain("legacy");
    expect(lines.find((line) => line.includes("Contested worker"))!).toContain("conflict");
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
    // `~` marks a launch value: neither of these sessions has a provider transcript naming
    // a running model, so the column shows what they were started with and says as much.
    expect(rendered).toContain("~Claude Provider Na…");
    expect(rendered).toContain("~Codex Another Mode…");
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
    // The preview yields to the model column at this width, rather than the other way round:
    // which agent is on a thread outranks the first words of what it last said.
    expect(doneLine).toContain("The lates");
    expect(doneLine).toContain("~Claude Provi");
    expect(doneLine).toContain("Done");
    expect(doneLine).not.toContain("\n");
    expect(doneLine).toHaveLength(76);
    expect(needsInputLine).toHaveLength(76);
    expect(doneLine).toMatch(/14s$/u);
    expect(needsInputLine).toMatch(/ 2m$/u);
  });

  it("spends a narrowing row on the model and the state, and drops the worktree name first", () => {
    // The order columns yield in: the worktree name goes first — the folder above already said
    // where the thread lives — and the model and the state never go at all. They are what an
    // operator reads a row for: which agent is on this, and is it moving.
    const worker = session({
      id: "22222222-2222-4222-8222-222222222222",
      kind: "worker",
      role: "worker",
      cwd: "/repo-mik-76",
      name: "A worker whose name is far wider than a split pane",
      model: "opus",
      attentionState: "done",
      workspace: {
        worktreePath: "/repo-mik-76",
        repositoryPath: "/repo",
        branch: "cyberdeck/mik-76",
        baseRef: "HEAD",
        provisioning: "cyberdeck-provisioned",
        writableRoots: [],
      },
    });
    const snapshot: FleetSnapshot = { ...fleet({ record: worker }), projects: ["/repo"] };
    const rowAt = (width: number) => renderFleet(snapshot, createFleetState(snapshot), {
      color: false, width, height: 30, now: NOW_MS,
    }).split("\n").find((line) => line.includes("Claude Opus"))!;

    const wide = rowAt(140);
    expect(wide).toContain("repo-mik-76");
    expect(wide).toContain("Done");

    // At the 50-column dense-layout breakpoint, model and state still outrank worktree metadata.
    const narrow = rowAt(50);
    expect(narrow).not.toContain("repo-mik-76");
    expect(narrow).toContain("Done");
    expect(narrow.length).toBeLessThanOrEqual(50);
  });

  describe("pull request column", () => {
    const FIRST_ID = "11111111-1111-4111-8111-111111111111";
    const SECOND_ID = "22222222-2222-4222-8222-222222222222";
    const first = session({ id: FIRST_ID, name: "Ship indicator", cwd: "/repo/one", displayOrder: 0 });
    const second = session({
      id: SECOND_ID,
      name: "No branch yet",
      cwd: "/repo/two",
      displayOrder: 1,
    });
    const snapshot = fleet({ record: first }, { record: second });

    const pr = (state: PullRequestState, number: number): PullRequestSummary => ({ state, number });

    const render = (pullRequests: Map<string, PullRequestSummary>, width = 120): string =>
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

      expect(row).not.toMatch(/#\d/u);
      expect(row).toHaveLength(120);
    });

    it("shows the number for the thread with a pull request and nothing for the one without", () => {
      const rendered = render(new Map([[FIRST_ID, pr("open", 123)]]));
      const withPr = rowFor(rendered, "Ship indicator");
      const withoutPr = rowFor(rendered, "No branch yet");

      expect(withPr).toContain("#123");
      expect(withoutPr).not.toMatch(/#\d/u);
      // The empty cell still holds the column open so rows stay aligned.
      expect(withoutPr).toHaveLength(120);
      expect(withPr).toHaveLength(120);
    });

    it("is keyed by thread, so one thread's pull request never lights up another", () => {
      // Both threads could share a checkout; only the one that owns the branch
      // the pull request was opened from is credited with it. This is MIK-86.
      const rendered = render(new Map([[SECOND_ID, pr("open", 88)]]));

      expect(rowFor(rendered, "No branch yet")).toContain("#88");
      expect(rowFor(rendered, "Ship indicator")).not.toMatch(/#\d/u);
    });

    it("puts the number between the preview and the time", () => {
      const rendered = render(new Map([[FIRST_ID, pr("open", 123)]]));
      const row = rowFor(rendered, "Ship indicator");

      expect(row).toMatch(/#123 +\S+$/u);
      // Everything the row says about what the thread is doing comes first.
      expect(row.indexOf("#123")).toBeGreaterThan(row.indexOf("Claude"));
    });

    it("keeps the column exactly as wide as the widest number on screen", () => {
      const narrow = render(new Map([[FIRST_ID, pr("open", 7)]]));
      const wide = render(new Map([[FIRST_ID, pr("open", 7)], [SECOND_ID, pr("merged", 1204)]]));

      // `#7` costs two cells; a `#1204` elsewhere in the fleet widens the column
      // to five and right-aligns the shorter number under it.
      expect(rowFor(narrow, "Ship indicator")).toMatch(/[^#]#7 +\S+$/u);
      expect(rowFor(wide, "Ship indicator")).toMatch(/ {3}#7 +\S+$/u);
      expect(rowFor(wide, "No branch yet")).toContain("#1204");
    });

    it("paints the number with the tone of its state", () => {
      const paintedWith = (state: PullRequestState): string =>
        renderFleet(snapshot, createFleetState(snapshot), {
          color: true,
          width: 120,
          height: 28,
          now: NOW_MS,
          pullRequests: new Map([[FIRST_ID, pr(state, 9)]]),
        });

      expect(paintedWith("checks-failing")).toContain("\u001b[38;2;217;108;117m#9\u001b[0m");
      expect(paintedWith("merged")).toContain("\u001b[38;2;198;120;221m#9\u001b[0m");
      expect(paintedWith("open")).toContain("\u001b[38;2;120;198;121m#9\u001b[0m");
    });

    it("keeps the column at narrow widths, where the title is what yields instead", () => {
      const rendered = render(new Map([[FIRST_ID, pr("merged", 42)]]), 60);
      const row = rowFor(rendered, "Ship indic");

      expect(row).toContain("#42");
      expect(row).toHaveLength(60);
      expect(rowFor(rendered, "No branch")).toHaveLength(60);
    });

    it("ignores pull request state for threads not on screen", () => {
      const rendered = render(new Map([["99999999-9999-4999-8999-999999999999", pr("open", 5)]]));

      expect(rowFor(rendered, "Ship indicator")).not.toMatch(/#\d/u);
    });

    it("budgets the conflict badge before the pull-request column at a narrow width", () => {
      // MIK-63/76 regression: a `#1` anywhere in the fleet used to win the optional-column
      // budget outright at 61 columns, leaving no room for the one badge that flags a broker
      // inconsistency — so a lone contested worker rendered with neither a group rollup nor a
      // row badge, invisible unless the operator already knew to open lease detail.
      const contestedId = "33333333-3333-4333-8333-333333333333";
      const snapshot: FleetSnapshot = fleet(
        { record: first },
        { record: second },
        {
          record: session({
            id: contestedId,
            kind: "worker",
            role: "worker",
            name: "Contested worker",
            cwd: "/repo/three",
            displayOrder: 2,
          }),
          coordination: coordination(contestedId, "contested"),
        },
      );
      const rendered = renderFleet(snapshot, createFleetState(snapshot), {
        color: false,
        // 63, not the original 61: MIK-85's owner sigil is budgeted ahead of every optional
        // column, and the contested worker's held lease earns it one, so the two cells it costs
        // come off the top. The ordering this test guards — badge before pull request when only
        // one of them fits — is unchanged; it just starts two columns later.
        width: 63,
        height: 28,
        now: NOW_MS,
        home: "/Users/brandon",
        pullRequests: new Map([[FIRST_ID, pr("open", 1)]]),
      });
      // The title column is squeezed to its floor at this width, so the row's own name is
      // truncated below "Contested worker" — the badge is what has to survive, not the title.
      const rows = rendered.split("\n");
      const badgeRow = rows.find((line) => line.includes("conflict"));

      expect(badgeRow).toBeDefined();
      expect(badgeRow).toHaveLength(63);
      expect(rows.some((line) => /#1\b/u.test(line))).toBe(false);
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
    // Five threads plus the folder header and its "Workers" heading fill the viewport exactly —
    // once the four-row header and the footer have taken their share of these seventeen rows.
    const exact = threadFleet(5);
    const exactState = {
      ...createFleetState(exact),
      threadListScrollOffset: 99,
    };
    const exactRendered = renderFleet(exact, exactState, {
      color: false,
      width: 100,
      height: 17,
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

  it("gives an empty fleet the whole octopus, and drops it whole when the pane is short", () => {
    const snapshot = fleet();
    const state = createFleetState(snapshot);
    const splash = renderPixelArt(OCTOPUS_SPLASH, false);

    const tall = renderFleet(snapshot, state, {
      color: false, width: 100, height: 40, now: NOW_MS,
    });
    for (const line of splash) expect(tall).toContain(line);
    expect(tall).toContain("No durable agent threads yet.");

    // Half an octopus reads as a rendering fault rather than as art, so there is no cropped
    // version of it: a pane with no room keeps the sentence and nothing else.
    const short = renderFleet(snapshot, state, {
      color: false, width: 100, height: 16, now: NOW_MS,
    });
    expect(short).toContain("No durable agent threads yet.");
    expect(short).not.toContain(splash[0]);
  });

  it("stands the header mark beside the header text, and drops it in a narrow pane", () => {
    const snapshot = fleet({ record: session({ cwd: "/repo/one" }) });
    const state = createFleetState(snapshot);
    const mark = renderPixelArt(OCTOPUS_MARK, false);

    const lines = renderFleet(snapshot, state, {
      color: false, width: 100, height: 30, now: NOW_MS,
    }).split("\n");
    expect(lines.slice(0, mark.length).map((line) => line.slice(0, pixelArtWidth(OCTOPUS_MARK))))
      .toEqual(mark);
    expect(lines[0]).toContain("Cyberdeck");

    // The mark is four rows to the text's three, so the header is as tall as the animal.
    expect(lines[mark.length - 1]?.trim()).toBe(mark.at(-1)?.trim());

    const narrow = renderFleet(snapshot, state, {
      color: false, width: 60, height: 30, now: NOW_MS,
    });
    expect(narrow.split("\n")[0]).toBe("Cyberdeck");
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
    expect(lines.at(-2)).toContain("cwd ~/code/personal/cyberdeck · ctrl+s change");
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
      "↑↓ · pgup/dn · alt+k/j half · home/end · enter open/start · ctrl+] detach/reattach · ctrl+n nvim · ? more · ctrl+x stop agent",
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
      focus: { kind: "profile", modelIndex: 1 },
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

  it("excludes workers from the existing section but keeps terminal orchestrators, labelled", () => {
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
    // A finished orchestrator is still a row — ctrl+x has to be able to reach it to delete it —
    // but it wears its outcome rather than the "available" a joinable orchestrator wears.
    const endedRow = rendered.split("\n").find((line) => line.includes("Ended peer"));
    expect(endedRow).toBeDefined();
    expect(endedRow).toContain("done");
    expect(endedRow).not.toContain("available");
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

  it("stops a selected existing orchestrator from the picker via Ctrl+X, then walks the same delete ladder", () => {
    const peer = session({ kind: "orchestrator", role: "orchestrator", name: "Peer orc" });
    const snapshot = fleet({ record: peer });
    const opened = transitionFleet(createFleetState(snapshot), snapshot, "ctrl+o", NOW_MS);

    const stop = transitionFleet(opened.state, snapshot, "ctrl+x", NOW_MS);
    expect(stop.action).toEqual({ type: "stop", sessionId: peer.id });
    expect(stop.state.notice).toBe("Stopping orchestrator");
    expect(stop.state.orchestratorPicker).toMatchObject({
      step: "target",
      focus: { kind: "existing", sessionId: peer.id },
      stopAcknowledgement: { sessionId: peer.id },
    });

    // The record the broker actually hands back: cancelled/stopping while the process is still
    // dying, then stopped once it exits. The row has to survive both to be deletable.
    const stoppingSnapshot = fleet({ record: registryStop(peer) });
    expect(renderFleet(stoppingSnapshot, stop.state, { color: false, width: 140, height: 30 }))
      .toContain("Peer orc");

    const terminalSnapshot = fleet({ record: registryExit(registryStop(peer)) });
    const stoppedRow = renderFleet(terminalSnapshot, stop.state, { color: false, width: 140, height: 30 })
      .split("\n")
      .find((line) => line.includes("Peer orc"));
    expect(stoppedRow).toContain("stopped");

    const armed = transitionFleet(stop.state, terminalSnapshot, "ctrl+x", NOW_MS + 1);
    expect(armed.action).toBeUndefined();
    expect(armed.state.orchestratorPicker).toMatchObject({
      deleteConfirmation: { sessionId: peer.id },
    });
    const rendered = renderFleet(terminalSnapshot, armed.state, { color: false, width: 140, height: 30 });
    expect(rendered).toContain("Delete orchestrator? press ctrl+x again");

    const confirmed = transitionFleet(armed.state, terminalSnapshot, "ctrl+x", NOW_MS + 2);
    expect(confirmed.action).toEqual({ type: "delete", sessionId: peer.id });
  });

  it("holds the ladder on the stopped orchestrator when the stop reorders the picker's list", () => {
    const target = session({
      id: "11111111-1111-4111-8111-111111111111",
      kind: "orchestrator",
      role: "orchestrator",
      name: "Target orc",
      updatedAt: "2026-07-22T10:00:00.000Z",
    });
    const neighbour = session({
      id: "22222222-2222-4222-8222-222222222222",
      kind: "orchestrator",
      role: "orchestrator",
      name: "Neighbour orc",
      updatedAt: "2026-07-22T09:00:00.000Z",
    });
    const before = fleet({ record: target }, { record: neighbour });
    const opened = transitionFleet(createFleetState(before), before, "ctrl+o", NOW_MS);

    const stop = transitionFleet(opened.state, before, "ctrl+x", NOW_MS);
    expect(stop.action).toEqual({ type: "stop", sessionId: target.id });

    // The picker orders on recency, so any activity anywhere reshuffles it between two presses.
    // Were the ladder keyed on a row number, both remaining presses would land on Neighbour orc.
    const after = fleet(
      { record: registryExit(registryStop(target)) },
      { record: { ...neighbour, updatedAt: "2026-07-22T10:10:00.000Z" } },
    );
    const rows = renderFleet(after, stop.state, { color: false, width: 140, height: 30 }).split("\n");
    expect(rows.findIndex((line) => line.includes("Target orc")))
      .toBeGreaterThan(rows.findIndex((line) => line.includes("Neighbour orc")));
    expect(rows.find((line) => line.includes("Target orc"))).toContain("›");

    const armed = transitionFleet(stop.state, after, "ctrl+x", NOW_MS + 1);
    expect(armed.state.orchestratorPicker).toMatchObject({
      deleteConfirmation: { sessionId: target.id },
    });
    const confirmed = transitionFleet(armed.state, after, "ctrl+x", NOW_MS + 2);
    expect(confirmed.action).toEqual({ type: "delete", sessionId: target.id });
  });

  it("arms and deletes an already-terminal orchestrator against the broker's own stop transition", () => {
    const ended = session({
      kind: "orchestrator",
      role: "orchestrator",
      name: "Ended orc",
      executionState: "exited",
      attentionState: "done",
      exitCode: 0,
    });
    const before = fleet({ record: ended });
    const opened = transitionFleet(createFleetState(before), before, "ctrl+o", NOW_MS);

    const stop = transitionFleet(opened.state, before, "ctrl+x", NOW_MS);
    expect(stop.action).toEqual({ type: "stop", sessionId: ended.id });

    // `SessionRegistry.stop()` on a record that already has an exit code only rewrites its
    // attention to stopped. The row stays, and the ladder carries on from it.
    const after = fleet({ record: registryStop(ended) });
    const row = renderFleet(after, stop.state, { color: false, width: 140, height: 30 })
      .split("\n")
      .find((line) => line.includes("Ended orc"));
    expect(row).toContain("stopped");

    const armed = transitionFleet(stop.state, after, "ctrl+x", NOW_MS + 1);
    expect(armed.action).toBeUndefined();
    expect(armed.state.orchestratorPicker).toMatchObject({
      deleteConfirmation: { sessionId: ended.id },
    });
    const confirmed = transitionFleet(armed.state, after, "ctrl+x", NOW_MS + 2);
    expect(confirmed.action).toEqual({ type: "delete", sessionId: ended.id });
  });

  it("cancels a picker deletion left pending too long instead of deleting on the next press", () => {
    const stopped = session({
      kind: "orchestrator",
      role: "orchestrator",
      executionState: "cancelled",
      attentionState: "done",
      exitCode: 0,
    });
    const snapshot = fleet({ record: stopped });
    const opened = transitionFleet(createFleetState(snapshot), snapshot, "ctrl+o", NOW_MS);

    const stop = transitionFleet(opened.state, snapshot, "ctrl+x", NOW_MS);
    expect(stop.action).toEqual({ type: "stop", sessionId: stopped.id });

    const armed = transitionFleet(stop.state, snapshot, "ctrl+x", NOW_MS + 1);
    expect(armed.action).toBeUndefined();
    expect(armed.state.orchestratorPicker).toMatchObject({
      deleteConfirmation: { sessionId: stopped.id },
    });

    // Same 5s window as the fleet list's own confirmation — this rearms rather than deletes.
    const expired = transitionFleet(armed.state, snapshot, "ctrl+x", NOW_MS + 6_000);
    expect(expired.action).toBeUndefined();
    expect(expired.state.orchestratorPicker).toMatchObject({
      deleteConfirmation: { sessionId: stopped.id, expiresAt: NOW_MS + 11_000 },
    });
  });

  it("does nothing on Ctrl+X when a New orchestrator profile is focused", () => {
    const peer = session({ kind: "orchestrator", role: "orchestrator", name: "Peer orc" });
    const snapshot = fleet({ record: peer });
    const opened = transitionFleet(createFleetState(snapshot), snapshot, "ctrl+o", NOW_MS);
    const onNewProfile = transitionFleet(opened.state, snapshot, "down", NOW_MS);
    expect(onNewProfile.state.orchestratorPicker).toMatchObject({
      focus: { kind: "profile", modelIndex: 0 },
    });

    const result = transitionFleet(onNewProfile.state, snapshot, "ctrl+x", NOW_MS);
    expect(result.action).toBeUndefined();
    expect(result.state).toEqual(onNewProfile.state);
  });

  it("shows the Ctrl+X hint only while an existing orchestrator row is focused", () => {
    const peer = session({ kind: "orchestrator", role: "orchestrator", name: "Peer orc" });
    const snapshot = fleet({ record: peer });
    const opened = transitionFleet(createFleetState(snapshot), snapshot, "ctrl+o", NOW_MS);

    const onExisting = renderFleet(snapshot, opened.state, { color: false, width: 140, height: 30 });
    expect(onExisting).toContain("ctrl+x stop");

    const onNewProfile = transitionFleet(opened.state, snapshot, "down", NOW_MS).state;
    const rendered = renderFleet(snapshot, onNewProfile, { color: false, width: 140, height: 30 });
    expect(rendered).not.toContain("ctrl+x stop");
    expect(rendered).not.toContain("ctrl+x delete");
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

    expect(rendered).toContain("Claude Provider Native Model · Provider managed · fleet");
    expect(rendered).not.toContain("Claude Provider Native Model · Provider managed · /repo/one");
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

  it("uses Ctrl+S for cwd navigation and leaves Tab inert outside the project prompt", () => {
    const decoder = new FleetKeyDecoder();
    expect(decoder.push(Buffer.from([0x13]))).toEqual(["ctrl+s"]);
    // Tab is named so the project prompt can complete with it. Everywhere else it does nothing,
    // and it is never told apart from Ctrl+I, which sends the same byte.
    expect(decoder.push(Buffer.from([0x09]))).toEqual(["tab"]);

    const snapshot = fleet({ record: session({ cwd: "/repo/one" }) });
    const inert = transitionFleet(createFleetState(snapshot), snapshot, "tab", NOW_MS);
    expect(inert.action).toBeUndefined();
    expect(inert.state.draft).toBe("");
    expect(inert.state.projectPrompt).toBeUndefined();
    expect(transitionFleet(createFleetState(snapshot), snapshot, "ctrl+s", NOW_MS).action).toEqual({
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
    expect(decoder.push(Buffer.from([0x0a, 0x0e, 0x12, 0x13, 0x14, 0x17]))).toEqual([
      "ctrl+j", "ctrl+n", "ctrl+r", "ctrl+s", "ctrl+t", "ctrl+w",
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
    expect(decoder.push("\u001bk\u001bj")).toEqual(["alt+k", "alt+j"]);
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

  // MIK-78. A provider with no way to open a path is told so before a PNG is written: capturing an
  // image for a worker that will never read it is the silent drop, one step delayed.
  it("refuses Ctrl+V out loud for a provider whose CLI takes no image, and reads no pasteboard", () => {
    const snapshot = fleet({ record: session({ provider: "cursor", model: "composer" }) });
    const state = {
      ...createFleetState(snapshot),
      draft: "Read",
      launchProfiles: {
        "/Users/brandon/code/personal/cyberdeck": { provider: "cursor", model: "composer" },
      },
    };

    const transition = transitionFleet(state, snapshot, "ctrl+v", NOW_MS);

    expect(transition.action).toBeUndefined();
    expect(transition.state.draft).toBe("Read");
    expect(transition.state.notice).toBe(
      "Cursor cannot be given an image: cursor-agent advertises no image flag and no path attachment",
    );
    expect(transition.state.noticeTone).toBe("error");
  });

  it("asks for the pasteboard for a provider whose CLI does take an image", () => {
    const snapshot = fleet({ record: session({ provider: "codex", model: "gpt-5.6-sol" }) });
    const state = {
      ...createFleetState(snapshot),
      draft: "Read",
      launchProfiles: {
        "/Users/brandon/code/personal/cyberdeck": { provider: "codex", model: "gpt-5.6-sol" },
      },
    };

    expect(transitionFleet(state, snapshot, "ctrl+v", NOW_MS).action)
      .toEqual({ type: "attach-clipboard-image" });
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

    const halfDown = transitionFleet(pageDown, snapshot, "alt+j", NOW_MS, 4).state;
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
    expect(rendered).toContain("Composer 2.5");
    // The catalog is longer than the terminal, so the tail is reached by scrolling to it and the
    // window stops at the final entry rather than scrolling past it.
    expect(rendered).not.toContain("Gemini 3.6 Flash");
    const last = Array.from({ length: 64 }).reduce<FleetState>(
      (state) => transitionFleet(state, snapshot, "down", NOW_MS).state,
      model.state,
    );
    const atEnd = renderFleet(snapshot, last, { color: false, width: 100, height: 28 });
    expect(atEnd).toContain("Gemini 3.6 Flash");
    expect(atEnd).toMatch(/(\d+) of \1/u);

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
    expect(rendered).toContain("2-4 of 7");
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

  // MIK-78. Codex advertises `-i`, so the image travels as a launch argument and arrives as an
  // attachment rather than as prose that happens to name a file. The path stays in the prompt too:
  // the model is told what it is looking at.
  it("attaches a pasted image to a Codex launch through the CLI's own image flag", () => {
    const snapshot = fleet({ record: session({ provider: "codex", model: "gpt-5.6-sol" }) });
    const state = {
      ...createFleetState(snapshot),
      draft: "Why is this row misaligned? \"/state/Application Support/Cyberdeck/pasted-images/paste-a.png\"",
      launchProfiles: {
        "/Users/brandon/code/personal/cyberdeck": { provider: "codex", model: "gpt-5.6-sol" },
      },
    };

    expect(transitionFleet(state, snapshot, "enter", NOW_MS).action).toMatchObject({
      type: "start",
      request: {
        provider: "codex",
        imageAttachments: ["/state/Application Support/Cyberdeck/pasted-images/paste-a.png"],
        initialPrompt: state.draft,
      },
    });
  });

  // Claude has no attachment flag and opens files named in its prompt, so the prompt is the whole
  // delivery. An attachment list here would be a record claiming an argument no launch ever made.
  it("hands Claude the path in the prompt and no launch attachment", () => {
    const snapshot = fleet({ record: session({ provider: "claude", model: "sonnet" }) });
    const state = {
      ...createFleetState(snapshot),
      draft: "Look at /tmp/shot.png",
      launchProfiles: {
        "/Users/brandon/code/personal/cyberdeck": { provider: "claude", model: "sonnet" },
      },
    };

    const action = transitionFleet(state, snapshot, "enter", NOW_MS).action;
    expect(action).toMatchObject({ type: "start", request: { initialPrompt: "Look at /tmp/shot.png" } });
    expect((action as { request: Record<string, unknown> }).request).not.toHaveProperty("imageAttachments");
  });

  // A path typed or dropped in never passes the Ctrl+V gate — a terminal drop just types characters
  // — so the launch is the second place the same refusal has to stand.
  it("refuses to launch a provider that takes no image with an image path still in the prompt", () => {
    const snapshot = fleet({ record: session({ provider: "cursor", model: "composer" }) });
    const state = {
      ...createFleetState(snapshot),
      draft: "Look at /tmp/shot.png",
      launchProfiles: {
        "/Users/brandon/code/personal/cyberdeck": { provider: "cursor", model: "composer" },
      },
    };

    const transition = transitionFleet(state, snapshot, "enter", NOW_MS);

    expect(transition.action).toBeUndefined();
    // The draft survives: a refusal that eats the prompt costs the operator the work twice.
    expect(transition.state.draft).toBe("Look at /tmp/shot.png");
    expect(transition.state.notice).toContain("Cursor cannot be given an image");
    expect(transition.state.notice).toContain("/model to a provider that can");
    expect(transition.state.noticeTone).toBe("error");
  });

  it("shows the model a session is running now, and marks a launch value as unverified", () => {
    // MIK-80: started on Sonnet, switched to Opus effort high inside the provider's own CLI.
    expect(threadIdentity(session({
      provider: "claude",
      model: "sonnet",
      effort: "low",
      observedModel: { model: "claude-opus-5", effort: "high", observedAt: NOW },
    }))).toBe("Claude Opus 5 · high");

    // Nothing observed yet: the launch value stands, wearing the mark that says it is one.
    expect(threadIdentity(session({ provider: "claude", model: "sonnet", effort: "low" })))
      .toBe("~Claude Sonnet · low");

    // A provider that names a model without naming an effort is only half observed, and says so.
    expect(threadIdentity(session({
      provider: "claude",
      model: "sonnet",
      effort: "low",
      observedModel: { model: "claude-opus-5" },
    }))).toBe("~Claude Opus 5 · low");

    // Cursor writes no transcript at all, so its column can never be more than a launch value.
    expect(threadIdentity(session({ provider: "cursor", model: "cursor-grok-4.6-high" })))
      .toBe("~Cursor Grok 4.6 High · Provider managed");
  });

  it("offers the models the providers currently advertise, marking a list nobody could verify", () => {
    const snapshot = fleet({ record: session() });
    const state: FleetState = {
      ...createFleetState(snapshot),
      workerModels: workerModelCatalog([
        {
          provider: "cursor",
          models: ["cursor-grok-4.6-high", "composer-2.5"],
          modelLabels: { "cursor-grok-4.6-high": "Grok 4.6 (High)" },
          efforts: [],
          approvalModes: ["auto"],
          modelIdRule: "",
          notes: [],
          source: "provider-query",
          observedAt: NOW,
        },
        {
          provider: "claude",
          models: ["opus"],
          efforts: ["high"],
          approvalModes: ["auto"],
          modelIdRule: "",
          notes: [],
          source: "fallback-catalog",
          fallbackReason: "the claude CLI advertises no model-listing subcommand",
        },
      ]),
      workerPicker: {
        step: "model",
        modelIndex: 0,
        effortIndex: 0,
        cwd: "/repo/one",
        returnDraft: "",
        filter: "",
      },
    };

    const rendered = renderFleet(snapshot, state, { color: false, width: 100, height: 28 });
    // A model that exists only because Cursor just listed it is reachable, under Cursor's own name.
    expect(rendered).toContain("Grok 4.6 (High)");
    // And the provider that could not be asked says so, on the list and on its rows.
    expect(rendered).toContain("~ claude models are a stored list");
    expect(rendered).toContain("the claude CLI advertises no model-listing subcommand");
    expect(rendered).toContain("~ Claude Opus");

    const filtered = transitionFleet(
      transitionFleet(state, snapshot, "g", NOW_MS).state,
      snapshot,
      "r",
      NOW_MS,
    ).state;
    const narrowed = renderFleet(snapshot, filtered, { color: false, width: 100, height: 28 });
    expect(narrowed).toContain("Grok 4.6 (High)");
    expect(narrowed).not.toContain("Composer 2.5");

    // The slug is applied exactly as the provider spells it; no effort is composed onto it.
    const effort = transitionFleet(filtered, snapshot, "enter", NOW_MS);
    const applied = transitionFleet(effort.state, snapshot, "enter", NOW_MS);
    expect(applied.action).toEqual({
      type: "profile",
      cwd: "/repo/one",
      profile: { provider: "cursor", model: "cursor-grok-4.6-high" },
    });
  });

  it("keeps the selected model when a fresh capability read lands under the open picker", () => {
    const snapshot = fleet({ record: session() });
    const opened: FleetState = {
      ...createFleetState(snapshot),
      workerModels: workerModelCatalog([{
        provider: "codex",
        models: ["gpt-5.6-luna", "gpt-5.6-sol"],
        efforts: ["high"],
        approvalModes: ["auto"],
        modelIdRule: "",
        notes: [],
        source: "provider-query",
      }]),
      workerPicker: {
        step: "model",
        modelIndex: 1,
        effortIndex: 0,
        cwd: "/repo/one",
        returnDraft: "",
        filter: "",
      },
    };

    const reordered = adoptWorkerModels(opened, workerModelCatalog([{
      provider: "codex",
      models: ["gpt-5.7-nova", "gpt-5.6-luna", "gpt-5.6-sol"],
      efforts: ["high"],
      approvalModes: ["auto"],
      modelIdRule: "",
      notes: [],
      source: "provider-query",
    }]));
    expect(reordered.workerPicker?.modelIndex).toBe(2);

    // A model the provider dropped has no row to keep, so the cursor goes somewhere that exists.
    const dropped = adoptWorkerModels(opened, workerModelCatalog([{
      provider: "codex",
      models: ["gpt-5.7-nova"],
      efforts: ["high"],
      approvalModes: ["auto"],
      modelIdRule: "",
      notes: [],
      source: "provider-query",
    }]));
    expect(dropped.workerPicker?.modelIndex).toBe(0);
  });

  it("opens /model instead of parsing provider syntax when no launch profile exists", () => {
    const snapshot = fleet();
    const initial = { ...createFleetState(snapshot, "/repo/empty"), draft: "Fix the failing test" };
    const picker = transitionFleet(initial, snapshot, "enter", NOW_MS);
    // Nothing is launched; the only thing the open asks for is a fresh read of what is launchable.
    expect(picker.action).toEqual({ type: "worker-capabilities" });
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

  // MIK-96: `/cursor-workers` is gone, so the composer treats it as ordinary text rather than as a
  // command — and MIK-97's unreachable remedy goes with it, because there is no remedy to reach.
  it("does not offer or route /cursor-workers at all", () => {
    const orchestrator = session({
      kind: "orchestrator",
      provider: "cursor",
      model: "composer-2.5",
      cwd: "/repo/one",
      orchestratorScope: "workspace",
    });
    const snapshot = fleet({ record: orchestrator });
    const state = { ...createFleetState(snapshot), draft: "/cursor-workers on" };
    const transition = transitionFleet(state, snapshot, "enter", NOW_MS);

    expect(transition.action).not.toMatchObject({ type: "cursor-workers" });
    expect(transition.state.notice).not.toContain("No orchestrator");
    const palette = transitionFleet(createFleetState(snapshot), snapshot, "/", NOW_MS);
    expect(renderFleet(snapshot, palette.state, { color: false, width: 100, height: 24 }))
      .not.toContain("/cursor-workers");
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

  it("opens a project's main checkout from its folder header, which no worker's worktree reaches", () => {
    const first = session({ cwd: "/repo/one" });
    const second = session({ id: "22222222-2222-4222-8222-222222222222", cwd: "/repo/two" });
    const snapshot = fleet({ record: first }, { record: second });
    const onFolder = transitionFleet(createFleetState(snapshot), snapshot, "down", NOW_MS).state;
    expect(onFolder.focusedFolderCwd).toBe("/repo/two");

    const transition = transitionFleet(onFolder, snapshot, "ctrl+n", NOW_MS);

    expect(transition.action).toEqual({ type: "open-checkout", cwd: "/repo/two" });
    expect(transition.state.notice).toBeUndefined();
  });

  it("has no checkout to open for the Orcs roster, which is a section rather than a path", () => {
    const orc = session({ kind: "orchestrator" });
    const worker = session({ id: "22222222-2222-4222-8222-222222222222", kind: "worker" });
    const snapshot = fleet({ record: orc }, { record: worker });
    const onHeader = { ...createFleetState(snapshot), focusedFolderCwd: "/@orcs" };

    const transition = transitionFleet(onHeader, snapshot, "ctrl+n", NOW_MS);

    expect(transition.action).toBeUndefined();
    expect(transition.state.notice).toBe("Not a project folder");
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
    expect(transitionFleet(initial, snapshot, "ctrl+w", NOW_MS).state.view).toBe("diagnostics");
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
  it("loads replay for every durable session on first observation", async () => {
    const record = session();
    const request = vi.fn(async (method: string) => {
      if (method === "session.list") return [record];
      if (method === "session.snapshot") return { data: Buffer.from("latest").toString("base64") };
      throw new Error(`unexpected ${method}`);
    });

    await expect(collectFleetSnapshot({ request } as never)).resolves.toEqual({
      threads: [{ record, replay: "latest" }],
    });
    expect(request).toHaveBeenCalledWith("session.snapshot", { sessionId: record.id, cursor: 0 });
  });

  it("polls only active sessions after warming a 170-session catalog", async () => {
    const records = Array.from({ length: 170 }, (_, index) => session({
      id: `11111111-1111-4111-8111-${String(index + 1).padStart(12, "0")}`,
      executionState: index < 14 ? "active" : "exited",
      exitCode: index < 14 ? null : 0,
    }));
    let snapshotRequests = 0;
    const request = vi.fn(async (method: string, params?: { cursor?: number }) => {
      if (method === "session.list") return records;
      if (method === "session.snapshot") {
        snapshotRequests += 1;
        if (params?.cursor === 1) return { cursor: 1, notModified: true };
        return { data: Buffer.from("latest").toString("base64"), cursor: 1 };
      }
      throw new Error(`unexpected ${method}`);
    });
    const client = { request } as never;

    await collectFleetSnapshot(client);
    expect(snapshotRequests).toBe(170);

    snapshotRequests = 0;
    await expect(collectFleetSnapshot(client)).resolves.toHaveProperty("threads.length", 170);
    expect(snapshotRequests).toBe(14);
  });

  it("keeps polling a cancelled session until its process has exited", async () => {
    // session.stop marks a session cancelled before signalling its process, so output can
    // still arrive after the state turns terminal. Freezing the cache on state alone loses it.
    const record = session({ executionState: "cancelled", exitCode: null });
    let revision = 1;
    let replay = "dying output";
    const request = vi.fn(async (method: string, params?: { cursor?: number }) => {
      if (method === "session.list") return [record];
      if (method === "session.snapshot") {
        if (params?.cursor === revision) return { cursor: revision, notModified: true };
        return { data: Buffer.from(replay).toString("base64"), cursor: revision };
      }
      throw new Error(`unexpected ${method}`);
    });
    const client = { request } as never;

    await expect(collectFleetSnapshot(client)).resolves.toEqual({
      threads: [{ record, replay: "dying output" }],
    });

    revision = 2;
    replay = "dying output plus a late flush";
    await expect(collectFleetSnapshot(client)).resolves.toEqual({
      threads: [{ record, replay: "dying output plus a late flush" }],
    });

    record.exitCode = 143;
    await collectFleetSnapshot(client);
    const fetchesBeforeFreeze = request.mock.calls.filter(([method]) => method === "session.snapshot").length;
    await collectFleetSnapshot(client);
    const fetchesAfterFreeze = request.mock.calls.filter(([method]) => method === "session.snapshot").length;
    expect(fetchesBeforeFreeze).toBe(3);
    expect(fetchesAfterFreeze).toBe(3);
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

  it("takes an orc's controller identity from its binding and leaves workers to their lease", async () => {
    const orc = session();
    const workerRecord = session({
      id: "22222222-2222-4222-8222-222222222222",
      kind: "worker",
      role: "worker",
    });
    const ownership = coordination(workerRecord.id, "active");
    const request = vi.fn(async (method: string) => {
      if (method === "session.list") return [orc, workerRecord];
      if (method === "fleet.workerCoordination") return [ownership];
      if (method === "fleet.orchestratorOwnership") {
        return [{ sessionId: orc.id, controllerId: "orchestrator:workspace:/repo/one" }];
      }
      if (method === "session.snapshot") return { data: Buffer.from("latest").toString("base64") };
      throw new Error(`unexpected ${method}`);
    });

    await expect(collectFleetSnapshot({ request } as never)).resolves.toEqual({
      threads: [
        { record: orc, replay: "latest", controllerId: "orchestrator:workspace:/repo/one" },
        // The worker row carries no controller id of its own: its owner is whatever its lease
        // currently names, which the coordination projection already said.
        { record: workerRecord, replay: "latest", coordination: ownership },
      ],
    });
  });

  it("leaves every orc unattributed when the broker cannot answer for ownership", async () => {
    const record = session();
    const request = vi.fn(async (method: string) => {
      if (method === "session.list") return [record];
      if (method === "fleet.orchestratorOwnership") throw new Error("unknown method");
      if (method === "session.snapshot") return { data: Buffer.from("latest").toString("base64") };
      throw new Error(`unexpected ${method}`);
    });

    await expect(collectFleetSnapshot({ request } as never)).resolves.toEqual({
      threads: [{ record, replay: "latest" }],
    });
  });
});

describe("runFleet", () => {
  it("renders a non-interactive snapshot without probing worker capabilities", async () => {
    class Input extends EventEmitter {
      isTTY = false;
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
    const requested: string[] = [];
    const closeListeners = new Set<() => void>();
    const transport = {
      request: vi.fn(async (method: string) => {
        requested.push(method);
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

    // A piped snapshot renders once and returns — it must never reach the interactive-only probes,
    // chief among them worker.capabilities, which spawns the provider listing CLIs broker-side and
    // can hold a cold broker for the full capability-probe timeout.
    await runFleet(transport as never, input as never, output as never, new EventEmitter());

    expect(requested).not.toContain("worker.capabilities");
    expect(transport.close).toHaveBeenCalledTimes(1);
    expect(Buffer.concat(output.chunks).toString().length).toBeGreaterThan(0);
  });

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

    input.emit("data", Buffer.from([0x13]));
    await vi.waitFor(() => expect(changeDirectory).toHaveBeenCalledWith(process.cwd()));
    await vi.waitFor(() => expect(Buffer.concat(output.chunks).toString()).toContain(
      "cwd /repo/two · ctrl+s change",
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

  it("hands the checkout opener every thread, so a worker running in the checkout is seen", async () => {
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

    // The worker runs in the checkout itself, and its own row was never opened in nvim. The opener
    // can only install a guard for it if the threads travel with the request.
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
    const openCheckout = vi.fn(async () =>
      "one checkout opened in %2 · 0 changes · since origin/main · read-only while a worker runs in it");
    const running = runFleet(
      transport as never,
      input,
      output,
      new EventEmitter(),
      { detachIdentity: "operator:one", openCheckout },
    );

    await vi.waitFor(() => expect(transport.request).toHaveBeenCalledWith("session.list", {}));
    await vi.waitFor(() => expect(input.isRaw).toBe(true));
    // Up onto the folder header — the checkout's own row — and then Ctrl+N.
    input.emit("data", Buffer.from("\u001b[A"));
    input.emit("data", Buffer.from([0x0e]));

    await vi.waitFor(() => expect(openCheckout).toHaveBeenCalledWith(
      "/repo/one",
      { enabled: true, orchestratorSessionIds: [] },
      [worker],
    ));
    await vi.waitFor(() => expect(
      Buffer.concat(output.chunks).toString("utf8"),
    ).toContain("read-only while a worker runs in it"));

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
      // The wrap changes layout and repaints in full once. Later characters damage only the final
      // composer row, so the retained first row is intentionally absent from the last write.
      const writes = output.chunks.map((chunk) => chunk.toString());
      expect(writes.some((write) =>
        write.replaceAll("\u001b[K", "").includes(`› ${"a".repeat(47)}\n  b`))).toBe(true);
      expect(writes.at(-1)).toContain(`\u001b[27;1H  ${"b".repeat(13)}\u001b[K`);
      expect(writes.at(-1)).toContain("\u001b[27;16H\u001b[?25h");
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

  it("leaves the picker entry intact and surfaces the error when the fleet's stop RPC is denied", async () => {
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

    const orchestrator = session({
      kind: "orchestrator",
      role: "orchestrator",
      name: "Denied peer",
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
        if (method === "session.stopOne") throw new Error("Not permitted to stop this orchestrator");
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

    input.emit("data", Buffer.from([0x0f])); // ctrl+o opens the picker on the only existing orchestrator
    input.emit("data", Buffer.from([0x18])); // ctrl+x, denied by the broker
    await vi.waitFor(() => {
      const latestScreen = Buffer.concat(output.chunks).toString().split("[?25l[H").at(-1) ?? "";
      expect(latestScreen).toContain("Not permitted to stop this orchestrator");
      expect(latestScreen).toContain("Denied peer");
      expect(latestScreen).toContain("Existing orchestrators");
    });

    input.emit("data", Buffer.from([0x03, 0x03]));
    await expect(running).resolves.toBeUndefined();
  });

  it("keeps the picker's selection on the existing list after deleting the last entry", async () => {
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

    const makeOrc = (n: number, updatedAt: string) => session({
      id: `9999999${n}-0000-4000-8000-00000000000${n}`,
      kind: "orchestrator",
      role: "orchestrator",
      name: `Orc ${n}`,
      executionState: "cancelled",
      attentionState: "done",
      exitCode: 0,
      updatedAt,
    });
    const first = makeOrc(1, "2026-07-22T09:59:00.000Z");
    const second = makeOrc(2, "2026-07-22T09:58:00.000Z");
    let records = [first, second];
    const transport = {
      request: vi.fn(async (method: string, params: { sessionId?: string }) => {
        if (method === "session.list") return records;
        if (method === "session.snapshot") return { data: "" };
        if (method === "session.stopOne") {
          records = records.map((record) =>
            record.id === params.sessionId ? registryStop(record) : record);
          return { stopped: true };
        }
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

    input.emit("data", Buffer.from([0x0f])); // ctrl+o, focus on Orc 1
    input.emit("data", Buffer.from("[B")); // down, choiceIndex 1 = Orc 2 (the last existing row)
    // Orc 2 is already terminal: stop no-ops, second arms the confirmation, third deletes it.
    input.emit("data", Buffer.from([0x18, 0x18, 0x18]));
    await vi.waitFor(() => expect(transport.request).toHaveBeenCalledWith("session.delete", {
      sessionId: second.id,
    }));

    await vi.waitFor(() => {
      const latestScreen = Buffer.concat(output.chunks).toString().split("[?25l[H").at(-1) ?? "";
      expect(latestScreen).toContain("Existing orchestrators");
      expect(latestScreen).toContain("Orc 1");
      expect(latestScreen).not.toContain("Orc 2");
      // Selection falls back onto the remaining existing row rather than spilling into "New
      // orchestrator" — the same neighbour fallback the fleet list itself uses.
      const orcOneLine = latestScreen.split("\n").find((line) => line.includes("Orc 1"));
      expect(orcOneLine).toContain("›");
    });

    input.emit("data", Buffer.from([0x03, 0x03]));
    await expect(running).resolves.toBeUndefined();
  });

  it("walks the picker's whole Ctrl+X ladder while the broker really mutates the record", async () => {
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

    const orc = session({
      id: "44444444-4444-4444-8444-444444444444",
      kind: "orchestrator",
      role: "orchestrator",
      name: "Live orc",
      executionState: "active",
      attachmentState: "detached",
      detached: true,
      exitCode: null,
    });
    let records: SessionRecord[] = [orc];
    // The SIGTERM `stop` sends is acknowledged asynchronously, so the exit lands on the snapshot
    // after the one that first reported the session cancelled.
    let exiting: string | undefined;
    const deleted: string[] = [];
    const transport = {
      request: vi.fn(async (method: string, params: { sessionId?: string }) => {
        if (method === "session.list") {
          if (exiting !== undefined) {
            const id = exiting;
            exiting = undefined;
            records = records.map((record) => record.id === id ? registryExit(record) : record);
          }
          return records;
        }
        if (method === "session.snapshot") return { data: "" };
        if (method === "session.stopOne") {
          const before = records.find((record) => record.id === params.sessionId);
          records = records.map((record) =>
            record.id === params.sessionId ? registryStop(record) : record);
          if (before?.exitCode === null) exiting = params.sessionId;
          return { stopped: true };
        }
        if (method === "session.delete") {
          deleted.push(params.sessionId!);
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
    const screen = () =>
      Buffer.concat(output.chunks).toString().split("[?25l[H").at(-1) ?? "";
    const running = runFleet(transport as never, input, output, new EventEmitter());
    await vi.waitFor(() => expect(input.isRaw).toBe(true));

    input.emit("data", Buffer.from([0x0f])); // ctrl+o
    await vi.waitFor(() => expect(screen()).toContain("Existing orchestrators"));

    // First press: the graceful stop. The record really moves to cancelled/stopping and then to
    // stopped, and the row has to still be there — and say so — for the rest of the ladder.
    input.emit("data", Buffer.from([0x18]));
    await vi.waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith("session.stopOne", { sessionId: orc.id });
      const latest = screen();
      expect(latest.slice(latest.lastIndexOf("Live orc")).split("\n")[0]).toContain("stopped");
    });

    input.emit("data", Buffer.from([0x18]));
    await vi.waitFor(() => expect(screen()).toContain("Delete orchestrator? press ctrl+x again"));

    input.emit("data", Buffer.from([0x18]));
    await vi.waitFor(() => expect(deleted).toEqual([orc.id]));
    await vi.waitFor(() => {
      const latest = screen();
      expect(latest).toContain("No interactive orchestrators");
      expect(latest).not.toContain("Live orc");
    });

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
      const latestScreen = Buffer.concat(output.chunks).toString().split("\u001b[?25l\u001b[H").at(-1) ?? "";
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
    let pasted: PasteboardImageResult = {
      status: "captured",
      path: "/state/Application Support/Cyberdeck/pasted-images/paste-a.png",
    };
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
      const latestScreen = Buffer.concat(output.chunks).toString().split("\u001b[?25l\u001b[H").at(-1) ?? "";
      expect(latestScreen).toContain(
        "Read \"/state/Application Support/Cyberdeck/pasted-images/paste-a.png\"",
      );
      expect(latestScreen).toContain("Attached paste-a.png");
    });

    // A pasteboard holding text or nothing must not disturb the frame the operator is looking at.
    // A frame equal to the painted one is not written at all, so the pane keeps the bytes it has.
    pasted = { status: "no-image" };
    const beforeEmptyPaste = Buffer.concat(output.chunks).toString().split("\u001b[?25l\u001b[H").at(-1) ?? "";
    output.chunks.length = 0;
    input.emit("data", Buffer.from([0x16]));
    await vi.waitFor(() => expect(pasteboardImage).toHaveBeenCalledTimes(2));
    expect(Buffer.concat(output.chunks).toString()).toBe("");
    expect(beforeEmptyPaste).toContain(
      "Read \"/state/Application Support/Cyberdeck/pasted-images/paste-a.png\"",
    );
    expect(beforeEmptyPaste).toContain("Attached paste-a.png");

    // A pasteboard that could not be read is a different event, and it is said out loud: silence
    // there would be a screenshot dropped without a word.
    pasted = { status: "unavailable", reason: "spawn osascript ENOENT" };
    input.emit("data", Buffer.from([0x16]));
    await vi.waitFor(() => {
      const latestScreen = Buffer.concat(output.chunks).toString().split("[?25l[H").at(-1) ?? "";
      expect(latestScreen).toContain("Could not read the clipboard: spawn osascript ENOENT");
    });

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

describe("fleet shell mode", () => {
  const shellSnapshot = fleet({ record: session({ cwd: "/repo/one" }) });

  it("enters on ! only from an empty composer, and esc gives the fleet back", () => {
    const opened = transitionFleet(createFleetState(shellSnapshot), shellSnapshot, "!", NOW_MS);
    expect(opened.state.shellMode).toEqual({ draft: "", transcript: [] });
    expect(opened.action).toBeUndefined();

    // Mid-draft a `!` is the character the operator typed. A task line may well contain one.
    const typing = transitionFleet(
      { ...createFleetState(shellSnapshot), draft: "fix the" },
      shellSnapshot,
      "!",
      NOW_MS,
    );
    expect(typing.state.shellMode).toBeUndefined();
    expect(typing.state.draft).toBe("fix the!");

    const left = transitionFleet(opened.state, shellSnapshot, "escape", NOW_MS);
    expect(left.state.shellMode).toBeUndefined();

    // Ctrl+G leaves too, including while a line is still running: the running guard is about not
    // editing a draft mid-flight, not about holding the operator inside a command that will not end.
    const byCtrlG = transitionFleet(opened.state, shellSnapshot, "ctrl+g", NOW_MS);
    expect(byCtrlG.state.shellMode).toBeUndefined();
    const running = { ...opened.state, shellMode: { draft: "", running: true, transcript: [] } };
    expect(transitionFleet(running, shellSnapshot, "ctrl+g", NOW_MS).state.shellMode)
      .toBeUndefined();
    expect(transitionFleet(running, shellSnapshot, "escape", NOW_MS).state.shellMode)
      .toBeUndefined();
  });

  // A deep checkout — a worktree under a worktrees directory — pushes this line past the terminal.
  // The hint is what a `tail -f` that never returns is escaped with, so the path gives way first;
  // dropping the tail would take the way out off the screen at the one moment it is needed.
  it("keeps the way out of a running line on screen however long the cwd is", () => {
    const deep = fleet({
      record: session({
        cwd: "/Users/brandon/code/personal/cyberdeck/worktrees/mik-78-composer-image-paste",
      }),
    });
    const state = {
      ...createFleetState(deep),
      shellMode: { draft: "", running: true, transcript: [] },
    };

    const line = renderFleet(deep, state, { color: false, width: 120, height: 30, home: "/Users/brandon" })
      .split("\n")
      .find((row) => row.includes("cwd "))!;

    expect(line).toContain("ctrl+g stops and leaves");
    // The leaf still says which checkout this is; only the segments above it were spent.
    expect(line).toContain("mik-78-composer-image-paste");
    expect(line).toContain("…/");
    expect(line.length).toBeLessThanOrEqual(120);
  });

  it("runs the line where Fleet would spawn, and marks the mode with a red ! and nothing else", () => {
    let state = transitionFleet(createFleetState(shellSnapshot), shellSnapshot, "!", NOW_MS).state;
    for (const key of [..."ls -a"]) {
      state = transitionFleet(state, shellSnapshot, key, NOW_MS).state;
    }
    expect(state.shellMode?.draft).toBe("ls -a");

    const painted = renderFleet(shellSnapshot, state, { color: true, width: 110, height: 30 });
    expect(painted).toContain("\u001b[38;2;217;108;117m!\u001b[0m ls -a");
    // No coloured frame and no restyled border: the red ! is the whole indicator.
    expect(painted).not.toContain("\u001b[38;2;217;108;117m─");

    const ran = transitionFleet(state, shellSnapshot, "enter", NOW_MS);
    expect(ran.action).toEqual({ type: "shell-run", command: "ls -a", cwd: "/repo/one" });
    expect(ran.state.shellMode).toEqual({
      draft: "",
      running: true,
      transcript: ["! ls -a", ""],
    });
    // Nothing may be typed into a shell that is still answering.
    expect(transitionFleet(ran.state, shellSnapshot, "x", NOW_MS).state.shellMode?.draft).toBe("");
  });

  it("renders output into the body and drops the row the shell has left open", () => {
    const state: FleetState = {
      ...createFleetState(shellSnapshot),
      shellMode: { draft: "", transcript: ["! git status", "On branch main", ""] },
    };
    const rendered = renderFleet(shellSnapshot, state, { color: false, width: 110, height: 30 });
    expect(rendered).toContain("! git status");
    expect(rendered).toContain("On branch main");
    // The thread list is not competing with the output while the mode is on.
    expect(rendered).not.toContain("Implement modular cryptographic scheme");
  });

  it("folds chunk-sized output into rows without breaking a line in half", () => {
    let transcript = appendShellOutput([], "On branch ");
    transcript = appendShellOutput(transcript, "main\nnothing to commit");
    expect(transcript).toEqual(["On branch main", "nothing to commit"]);
    expect(appendShellOutput(transcript, "\n")).toEqual([
      "On branch main",
      "nothing to commit",
      "",
    ]);
  });

  it("carries cd into the next line, and shows a non-zero exit rather than swallowing it", async () => {
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
      onClose(listener: () => void) {
        closeListeners.add(listener);
        return () => closeListeners.delete(listener);
      },
      close: vi.fn(),
    };
    const input = new Input();
    const output = new Output();
    const calls: Array<{ command: string; cwd: string }> = [];
    const runShellCommand = vi.fn(async (
      request: { command: string; cwd: string; onOutput: (chunk: string) => void },
    ) => {
      calls.push({ command: request.command, cwd: request.cwd });
      if (request.command === "cd sub") return { exitStatus: 0, cwd: "/repo/one/sub" };
      if (request.command === "false") {
        request.onOutput("boom\n");
        return { exitStatus: 3, cwd: "/repo/one/sub" };
      }
      // A line whose output merely resembles a sentinel reports no directory at all, and Fleet
      // stays exactly where the last real answer put it.
      request.onOutput("0000 0 /nowhere-at-all\n");
      return { exitStatus: 0 };
    });
    const running = runFleet(
      transport as never,
      input,
      output,
      new EventEmitter(),
      { runShellCommand, detachIdentity: "operator:one" },
    );
    await vi.waitFor(() => expect(input.isRaw).toBe(true));

    input.emit("data", Buffer.from("!"));
    await vi.waitFor(() =>
      expect(Buffer.concat(output.chunks).toString()).toContain("esc or ctrl+g leaves"));

    input.emit("data", Buffer.from("cd sub\r"));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ command: "cd sub", cwd: process.cwd() });

    input.emit("data", Buffer.from("false\r"));
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    // The directory the first line ended in is the directory the second line runs in.
    expect(calls[1]).toEqual({ command: "false", cwd: "/repo/one/sub" });
    await vi.waitFor(() => {
      const rendered = Buffer.concat(output.chunks).toString();
      expect(rendered).toContain("boom");
      expect(rendered).toContain("exit 3");
    });

    input.emit("data", Buffer.from("git log\r"));
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    input.emit("data", Buffer.from("pwd\r"));
    await vi.waitFor(() => expect(calls).toHaveLength(4));
    expect(calls[3]).toEqual({ command: "pwd", cwd: "/repo/one/sub" });

    // A lone escape byte is only a key once the decoder has waited out a sequence, so the mode
    // leaves on the flush rather than on the byte: the frame after it is the fleet again.
    const mark = output.chunks.length;
    input.emit("data", Buffer.from([0x1b]));
    await vi.waitFor(() => expect(Buffer.concat(output.chunks.slice(mark)).toString()).toContain(
      "ctrl+s change",
    ));
    input.emit("data", Buffer.from([0x03, 0x03]));
    await expect(running).resolves.toBeUndefined();
  });

  it("gets the operator out of a line that never ends, instead of queueing the key behind it", async () => {
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
    const transport = {
      request: vi.fn(async (method: string) => {
        if (method === "session.list") return [];
        if (method === "fleet.preferences") return {};
        throw new Error(`unexpected ${method}`);
      }),
      sendFrame: vi.fn(),
      onFrame: vi.fn(() => () => undefined),
      onClose: vi.fn(() => () => undefined),
      close: vi.fn(),
    };
    const input = new Input();
    const output = new Output();
    let interrupted: AbortSignal | undefined;
    // A `tail -f`: it answers the composer only once something stops it.
    const runShellCommand = vi.fn(async (request: { signal?: AbortSignal | undefined }) => {
      interrupted = request.signal;
      await new Promise<void>((resolve) => {
        request.signal?.addEventListener("abort", () => { resolve(); }, { once: true });
      });
      return { exitStatus: 130 };
    });
    const running = runFleet(
      transport as never,
      input,
      output,
      new EventEmitter(),
      { runShellCommand, detachIdentity: "operator:one" },
    );
    await vi.waitFor(() => expect(input.isRaw).toBe(true));

    input.emit("data", Buffer.from("!"));
    input.emit("data", Buffer.from("tail -f log\r"));
    await vi.waitFor(() => expect(runShellCommand).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(Buffer.concat(output.chunks).toString()).toContain("ctrl+g stops and leaves"));

    // Every key after this one is queued behind the line itself, so the interrupt has to be fired
    // on arrival rather than in turn — otherwise the key that ends the command waits for it.
    const mark = output.chunks.length;
    input.emit("data", Buffer.from([0x07]));
    await vi.waitFor(() => expect(interrupted?.aborted).toBe(true));
    await vi.waitFor(() => expect(Buffer.concat(output.chunks.slice(mark)).toString()).toContain(
      "ctrl+s change",
    ));

    input.emit("data", Buffer.from([0x03, 0x03]));
    await expect(running).resolves.toBeUndefined();
  });
});

describe("composer caret", () => {
  const snapshot = threadFleet(2);
  const options = { color: false, width: 60, height: 30, now: NOW_MS, home: "/Users/brandon" };
  const caret = (state: FleetState) =>
    composerCursor(renderFleet(snapshot, state, options), state, options.width);
  const base = createFleetState(snapshot);

  it("parks the caret off the prompt of the composer that owns the frame", () => {
    // "› " is two cells, so an empty task draft starts in the third.
    expect(caret(base)?.column).toBe(3);
    expect(caret({ ...base, rename: { sessionId: "x", draft: "" } })?.column).toBe(10);
    expect(caret({ ...base, projectPrompt: { draft: "" } })?.column).toBe(11);
    expect(caret({ ...base, shellMode: { draft: "", transcript: [] } })?.column).toBe(3);
  });

  it("reads the draft the composer row is showing, not the task draft underneath it", () => {
    // The shell and the project prompt borrow the row while the task draft keeps its text. A caret
    // placed off `state.draft` lands past the end of a row that is showing something else.
    expect(caret({
      ...base,
      draft: "a task the operator typed earlier",
      shellMode: { draft: "", transcript: [] },
    })?.column).toBe(3);
    expect(caret({
      ...base,
      draft: "a task the operator typed earlier",
      projectPrompt: { draft: "" },
    })?.column).toBe(11);
    expect(caret({
      ...base,
      draft: "",
      shellMode: { draft: "git status", transcript: [] },
    })?.column).toBe("! git status".length + 1);
  });

  it("counts the draft in terminal cells rather than code points", () => {
    // Three ideographs print six cells. Counting the string would leave the caret three columns
    // inside the operator's own text.
    expect(caret({ ...base, draft: "日本語" })?.column).toBe(9);
    expect(caret({ ...base, draft: "abc" })?.column).toBe(6);
    expect(caret({ ...base, draft: "\u{1f419}" })?.column).toBe(5);
  });

  it("wraps the composer on cells, so a wide draft never overruns the pane", () => {
    const wide = "日".repeat(40);
    const rows = renderFleet(snapshot, { ...base, draft: wide }, options)
      .split("\n")
      .filter((line) => line.startsWith("› 日") || line.startsWith("  日"));
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) expect(displayWidth(row)).toBeLessThan(options.width);
  });

  it("clamps every row to the pane in cells, so nothing above the composer soft-wraps", () => {
    // A row wider than the pane is soft-wrapped by the terminal onto a line the fleet never
    // counted, and the composer — with the caret addressed to it — moves down by one.
    const wide = fleet({
      record: session({
        id: "88888888-0000-4000-8000-000000000001",
        cwd: "/repo/one",
        name: "日本語で名付けられた作業者",
        latestPreview: "日本語表示幅の計算",
      }),
    });
    const rendered = renderFleet(wide, createFleetState(wide), options);
    for (const line of rendered.split("\n")) {
      expect(displayWidth(line)).toBeLessThanOrEqual(options.width);
    }
  });

  it("gives no caret to a view without a composer", () => {
    expect(caret({
      ...base,
      workerPicker: { step: "model", modelIndex: 0, effortIndex: 0, cwd: "/repo/one", returnDraft: "", filter: "" },
    })).toBeUndefined();
    expect(caret({
      ...base,
      permissionPicker: { step: "provider", providerIndex: 0, policyIndex: 0 },
    })).toBeUndefined();
    expect(caret({
      ...base,
      orchestratorPicker: { step: "target", focus: { kind: "profile", modelIndex: 0 } },
    })).toBeUndefined();
    expect(caret({ ...base, view: "diagnostics" })).toBeUndefined();
    // The palette does collect text, so it keeps its caret.
    expect(caret({
      ...base,
      draft: "/",
      commandPalette: { level: "commands", selectedIndex: 0, scrollOffset: 0 },
    })).toBeDefined();
  });
});

describe("tiny picker presentation", () => {
  it("keeps every cursorless picker selection and handoff typing visible in one row", () => {
    const receiver = session({
      id: "77777777-7777-4777-8777-777777777777",
      kind: "orchestrator",
      role: "orchestrator",
      name: "Receiving orc",
    });
    const worker = session({
      id: "88888888-8888-4888-8888-888888888888",
      kind: "worker",
      role: "worker",
      name: "Tiny worker",
    });
    const snapshot = fleet({ record: receiver }, { record: worker });
    const base = createFleetState(snapshot);
    const render = (state: FleetState, height = 1) => renderFleet(snapshot, state, {
      color: false,
      width: 60,
      height,
      now: NOW_MS,
    });
    const workerPicker: FleetState = {
      ...base,
      workerPicker: {
        step: "model",
        modelIndex: 0,
        effortIndex: 0,
        cwd: worker.cwd,
        returnDraft: "",
        filter: "",
      },
    };
    const permissionPicker: FleetState = {
      ...base,
      permissionPicker: { step: "provider", providerIndex: 0, policyIndex: 0 },
    };
    const orchestratorPicker: FleetState = {
      ...base,
      orchestratorPicker: { step: "target", focus: { kind: "profile", modelIndex: 0 } },
    };
    const handoffPicker: FleetState = {
      ...base,
      handoffPicker: {
        step: "directive",
        workerIds: [worker.id],
        recipientSessionId: receiver.id,
        draft: "keep moving",
        mutationId: "tiny-handoff",
      },
    };

    for (const state of [workerPicker, permissionPicker, orchestratorPicker, handoffPicker]) {
      const rendered = render(state);
      expect(rendered.split("\n")).toHaveLength(1);
      expect(rendered).toMatch(/^› /u);
    }

    expect(render({
      ...permissionPicker,
      permissionPicker: { step: "provider", providerIndex: 1, policyIndex: 0 },
    })).not.toBe(render(permissionPicker));
    expect(render({
      ...handoffPicker,
      handoffPicker: {
        step: "directive",
        workerIds: [worker.id],
        recipientSessionId: receiver.id,
        draft: "latest directive",
        mutationId: "tiny-handoff",
      },
    })).toContain("latest directive▌");

    const emptyHandoff: FleetState = {
      ...handoffPicker,
      handoffPicker: {
        step: "directive",
        workerIds: [worker.id],
        recipientSessionId: receiver.id,
        draft: "",
        mutationId: "tiny-handoff",
      },
    };
    const refused = transitionFleet(emptyHandoff, snapshot, "enter", NOW_MS).state;
    expect(render(refused, 2)).not.toBe(render(emptyHandoff, 2));
    expect(render(refused, 2)).toContain("A handoff needs a directive");
  });

  it("keeps a direct-action notice beside the main composer in a two-row pane", () => {
    const snapshot = fleet();
    const initial = createFleetState(snapshot);
    const refused = transitionFleet(initial, snapshot, "ctrl+n", NOW_MS).state;
    const options = { color: false, width: 60, height: 2, now: NOW_MS };

    const before = renderFleet(snapshot, initial, options);
    const after = renderFleet(snapshot, refused, options);

    expect(after).not.toBe(before);
    expect(after.split("\n")).toEqual([
      "Select a worker to open its worktree in nvim",
      "› Describe a task for a new session",
    ]);
    expect(composerCursor(after, refused, options.width)).toEqual({ row: 2, column: 3 });
  });
});

describe("fleet repaint", () => {
  class Input extends EventEmitter {
    isTTY = true;
    isRaw = false;
    setRawMode(raw: boolean): this { this.isRaw = raw; return this; }
    resume(): this { return this; }
    pause(): this { return this; }
  }
  class Output {
    isTTY = false;
    columns = 60;
    rows = 30;
    chunks: Buffer[] = [];
    write(chunk: string | Uint8Array): boolean {
      this.chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
      return true;
    }
  }

  function transport(sessions: () => SessionRecord[] = () => []) {
    const closeListeners = new Set<() => void>();
    return {
      request: vi.fn(async (method: string) => {
        if (method === "session.list") return sessions();
        if (method === "fleet.preferences") return {};
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
  }

  it("hides the caret for the whole repaint and restores it once the frame is written", async () => {
    const input = new Input();
    const output = new Output();
    const running = runFleet(transport() as never, input, output, new EventEmitter());
    await vi.waitFor(() => expect(input.isRaw).toBe(true));

    input.emit("data", Buffer.from("build it"));
    await vi.waitFor(() =>
      expect(Buffer.concat(output.chunks).toString()).toContain("› build it"));

    // A frame is one write. The first clears and homes because there is no retained geometry;
    // later writes address only damaged rows.
    const frames = output.chunks
      .map((chunk) => chunk.toString())
      .filter((chunk) => chunk.startsWith("\u001b[?25l"));
    expect(frames.length).toBeGreaterThan(1);
    // Nothing repaints with the caret showing: the hide is the first byte of every frame.
    expect(frames[0]!.startsWith("\u001b[?25l\u001b[2J\u001b[H")).toBe(true);
    for (const frame of frames.slice(1)) {
      expect(frame).toMatch(/^\u001b\[\?25l\u001b\[\d+;1H/u);
      expect(frame).not.toContain("\u001b[2J");
      expect(frame).not.toContain("\u001b[H");
    }
    const painted = frames.at(-1) ?? "";
    expect(painted.match(/\u001b\[\?25h/gu) ?? []).toHaveLength(1);
    expect(painted).toMatch(/\u001b\[\d+;\d+H\u001b\[\?25h$/u);

    input.emit("data", Buffer.from([0x03, 0x03]));
    await expect(running).resolves.toBeUndefined();
  });

  it("overwrites the pane in place and clears only where there is nothing under the frame", async () => {
    const input = new Input();
    const output = new Output();
    const signals = new EventEmitter();
    const running = runFleet(transport() as never, input, output, signals);
    await vi.waitFor(() => expect(input.isRaw).toBe(true));
    await vi.waitFor(() =>
      expect(Buffer.concat(output.chunks).toString()).toContain("Describe a task"));

    // The first frame has nothing under it, so it clears.
    const first = output.chunks
      .map((chunk) => chunk.toString())
      .find((chunk) => chunk.includes("\u001b[H")) ?? "";
    expect(first.startsWith("\u001b[?25l\u001b[2J\u001b[H")).toBe(true);

    // Every frame after it does not. A stable-layout update addresses just the changed composer
    // row; a clear is a state the terminal may put on screen before the paint that follows lands.
    output.chunks.length = 0;
    input.emit("data", Buffer.from("build it"));
    await vi.waitFor(() =>
      expect(Buffer.concat(output.chunks).toString()).toContain("› build it"));
    const repaints = output.chunks.map((chunk) => chunk.toString());
    expect(repaints.length).toBeGreaterThan(0);
    for (const frame of repaints) {
      expect(frame).not.toContain("\u001b[2J");
      expect(frame).toMatch(/^\u001b\[\?25l\u001b\[\d+;1H/u);
      expect(frame).not.toContain("\u001b[H");
      // The dirty row takes the tail of the row it replaced with it. No other row is rewritten.
      expect(frame).toContain("\u001b[K");
      expect(frame).not.toContain("\n");
      expect(frame).not.toContain("\u001b[0J");
    }

    // A resize reflows the pane under the fleet, so the geometry an in-place repaint overwrites is
    // no longer the geometry that is on screen: the next frame clears again.
    output.chunks.length = 0;
    output.rows = 24;
    signals.emit("SIGWINCH");
    await vi.waitFor(() => {
      const cleared = output.chunks
        .map((chunk) => chunk.toString())
        .find((chunk) => chunk.includes("\u001b[H")) ?? "";
      expect(cleared.startsWith("\u001b[?25l\u001b[2J\u001b[H")).toBe(true);
    });

    input.emit("data", Buffer.from([0x03, 0x03]));
    await expect(running).resolves.toBeUndefined();
  });

  it("repaints every row when scroll, layout topology, or dimensions change", async () => {
    const input = new Input();
    const output = new Output();
    output.rows = 16;
    let records = threadFleet(8).threads.map(({ record }) => record);
    const running = runFleet(
      transport(() => records) as never,
      input,
      output,
      new EventEmitter(),
    );
    await vi.waitFor(() => expect(input.isRaw).toBe(true));
    await vi.waitFor(() =>
      expect(output.chunks.some((chunk) => chunk.toString().includes("Thread 1"))).toBe(true));

    // Page movement changes the retained viewport even though its dimensions and row identities
    // are stable. The interaction wakes immediately and repaints in place without clearing.
    output.chunks.length = 0;
    input.emit("data", Buffer.from("\u001b[6~"));
    await vi.waitFor(() => expect(output.chunks.length).toBeGreaterThan(0));
    const scrolled = Buffer.concat(output.chunks).toString();
    expect(scrolled.startsWith("\u001b[?25l\u001b[H")).toBe(true);
    expect(scrolled).toContain("\n");
    expect(scrolled).not.toContain("\u001b[2J");

    // A new folder inserts structural rows. Even when it lands beyond the viewport, the topology
    // is no longer the one whose absolute row positions were retained.
    output.chunks.length = 0;
    records = [...records, session({
      id: "99999999-9999-4999-8999-999999999999",
      kind: "worker",
      role: "worker",
      cwd: "/repo/zulu",
      name: "Topology worker",
    })];
    await vi.waitFor(
      () => expect(output.chunks.length).toBeGreaterThan(0),
      { timeout: 2_000, interval: 10 },
    );
    const topology = Buffer.concat(output.chunks).toString();
    expect(topology.startsWith("\u001b[?25l\u001b[H")).toBe(true);
    expect(topology).toContain("\n");
    expect(topology).not.toContain("\u001b[2J");

    // Dimension drift is detected even if a test transport omits SIGWINCH. Geometry is unknown at
    // the new width, so this full repaint also clears before homing.
    output.chunks.length = 0;
    output.columns = 70;
    await vi.waitFor(
      () => expect(output.chunks.length).toBeGreaterThan(0),
      { timeout: 2_000, interval: 10 },
    );
    expect(Buffer.concat(output.chunks).toString().startsWith(
      "\u001b[?25l\u001b[2J\u001b[H",
    )).toBe(true);

    // A picker footer changing height moves the body/footer boundary even though the terminal and
    // palette viewport do not move. Crossing the command-composer wrap boundary therefore forces
    // a complete in-place repaint rather than addressing rows retained under the old boundary.
    const oneRowQuery = "z".repeat(output.columns - 4);
    input.emit("data", Buffer.from(`/${oneRowQuery}`));
    await vi.waitFor(() =>
      expect(output.chunks.at(-1)?.toString()).toContain(`› /${oneRowQuery}`));
    output.chunks.length = 0;
    input.emit("data", Buffer.from("z"));
    await vi.waitFor(() => expect(output.chunks.length).toBeGreaterThan(0));
    const pickerTopology = Buffer.concat(output.chunks).toString();
    expect(pickerTopology.startsWith("\u001b[?25l\u001b[H")).toBe(true);
    expect(pickerTopology).toContain("\n");
    expect(pickerTopology).not.toContain("\u001b[2J");

    input.emit("data", Buffer.from([0x03, 0x03]));
    await expect(running).resolves.toBeUndefined();
  });

  it("addresses damage at the physical pane width below the 50-column layout breakpoint", async () => {
    const input = new Input();
    const output = new Output();
    output.columns = 33;
    const running = runFleet(transport() as never, input, output, new EventEmitter());
    await vi.waitFor(() => expect(input.isRaw).toBe(true));
    await vi.waitFor(() => expect(output.chunks.length).toBeGreaterThan(0));

    const printableRows = (frame: string) => frame
      .replaceAll(/\u001b\[[?0-9;]*[A-Za-z]/gu, "")
      .split("\n");
    const first = output.chunks.find((chunk) => chunk.toString().includes("\u001b[H"))?.toString()
      ?? "";
    expect(first.startsWith("\u001b[?25l\u001b[2J\u001b[H")).toBe(true);
    expect(printableRows(first).every((row) => displayWidth(row) <= output.columns)).toBe(true);

    output.chunks.length = 0;
    input.emit("data", Buffer.from("x"));
    await vi.waitFor(() => expect(output.chunks.length).toBeGreaterThan(0));
    const damage = Buffer.concat(output.chunks).toString();
    expect(damage).toMatch(/^\u001b\[\?25l\u001b\[\d+;1H/u);
    expect(damage).not.toContain("\n");
    expect(printableRows(damage).every((row) => displayWidth(row) <= output.columns)).toBe(true);
    const caretColumn = /\u001b\[\d+;(\d+)H\u001b\[\?25h$/u.exec(damage)?.[1];
    expect(Number(caretColumn)).toBeLessThanOrEqual(output.columns);

    // Width changes below the old synthetic floor are still geometry changes. Even without a
    // SIGWINCH in this test double, the next frame detects the new physical width and clears.
    output.chunks.length = 0;
    output.columns = 40;
    await vi.waitFor(
      () => expect(output.chunks.length).toBeGreaterThan(0),
      { timeout: 2_000, interval: 10 },
    );
    expect(Buffer.concat(output.chunks).toString().startsWith(
      "\u001b[?25l\u001b[2J\u001b[H",
    )).toBe(true);

    input.emit("data", Buffer.from([0x03, 0x03]));
    await expect(running).resolves.toBeUndefined();
  });

  it("addresses damage at the physical pane height below the 16-row layout breakpoint", async () => {
    const input = new Input();
    const output = new Output();
    output.rows = 10;
    const running = runFleet(transport() as never, input, output, new EventEmitter());
    await vi.waitFor(() => expect(input.isRaw).toBe(true));
    await vi.waitFor(() => expect(output.chunks.length).toBeGreaterThan(0));

    const first = output.chunks.find((chunk) => chunk.toString().includes("\u001b[H"))?.toString()
      ?? "";
    expect(first.split("\n")).toHaveLength(output.rows);

    output.chunks.length = 0;
    input.emit("data", Buffer.from("x"));
    await vi.waitFor(() => expect(output.chunks.length).toBeGreaterThan(0));
    const damage = Buffer.concat(output.chunks).toString();
    const damageRow = /^\u001b\[\?25l\u001b\[(\d+);1H/u.exec(damage)?.[1];
    expect(Number(damageRow)).toBeLessThanOrEqual(output.rows);
    expect(damage).not.toContain("\n");

    // A footer can be taller than an extremely short pane. The frame boundary windows it to the
    // physical height, shifts the composer caret with that window, and detects the resize even
    // when this test double omits SIGWINCH.
    output.chunks.length = 0;
    output.rows = 4;
    await vi.waitFor(
      () => expect(output.chunks.length).toBeGreaterThan(0),
      { timeout: 2_000, interval: 10 },
    );
    const resized = Buffer.concat(output.chunks).toString();
    expect(resized.startsWith("\u001b[?25l\u001b[2J\u001b[H")).toBe(true);
    expect(resized.split("\n")).toHaveLength(output.rows);
    expect(resized).not.toContain("\u001b[0J");
    const caretRow = /\u001b\[(\d+);\d+H\u001b\[\?25h$/u.exec(resized)?.[1];
    expect(Number(caretRow)).toBeLessThanOrEqual(output.rows);

    input.emit("data", Buffer.from([0x03, 0x03]));
    await expect(running).resolves.toBeUndefined();
  });

  it("fully repaints when a shell tail or diagnostics topology advances", async () => {
    const input = new Input();
    const output = new Output();
    output.rows = 60;
    const signals = new EventEmitter();
    let records: SessionRecord[] = [];
    let shellOutput: ((chunk: string) => void) | undefined;
    let finishShell: ((result: { exitStatus: number }) => void) | undefined;
    const client = {
      request: vi.fn(async (method: string) => {
        if (method === "session.list") return records;
        if (method === "fleet.preferences") return {};
        if (method === "session.snapshot") return { data: "" };
        if (method === "job.list") return [];
        if (method === "control.queue") {
          return { limits: {}, admissionOpen: true, reservations: [], queued: [] };
        }
        if (method === "control.budget") return { declaration: {}, scopes: [] };
        if (method === "control.reconciliation") {
          return { reconciledAt: null, findings: [], quarantinedJobIds: [] };
        }
        throw new Error(`unexpected ${method}`);
      }),
      sendFrame: vi.fn(),
      onFrame: vi.fn(() => () => undefined),
      onClose: vi.fn(() => () => undefined),
      close: vi.fn(),
    };
    const runShellCommand = vi.fn((
      request: { onOutput: (chunk: string) => void },
    ) => new Promise<{ exitStatus: number }>((resolve) => {
      shellOutput = request.onOutput;
      finishShell = resolve;
    }));
    const running = runFleet(
      client as never,
      input,
      output,
      signals,
      { runShellCommand },
    );
    await vi.waitFor(() => expect(input.isRaw).toBe(true));

    input.emit("data", Buffer.from("!tail -f log\r"));
    await vi.waitFor(() => expect(shellOutput).toBeDefined());
    const initialLines = Array.from({ length: 55 }, (_, index) => `line ${index + 1}`);
    shellOutput!(`${initialLines.join("\n")}\n`);
    await vi.waitFor(() =>
      expect(Buffer.concat(output.chunks).toString()).toContain("line 55"));

    output.chunks.length = 0;
    shellOutput!("line 56\n");
    await vi.waitFor(() => expect(output.chunks.length).toBeGreaterThan(0));
    const shellScroll = Buffer.concat(output.chunks).toString();
    expect(shellScroll.startsWith("\u001b[?25l\u001b[H")).toBe(true);
    expect(shellScroll).toContain("\n");
    expect(shellScroll).not.toContain("\u001b[2J");

    finishShell!({ exitStatus: 0 });
    input.emit("data", Buffer.from([0x1b]));
    await vi.waitFor(() =>
      expect(output.chunks.at(-1)?.toString()).toContain("ctrl+s change"));
    input.emit("data", Buffer.from([0x17]));
    await vi.waitFor(() =>
      expect(Buffer.concat(output.chunks).toString()).toContain("CYBERDECK COCKPIT"));

    output.chunks.length = 0;
    records = [session({
      name: "New diagnostics session",
      cwd: `/repo/${"long-path/".repeat(20)}`,
    })];
    await vi.waitFor(
      () => expect(Buffer.concat(output.chunks).toString()).toContain("11111111"),
      { timeout: 2_000, interval: 10 },
    );
    const diagnosticsTopology = Buffer.concat(output.chunks).toString();
    expect(diagnosticsTopology.startsWith("\u001b[?25l\u001b[H")).toBe(true);
    expect(diagnosticsTopology).toContain("\n");
    expect(diagnosticsTopology).not.toContain("\u001b[2J");
    // Dashboard tables contain tabs and unbounded broker values. The frame-writing boundary
    // expands those tabs and clamps the long path, so each logical diagnostics row remains one
    // physical terminal row and later CUP damage still addresses the intended row.
    const diagnosticsRows = diagnosticsTopology
      .replaceAll(/\u001b\[[?0-9;]*[A-Za-z]/gu, "")
      .split("\n");
    expect(diagnosticsTopology).not.toContain(records[0]!.cwd);
    expect(diagnosticsRows.every((row) => !row.includes("\t"))).toBe(true);
    expect(diagnosticsRows.every((row) => displayWidth(row) <= output.columns)).toBe(true);

    signals.emit("SIGTERM");
    await running;
  });

  it("erases a shortened dirty row without erasing an exact-width dirty row", async () => {
    const input = new Input();
    const output = new Output();
    const record = session();
    let refusal = "x".repeat(output.columns);
    const client = {
      request: vi.fn(async (method: string) => {
        if (method === "session.list") return [record];
        if (method === "fleet.preferences") return {};
        if (method === "session.snapshot") return { data: "" };
        if (method === "session.stopOne") throw new Error(refusal);
        throw new Error(`unexpected ${method}`);
      }),
      sendFrame: vi.fn(),
      onFrame: vi.fn(() => () => undefined),
      onClose: vi.fn(() => () => undefined),
      close: vi.fn(),
    };
    const running = runFleet(client as never, input, output, new EventEmitter());
    await vi.waitFor(() => expect(input.isRaw).toBe(true));

    // Establish a notice row first. Its arrival grows the footer and therefore correctly takes
    // the full-repaint path; the next two same-topology writes exercise row damage itself.
    input.emit("data", Buffer.from([0x18]));
    await vi.waitFor(() =>
      expect(Buffer.concat(output.chunks).toString()).toContain(refusal));

    output.chunks.length = 0;
    refusal = "y".repeat(output.columns);
    input.emit("data", Buffer.from([0x18]));
    await vi.waitFor(() =>
      expect(Buffer.concat(output.chunks).toString()).toContain(refusal));
    const exactWidthDamage = Buffer.concat(output.chunks).toString();
    expect(exactWidthDamage).toMatch(/^\u001b\[\?25l\u001b\[\d+;1H/u);
    expect(exactWidthDamage).not.toContain(`${refusal}\u001b[K`);
    expect(exactWidthDamage).not.toContain("\u001b[H");
    expect(exactWidthDamage).not.toContain("\n");

    output.chunks.length = 0;
    refusal = "short";
    input.emit("data", Buffer.from([0x18]));
    await vi.waitFor(() =>
      expect(Buffer.concat(output.chunks).toString()).toContain(refusal));
    const shortenedDamage = Buffer.concat(output.chunks).toString();
    expect(shortenedDamage).toContain(`${refusal}\u001b[K`);
    expect(shortenedDamage).not.toContain("\n");

    input.emit("data", Buffer.from([0x03, 0x03]));
    await expect(running).resolves.toBeUndefined();
  });

  it("coalesces a localized preview update into one small row-damage write", async () => {
    const input = new Input();
    const output = new Output();
    let preview = "old";
    const record = () => session({
      kind: "orchestrator",
      role: "orchestrator",
      orchestratorScope: "fleet",
      cwd: "/repo/damage",
      name: "Damage orc",
      latestPreview: preview,
    });
    const running = runFleet(
      transport(() => [record()]) as never,
      input,
      output,
      new EventEmitter(),
    );
    await vi.waitFor(() => expect(input.isRaw).toBe(true));
    await vi.waitFor(() =>
      expect(Buffer.concat(output.chunks).toString()).toContain(preview));

    output.chunks.length = 0;
    // All three values land inside one background sampling interval. Only the newest visible
    // preview is painted, and it changes neither row identity nor layout columns.
    preview = "mid1";
    preview = "mid2";
    preview = "new";
    await vi.waitFor(
      () => expect(Buffer.concat(output.chunks).toString()).toContain(preview),
      { timeout: 2_000, interval: 10 },
    );

    const writes = output.chunks.map((chunk) => chunk.toString());
    expect(writes).toHaveLength(1);
    const damage = writes[0]!;
    expect(damage).toContain("new");
    expect(damage).not.toContain("mid1");
    expect(damage).not.toContain("mid2");
    expect(damage).not.toContain("Cyberdeck");
    expect(damage).not.toContain("\n");
    expect(damage.match(/\u001b\[\d+;1H/gu) ?? []).toHaveLength(1);

    // Deterministic byte evidence for the same rendered state: the old steady-state path would
    // rewrite every row, while the production write above contains the single dirty row.
    const snapshot = fleet({ record: record() });
    const state = createFleetState(snapshot);
    const body = renderFleet(snapshot, state, {
      color: false,
      width: output.columns,
      height: output.rows,
      now: Date.now(),
    });
    const cursor = composerCursor(body, state, output.columns)!;
    const wholeFrame = `\u001b[?25l\u001b[H${body.split("\n")
      .map((row) => displayWidth(row) < output.columns ? `${row}\u001b[K` : row)
      .join("\n")}\u001b[${cursor.row};${cursor.column}H\u001b[?25h`;
    const bytes = {
      wholeFrame: Buffer.byteLength(wholeFrame),
      rowDamage: Buffer.byteLength(damage),
    };
    expect(bytes).toEqual({ wholeFrame: 850, rowDamage: 90 });
    expect(bytes.rowDamage).toBeLessThan(bytes.wholeFrame / 8);

    input.emit("data", Buffer.from([0x03, 0x03]));
    await expect(running).resolves.toBeUndefined();
  });

  it("samples preview repaint at 100ms while a movement key wakes immediately", async () => {
    vi.useFakeTimers();
    const input = new Input();
    const output = new Output();
    const signals = new EventEmitter();
    let preview = "old";
    const record = () => session({
      kind: "worker",
      role: "worker",
      cwd: "/repo/rate",
      latestPreview: preview,
    });
    const running = runFleet(
      transport(() => [record()]) as never,
      input,
      output,
      signals,
      {
        permissionPreferences: {
          list: async () => ({}),
          set: async () => {},
        },
      },
    );
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(input.isRaw).toBe(true);
      expect(Buffer.concat(output.chunks).toString()).toContain("old");

      output.chunks.length = 0;
      preview = "new";
      await vi.advanceTimersByTimeAsync(99);
      expect(output.chunks).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(output.chunks).toHaveLength(1);
      expect(output.chunks[0]!.toString()).toContain("new");

      output.chunks.length = 0;
      input.emit("data", Buffer.from("\u001b[A"));
      // Flush promises without advancing the fake clock: the key bypasses the 100ms preview gate.
      await vi.advanceTimersByTimeAsync(0);
      expect(output.chunks.length).toBeGreaterThan(0);
    } finally {
      signals.emit("SIGTERM");
      await vi.advanceTimersByTimeAsync(0);
      await running;
      vi.useRealTimers();
    }
  });

  it("leaves the pane alone when the next frame is the painted one", async () => {
    const input = new Input();
    const output = new Output();
    const running = runFleet(transport() as never, input, output, new EventEmitter());
    await vi.waitFor(() => expect(input.isRaw).toBe(true));
    await vi.waitFor(() =>
      expect(Buffer.concat(output.chunks).toString()).toContain("Describe a task"));

    // The idle cadence collects a snapshot about ten times a second. An unchanged frame that
    // repainted anyway is a flash the operator sees for no change at all.
    output.chunks.length = 0;
    await new Promise((resolve) => { setTimeout(resolve, 1_200); });
    expect(Buffer.concat(output.chunks).toString()).toBe("");

    input.emit("data", Buffer.from([0x03, 0x03]));
    await expect(running).resolves.toBeUndefined();
  });

  it("holds the caret still while an orchestrator streams underneath the composer", async () => {
    const input = new Input();
    const output = new Output();
    // The draft never changes; only the orc's output does. Every repaint the operator sees from
    // here is poll-driven, which is the case the key-driven test above cannot reach.
    const draft = "日本 build";
    let streamed = "thinking";
    const record = () => session({
      id: "99999999-0000-4000-8000-000000000001",
      kind: "orchestrator",
      role: "orchestrator",
      cwd: "/repo/one",
      name: "Orc",
      latestPreview: streamed,
    });
    const running = runFleet(
      transport(() => [record()]) as never,
      input,
      output,
      new EventEmitter(),
    );
    await vi.waitFor(() => expect(input.isRaw).toBe(true));

    input.emit("data", Buffer.from(draft));
    await vi.waitFor(
      () => expect(Buffer.concat(output.chunks).toString()).toContain(`› ${draft}`),
      { timeout: 5_000, interval: 20 },
    );

    // Three ideograph cells plus a Latin tail: counting the string rather than the grid would put
    // the caret two columns inside the operator's own text.
    const column = displayWidth(`› ${draft}`) + 1;
    expect(column).toBe(13);
    expect(column).not.toBe([...`› ${draft}`].length + 1);

    output.chunks.length = 0;
    // Short enough to survive the preview column's own truncation, so each one is visibly a
    // different frame rather than the same elided prefix three times. One of them is ideographic,
    // because a row measured in code points prints wider than the pane on that text and the
    // terminal soft-wraps the overrun onto a line of its own — which walks the composer, and the
    // caret sitting on it, down a row and back again as the orc streams.
    for (const chunk of ["alpha", "日本語", "delta"]) {
      streamed = chunk;
      await vi.waitFor(
        () => expect(Buffer.concat(output.chunks).toString()).toContain(chunk),
        { timeout: 5_000, interval: 20 },
      );
    }

    // One write per frame, so a chunk is a frame. Each one addresses the preview row and then the
    // retained composer's caret — last, after the damage is on screen — without rewriting it.
    const frames = output.chunks.map((chunk) => chunk.toString());
    expect(frames.length).toBeGreaterThanOrEqual(3);
    const rows = new Set<string>();
    for (const frame of frames) {
      expect(frame).toMatch(/^\u001b\[\?25l\u001b\[\d+;1H/u);
      expect(frame).not.toContain("\u001b[H");
      expect(frame).not.toContain("\n");
      expect(frame.match(/\u001b\[\?25h/gu) ?? []).toHaveLength(1);
      expect(frame.match(/\u001b\[\?25l/gu) ?? []).toHaveLength(1);
      const addresses = frame.match(/\u001b\[\d+;\d+H/gu) ?? [];
      expect(addresses).toHaveLength(2);
      const caretAddress = addresses.at(-1)!;
      expect(frame.endsWith(`${caretAddress}\u001b[?25h`)).toBe(true);
      expect(caretAddress).toMatch(new RegExp(`^\u001b\\[\\d+;${column}H$`, "u"));
      rows.add(caretAddress);
      expect(frame).not.toContain(`› ${draft}`);
      // Escape sequences steer rather than print. Removing the address and tail erase leaves the
      // one damaged row, which still fits without a terminal soft-wrap.
      const caretSequence = `${caretAddress}\u001b[?25h`;
      const damage = frame.slice(
        `\u001b[?25l${addresses[0]}`.length,
        frame.length - caretSequence.length,
      );
      expect(displayWidth(damage.replace(/\u001b\[K$/u, ""))).toBeLessThanOrEqual(output.columns);
    }
    // Same cell in every frame: the streaming rows above the composer never shift it.
    expect(rows.size).toBe(1);

    input.emit("data", Buffer.from([0x03, 0x03]));
    await expect(running).resolves.toBeUndefined();
  });
});

describe("directed handoff", () => {
  const ORC_ID = "99999999-0000-4000-8000-000000000001";
  const WORKER_A = "00000000-0000-4000-8000-00000000000a";
  const WORKER_B = "00000000-0000-4000-8000-00000000000b";

  /** One live orc and two workers, with the first worker selected. */
  function handoffFleet(overrides: Partial<SessionRecord> = {}): FleetSnapshot {
    return fleet(
      {
        record: session({
          id: ORC_ID,
          kind: "orchestrator",
          role: "orchestrator",
          name: "Receiving orc",
          cwd: "/repo/one",
          ...overrides,
        }),
      },
      {
        record: session({
          id: WORKER_A,
          kind: "worker",
          role: "worker",
          name: "Alpha worker",
          cwd: "/repo/one",
        }),
      },
      {
        record: session({
          id: WORKER_B,
          kind: "worker",
          role: "worker",
          name: "Bravo worker",
          cwd: "/repo/one",
        }),
      },
    );
  }

  /** The same fleet with one worker having exited under the operator. */
  function exiting(snapshot: FleetSnapshot, sessionId: string): FleetSnapshot {
    return fleet(...snapshot.threads.map(({ record }) => ({
      record: record.id === sessionId
        ? { ...record, executionState: "exited" as const, exitCode: 0 }
        : record,
    })));
  }

  function selecting(snapshot: FleetSnapshot, sessionId: string): FleetState {
    return { ...createFleetState(snapshot), selectedSessionId: sessionId };
  }

  it("marks and unmarks the focused worker with ctrl+d", () => {
    const snapshot = handoffFleet();
    const marked = transitionFleet(selecting(snapshot, WORKER_A), snapshot, "ctrl+d", NOW_MS);

    expect(marked.state.handoffMarks).toEqual([WORKER_A]);
    expect(marked.state.notice).toBe("1 worker marked · /handoff to send");

    const both = transitionFleet(
      { ...marked.state, selectedSessionId: WORKER_B },
      snapshot,
      "ctrl+d",
      NOW_MS,
    );
    expect(both.state.handoffMarks).toEqual([WORKER_A, WORKER_B]);
    expect(both.state.notice).toBe("2 workers marked · /handoff to send");

    const unmarked = transitionFleet(both.state, snapshot, "ctrl+d", NOW_MS);
    expect(unmarked.state.handoffMarks).toEqual([WORKER_A]);
  });

  it("keeps the 64-worker handoff cap while leaving the marked batch available", () => {
    const workerIds = Array.from(
      { length: 65 },
      (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    );
    const snapshot = fleet(
      {
        record: session({
          id: ORC_ID,
          kind: "orchestrator",
          role: "orchestrator",
          name: "Receiving orc",
          cwd: "/repo/one",
        }),
      },
      ...workerIds.map((id, index) => ({
        record: session({
          id,
          kind: "worker",
          role: "worker",
          name: `Worker ${index + 1}`,
          cwd: "/repo/one",
        }),
      })),
    );
    const marked = workerIds.slice(1);

    const refused = transitionFleet(
      { ...selecting(snapshot, workerIds[0]!), handoffMarks: marked },
      snapshot,
      "ctrl+d",
      NOW_MS,
    );

    expect(refused.state.handoffMarks).toEqual(marked);
    expect(refused.state.notice).toBe("A handoff can include at most 64 workers");
    expect(refused.state.noticeTone).toBe("warning");
  });

  it("refuses to mark an orchestrator, which receives handoffs rather than being one", () => {
    const snapshot = handoffFleet();
    const refused = transitionFleet(selecting(snapshot, ORC_ID), snapshot, "ctrl+d", NOW_MS);

    expect(refused.state.handoffMarks).toBeUndefined();
    expect(refused.state.notice).toBe("An orchestrator receives a handoff; it is not marked for one");
  });

  it("refuses to mark a terminal worker", () => {
    const snapshot = handoffFleet();
    const terminalSnapshot = fleet(...snapshot.threads.map(({ record }) => ({
      record: record.id === WORKER_A
        ? { ...record, executionState: "exited" as const, exitCode: 0 }
        : record,
    })));

    const refused = transitionFleet(
      selecting(terminalSnapshot, WORKER_A),
      terminalSnapshot,
      "ctrl+d",
      NOW_MS,
    );

    expect(refused.state.handoffMarks).toBeUndefined();
    expect(refused.state.notice).toBe("A terminal worker cannot be handed off");
    expect(refused.state.noticeTone).toBe("warning");
  });

  it("shows the mark in the gutter without moving any column", () => {
    const snapshot = handoffFleet();
    const plain = renderFleet(snapshot, selecting(snapshot, WORKER_A), {
      color: false, width: 150, height: 40, now: NOW_MS, home: "/Users/brandon",
    });
    const marked = renderFleet(
      snapshot,
      transitionFleet(selecting(snapshot, WORKER_A), snapshot, "ctrl+d", NOW_MS).state,
      { color: false, width: 150, height: 40, now: NOW_MS, home: "/Users/brandon" },
    );
    const rowOf = (rendered: string) =>
      rendered.split("\n").find((line) => line.includes("Alpha worker"))!;

    expect(rowOf(marked)).toContain("✓");
    expect(rowOf(plain)).not.toContain("✓");
    // The mark rides in the gutter cell that was always blank, so the row is the same width and
    // every column after it lands in the same place.
    expect(displayWidth(rowOf(marked))).toBe(displayWidth(rowOf(plain)));
    expect(rowOf(marked).indexOf("Alpha worker")).toBe(rowOf(plain).indexOf("Alpha worker"));
  });

  it("drops a mark whose worker has gone away", () => {
    const snapshot = handoffFleet();
    const marked = transitionFleet(selecting(snapshot, WORKER_A), snapshot, "ctrl+d", NOW_MS).state;
    const withoutAlpha = fleet(
      ...snapshot.threads.filter(({ record }) => record.id !== WORKER_A)
        .map(({ record }) => ({ record })),
    );

    const after = transitionFleet(marked, withoutAlpha, "ctrl+l", NOW_MS);
    expect(after.state.handoffMarks).toEqual([]);
  });

  it("drops a mark when a live worker becomes terminal", () => {
    const snapshot = handoffFleet();
    const marked = transitionFleet(selecting(snapshot, WORKER_A), snapshot, "ctrl+d", NOW_MS).state;
    const terminalSnapshot = fleet(...snapshot.threads.map(({ record }) => ({
      record: record.id === WORKER_A
        ? { ...record, executionState: "exited" as const, exitCode: 0 }
        : record,
    })));

    const after = transitionFleet(marked, terminalSnapshot, "ctrl+l", NOW_MS);
    expect(after.state.handoffMarks).toEqual([]);
  });

  it("walks /handoff from the marked batch to a recipient and a directive", () => {
    const snapshot = handoffFleet();
    const marked = transitionFleet(selecting(snapshot, WORKER_A), snapshot, "ctrl+d", NOW_MS).state;
    const opened = transitionFleet({ ...marked, draft: "/handoff" }, snapshot, "enter", NOW_MS);

    expect(opened.state.handoffPicker).toEqual({
      step: "recipient",
      workerIds: [WORKER_A],
      focusSessionId: ORC_ID,
    });
    expect(opened.state.draft).toBe("");

    const rendered = renderFleet(snapshot, opened.state, {
      color: false, width: 120, height: 30, now: NOW_MS, home: "/Users/brandon",
    });
    expect(rendered).toContain("Handoff  1 of 2");
    expect(rendered).toContain("Workers (1)");
    expect(rendered).toContain("Alpha worker");
    expect(rendered).toContain("Receiving orc");

    const chosen = transitionFleet(opened.state, snapshot, "enter", NOW_MS);
    expect(chosen.state.handoffPicker).toEqual({
      step: "directive",
      workerIds: [WORKER_A],
      recipientSessionId: ORC_ID,
      draft: "",
      mutationId: expect.any(String),
    });
    const mutationId = chosen.state.handoffPicker?.step === "directive"
      ? chosen.state.handoffPicker.mutationId
      : undefined;
    expect(mutationId).toBeDefined();

    let typing = chosen;
    for (const character of "Rebase it") {
      typing = transitionFleet(typing.state, snapshot, character, NOW_MS);
    }
    expect(renderFleet(snapshot, typing.state, {
      color: false, width: 120, height: 30, now: NOW_MS, home: "/Users/brandon",
    })).toContain("Directive for Receiving orc");

    const sent = transitionFleet(typing.state, snapshot, "enter", NOW_MS);
    expect(sent.action).toEqual({
      type: "handoff",
      workerIds: [WORKER_A],
      recipientSessionId: ORC_ID,
      directive: "Rebase it",
      mutationId,
    });
    // The marks stay until the broker says the transfer committed.
    expect(sent.state.handoffMarks).toEqual([WORKER_A]);
    expect(sent.state.handoffPicker).toBeUndefined();
  });

  it("drops a worker that exits while the picker is open, keeping the directive typed", () => {
    const snapshot = handoffFleet();
    const first = transitionFleet(selecting(snapshot, WORKER_A), snapshot, "ctrl+d", NOW_MS).state;
    const marked = transitionFleet(
      { ...first, selectedSessionId: WORKER_B },
      snapshot,
      "ctrl+d",
      NOW_MS,
    ).state;
    const opened = transitionFleet({ ...marked, draft: "/handoff" }, snapshot, "enter", NOW_MS);
    const chosen = transitionFleet(opened.state, snapshot, "enter", NOW_MS);
    let typing = chosen;
    for (const character of "Rebase it") {
      typing = transitionFleet(typing.state, snapshot, character, NOW_MS);
    }

    // Alpha exits with the directive already typed and the picker still open.
    const exited = exiting(snapshot, WORKER_A);
    const sent = transitionFleet(typing.state, exited, "enter", NOW_MS);

    expect(sent.action).toMatchObject({
      type: "handoff",
      workerIds: [WORKER_B],
      directive: "Rebase it",
    });
    expect(sent.state.notice).toBe("A terminal worker cannot be handed off; 1 dropped from this handoff");
    expect(sent.state.noticeTone).toBe("warning");
  });

  it("closes the picker when every worker in the batch turns terminal", () => {
    const snapshot = handoffFleet();
    const opened = transitionFleet(
      { ...selecting(snapshot, WORKER_A), draft: "/handoff" },
      snapshot,
      "enter",
      NOW_MS,
    );
    const chosen = transitionFleet(opened.state, snapshot, "enter", NOW_MS);
    let typing = chosen;
    for (const character of "Rebase it") {
      typing = transitionFleet(typing.state, snapshot, character, NOW_MS);
    }

    const exited = exiting(snapshot, WORKER_A);
    const sent = transitionFleet(typing.state, exited, "enter", NOW_MS);

    expect(sent.action).toBeUndefined();
    expect(sent.state.handoffPicker).toBeUndefined();
    expect(sent.state.notice).toBe("A terminal worker cannot be handed off");
    expect(sent.state.noticeTone).toBe("warning");
  });

  it("closes the picker at recipient selection when the batch has gone terminal", () => {
    const snapshot = handoffFleet();
    const opened = transitionFleet(
      { ...selecting(snapshot, WORKER_A), draft: "/handoff" },
      snapshot,
      "enter",
      NOW_MS,
    );
    expect(opened.state.handoffPicker).toMatchObject({ step: "recipient" });

    const exited = exiting(snapshot, WORKER_A);
    const advanced = transitionFleet(opened.state, exited, "enter", NOW_MS);

    expect(advanced.state.handoffPicker).toBeUndefined();
    expect(advanced.state.notice).toBe("A terminal worker cannot be handed off");
  });

  it("falls back to the selected worker when nothing is marked", () => {
    const snapshot = handoffFleet();
    const opened = transitionFleet(
      { ...selecting(snapshot, WORKER_B), draft: "/handoff" },
      snapshot,
      "enter",
      NOW_MS,
    );
    expect(opened.state.handoffPicker).toMatchObject({ workerIds: [WORKER_B] });
  });

  it("refuses /handoff with an orchestrator selected and nothing marked", () => {
    const snapshot = handoffFleet();
    const refused = transitionFleet(
      { ...selecting(snapshot, ORC_ID), draft: "/handoff" },
      snapshot,
      "enter",
      NOW_MS,
    );
    expect(refused.state.handoffPicker).toBeUndefined();
    expect(refused.state.notice).toBe("Mark workers with ctrl+d, or select one, before /handoff");
  });

  it("refuses /handoff falling back to a terminal worker, keeping the directive unasked", () => {
    const snapshot = handoffFleet();
    const terminalSnapshot = fleet(...snapshot.threads.map(({ record }) => ({
      record: record.id === WORKER_A
        ? { ...record, executionState: "exited" as const, exitCode: 0 }
        : record,
    })));

    const refused = transitionFleet(
      { ...selecting(terminalSnapshot, WORKER_A), draft: "/handoff" },
      terminalSnapshot,
      "enter",
      NOW_MS,
    );

    expect(refused.state.handoffPicker).toBeUndefined();
    // The same answer ctrl+d gives, rather than two picker steps and a typed directive the broker
    // would then throw away.
    expect(refused.state.notice).toBe("A terminal worker cannot be handed off");
    expect(refused.state.noticeTone).toBe("warning");
  });

  it("refuses /handoff when no orchestrator is live to receive it", () => {
    const snapshot = handoffFleet({ executionState: "exited", exitCode: 0 });
    const refused = transitionFleet(
      { ...selecting(snapshot, WORKER_A), draft: "/handoff" },
      snapshot,
      "enter",
      NOW_MS,
    );
    expect(refused.state.handoffPicker).toBeUndefined();
    expect(refused.state.notice).toBe("No live orchestrator to receive a handoff");
  });

  it("filters workspace-scoped recipients that do not cover every worker cwd", () => {
    const snapshot = handoffFleet({
      orchestratorScope: "workspace",
      cwd: "/repo/two",
    });
    const refused = transitionFleet(
      { ...selecting(snapshot, WORKER_A), draft: "/handoff" },
      snapshot,
      "enter",
      NOW_MS,
    );

    expect(refused.state.handoffPicker).toBeUndefined();
    expect(refused.state.notice).toBe("No live orchestrator covers every worker workspace");
  });

  it("offers a fleet-scoped recipient regardless of worker cwd", () => {
    const snapshot = handoffFleet({
      orchestratorScope: "fleet",
      cwd: "/repo/two",
    });
    const opened = transitionFleet(
      { ...selecting(snapshot, WORKER_A), draft: "/handoff" },
      snapshot,
      "enter",
      NOW_MS,
    );

    expect(opened.state.handoffPicker).toMatchObject({ focusSessionId: ORC_ID });
  });

  it("refuses an empty directive and backs out one step at a time", () => {
    const snapshot = handoffFleet();
    const opened = transitionFleet(
      { ...selecting(snapshot, WORKER_A), draft: "/handoff" },
      snapshot,
      "enter",
      NOW_MS,
    );
    const directive = transitionFleet(opened.state, snapshot, "enter", NOW_MS);

    const empty = transitionFleet(directive.state, snapshot, "enter", NOW_MS);
    expect(empty.action).toBeUndefined();
    expect(empty.state.notice).toBe("A handoff needs a directive");

    const back = transitionFleet(empty.state, snapshot, "escape", NOW_MS);
    expect(back.state.handoffPicker).toMatchObject({ step: "recipient", focusSessionId: ORC_ID });

    const closed = transitionFleet(back.state, snapshot, "escape", NOW_MS);
    expect(closed.state.handoffPicker).toBeUndefined();
    // Backing out of the gesture never unmarks what the operator marked.
    expect(closed.state.handoffMarks).toBeUndefined();
  });

  it("keeps an overlong directive in the picker for correction", () => {
    const snapshot = handoffFleet();
    const opened = transitionFleet(
      { ...selecting(snapshot, WORKER_A), draft: "/handoff" },
      snapshot,
      "enter",
      NOW_MS,
    );
    const directive = transitionFleet(opened.state, snapshot, "enter", NOW_MS);
    const draft = "x".repeat(HANDOFF_LIMITS.directiveChars + 1);
    const refused = transitionFleet({
      ...directive.state,
      handoffPicker: {
        step: "directive",
        workerIds: [WORKER_A],
        recipientSessionId: ORC_ID,
        draft,
        mutationId: "handoff-overlong",
      },
    }, snapshot, "enter", NOW_MS);

    expect(refused.action).toBeUndefined();
    expect(refused.state.handoffPicker).toMatchObject({ step: "directive", draft });
    expect(refused.state.notice).toBe(
      `A handoff directive can contain at most ${HANDOFF_LIMITS.directiveChars} characters`,
    );
    expect(refused.state.noticeTone).toBe("error");
  });

  it("performs the handoff through the broker and clears the marks it committed", async () => {
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

    const snapshot = handoffFleet();
    const records = snapshot.threads.map(({ record }) => record);
    const transport = {
      request: vi.fn(async (method: string) => {
        if (method === "session.list") return records;
        if (method === "session.snapshot") return { data: "" };
        if (method === "fleet.preferences") return {};
        if (method === "fleet.folderDispositions") return {};
        if (method === "fleet.workerHandoff") {
          return {
            committed: true,
            recipientSessionId: ORC_ID,
            recipientControllerId: "orchestrator:fleet",
            handoffId: "77777777-7777-4777-8777-777777777777",
            directive: "Rebase it",
            transferred: [{ workerId: WORKER_A, code: "TRANSFERRED" }],
            blocked: [],
            delivery: "delivered",
          };
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
    const running = runFleet(transport as never, input as never, output as never, new EventEmitter());
    await vi.waitFor(() => expect(input.isRaw).toBe(true));

    // Focus starts on the orc row, so the mark chord has to walk down past the folder header.
    input.emit("data", Buffer.from("\u001b[B"));
    input.emit("data", Buffer.from("\u001b[B"));
    input.emit("data", Buffer.from([0x04]));
    await vi.waitFor(() => expect(
      Buffer.concat(output.chunks).toString("utf8"),
    ).toContain("1 worker marked"));

    input.emit("data", Buffer.from("/handoff"));
    input.emit("data", Buffer.from("\r"));
    await vi.waitFor(() => expect(
      Buffer.concat(output.chunks).toString("utf8"),
    ).toContain("Handoff  1 of 2"));

    input.emit("data", Buffer.from("\r"));
    const directive = `Rebase ${"x".repeat(output.columns * 2)}`;
    const firstDirectiveChunk = output.chunks.length;
    input.emit("data", Buffer.from(directive));
    input.emit("data", Buffer.from("\r"));

    await vi.waitFor(() => expect(transport.request).toHaveBeenCalledWith("fleet.workerHandoff", {
      recipientSessionId: ORC_ID,
      workerIds: [WORKER_A],
      directive,
      mutationId: expect.any(String),
    }));
    const directiveRows = output.chunks.slice(firstDirectiveChunk)
      .flatMap((chunk) => chunk.toString("utf8").split(/\n|\u001b\[\d+;\d+H/gu))
      .map((row) => row.replaceAll(/\u001b\[[?0-9;]*[A-Za-z]/gu, ""))
      .filter((row) => row.startsWith("› ") && row.endsWith("▌"));
    expect(directiveRows.length).toBeGreaterThan(0);
    expect(directiveRows.every((row) => displayWidth(row) <= output.columns)).toBe(true);
    expect(directiveRows.at(-1)).toMatch(/^› …/u);
    expect(directiveRows.at(-1)).toMatch(new RegExp(`${directive.slice(-20)}▌$`, "u"));
    await vi.waitFor(() => {
      const screen = Buffer.concat(output.chunks).toString("utf8");
      expect(screen).toContain("1 worker handed off");
      // The mark is spent with the transfer, so the row goes back to plain. The newest frame is
      // the one that matters: every earlier one is still in the accumulated output.
      expect(screen.split("\n").filter((line) => line.includes("Alpha worker")).at(-1))
        .not.toContain("✓");
    });

    input.emit("data", Buffer.from([0x03, 0x03]));
    await expect(running).resolves.toBeUndefined();
  });

  it("retries a transport-failed handoff with the same directive and mutation id", async () => {
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

    const snapshot = handoffFleet();
    const records = snapshot.threads.map(({ record }) => record);
    const handoffRequests: Array<Record<string, unknown>> = [];
    const transport = {
      request: vi.fn(async (method: string, params?: Record<string, unknown>) => {
        if (method === "session.list") return records;
        if (method === "session.snapshot") return { data: "" };
        if (method === "fleet.preferences") return {};
        if (method === "fleet.folderDispositions") return {};
        if (method === "fleet.workerHandoff") {
          handoffRequests.push(params ?? {});
          if (handoffRequests.length === 1) throw new Error("connection reset");
          return {
            committed: true,
            recipientSessionId: ORC_ID,
            recipientControllerId: "orchestrator:fleet",
            handoffId: "77777777-7777-4777-8777-777777777777",
            directive: "Rebase it",
            transferred: [{ workerId: WORKER_A, code: "TRANSFERRED" }],
            blocked: [],
            delivery: "delivered",
          };
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
    const running = runFleet(transport as never, input as never, output as never, new EventEmitter());
    await vi.waitFor(() => expect(input.isRaw).toBe(true));

    input.emit("data", Buffer.from("\u001b[B"));
    input.emit("data", Buffer.from("\u001b[B"));
    input.emit("data", Buffer.from([0x04]));
    input.emit("data", Buffer.from("/handoff"));
    input.emit("data", Buffer.from("\r"));
    await vi.waitFor(() => expect(
      Buffer.concat(output.chunks).toString("utf8"),
    ).toContain("Handoff  1 of 2"));
    input.emit("data", Buffer.from("\r"));
    input.emit("data", Buffer.from("Rebase it"));
    input.emit("data", Buffer.from("\r"));

    await vi.waitFor(() => expect(handoffRequests).toHaveLength(1));
    await vi.waitFor(() => expect(
      Buffer.concat(output.chunks).toString("utf8"),
    ).toContain("connection reset"));
    input.emit("data", Buffer.from("\r"));

    await vi.waitFor(() => expect(handoffRequests).toHaveLength(2));
    expect(handoffRequests[1]).toEqual(handoffRequests[0]);
    expect(handoffRequests[1]).toMatchObject({
      recipientSessionId: ORC_ID,
      workerIds: [WORKER_A],
      directive: "Rebase it",
      mutationId: expect.any(String),
    });
    await vi.waitFor(() => expect(
      Buffer.concat(output.chunks).toString("utf8"),
    ).toContain("1 worker handed off"));

    input.emit("data", Buffer.from([0x03, 0x03]));
    await expect(running).resolves.toBeUndefined();
  });

  it("keeps the marks and says why when the broker refuses the batch", async () => {
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

    const snapshot = handoffFleet();
    const records = snapshot.threads.map(({ record }) => record);
    const transport = {
      request: vi.fn(async (method: string) => {
        if (method === "session.list") return records;
        if (method === "session.snapshot") return { data: "" };
        if (method === "fleet.preferences") return {};
        if (method === "fleet.folderDispositions") return {};
        if (method === "fleet.workerHandoff") {
          return {
            committed: false,
            recipientSessionId: ORC_ID,
            directive: "Rebase it",
            transferred: [],
            blocked: [{
              workerId: WORKER_A,
              code: "WORKER_TERMINAL",
              detail: "Worker already finished",
            }],
            delivery: "not-attempted",
          };
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
    const running = runFleet(transport as never, input as never, output as never, new EventEmitter());
    await vi.waitFor(() => expect(input.isRaw).toBe(true));

    input.emit("data", Buffer.from("\u001b[B"));
    input.emit("data", Buffer.from("\u001b[B"));
    input.emit("data", Buffer.from([0x04]));
    input.emit("data", Buffer.from("/handoff"));
    input.emit("data", Buffer.from("\r"));
    await vi.waitFor(() => expect(
      Buffer.concat(output.chunks).toString("utf8"),
    ).toContain("Handoff  1 of 2"));
    input.emit("data", Buffer.from("\r"));
    input.emit("data", Buffer.from("Rebase it"));
    input.emit("data", Buffer.from("\r"));

    await vi.waitFor(() => {
      const screen = Buffer.concat(output.chunks).toString("utf8");
      expect(screen).toContain("Handoff refused · Worker already finished");
      // Nothing moved, so the operator still holds exactly the batch they marked.
      expect(screen.split("\n").filter((line) => line.includes("Alpha worker")).at(-1))
        .toContain("✓");
    });

    input.emit("data", Buffer.from([0x03, 0x03]));
    await expect(running).resolves.toBeUndefined();
  });
});
