import { describe, expect, it } from "vitest";

import type { FleetWorkerCoordinationView } from "../../src/broker/worker-coordination-view.js";
import {
  createFleetState,
  renderFleet,
  type FleetSnapshot,
  type FleetState,
  type FleetThread,
} from "../../src/client/fleet.js";
import { LEGACY_CREATOR_CONTROLLER_ID } from "../../src/client/lease-custody.js";
import { ORPHANED_OWNER_SIGIL } from "../../src/client/owner-sigil.js";
import type { SessionRecord } from "../../src/domain/session.js";

const NOW = "2026-08-17T10:00:00.000Z";
const NOW_MS = Date.parse(NOW);

/** Built rather than pasted, so no raw escape byte ever lands in this file. */
const ESC = String.fromCharCode(27);
const DIM = `${ESC}[2m`;
const RESET = `${ESC}[0m`;

const ORC_A = "orchestrator:workspace:/repo/a";
const ORC_B = "orchestrator:workspace:/repo/b";

interface View {
  color: boolean;
  width: number;
  height: number;
  now: number;
  home: string;
}

const VIEW: View = {
  color: true,
  width: 220,
  height: 50,
  now: NOW_MS,
  home: "/Users/brandon",
};

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    provider: "claude",
    cwd: "/Users/brandon/code/personal/cyberdeck",
    detached: true,
    sandbox: "read-only",
    name: "Orc alpha",
    model: "provider-native-model",
    kind: "orchestrator",
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

function orc(id: string, name: string, controllerId: string, createdAt = NOW): FleetThread {
  return { record: session({ id, name, createdAt }), replay: "", controllerId };
}

function coordination(
  sessionId: string,
  owner: { controllerId?: string; creatorControllerId?: string },
): FleetWorkerCoordinationView {
  const controlled = owner.controllerId !== undefined;
  return {
    sessionId,
    subjectId: sessionId,
    origin: {
      creatorControllerId: owner.creatorControllerId ?? owner.controllerId ?? ORC_A,
      taskId: "task-1",
      threadId: sessionId,
      createdAt: NOW,
    },
    ...(controlled
      ? {
        currentController: {
          controllerId: owner.controllerId!,
          familyId: "family-1",
          scope: "workspace:/repo/a",
        },
      }
      : {}),
    leaseHealth: controlled ? "active" : "orphaned",
    orphaned: !controlled,
    adoptable: !controlled,
  };
}

function worker(
  id: string,
  name: string,
  owner?: { controllerId?: string; creatorControllerId?: string },
): FleetThread {
  const record = session({ id, name, kind: "worker", role: "worker" } as Partial<SessionRecord>);
  return {
    record,
    replay: "",
    ...(owner === undefined ? {} : { coordination: coordination(id, owner) }),
  };
}

function render(
  threads: FleetThread[],
  overrides: Partial<FleetState> = {},
  view: Partial<View> = {},
): string[] {
  const snapshot: FleetSnapshot = { threads };
  const state = { ...createFleetState(snapshot, "/Users/brandon"), ...overrides };
  return renderFleet(snapshot, state, { ...VIEW, ...view }).split("\n");
}

function rowFor(lines: string[], name: string): string {
  return lines.find((line) => line.includes(name))!;
}

const ANSI_SEQUENCE = new RegExp(`${ESC}\\[[0-9;]*m`, "gu");

/** What the operator actually sees, with every escape sequence taken back out. */
function plain(row: string): string {
  return row.replace(ANSI_SEQUENCE, "").trimEnd();
}

/** The sigil column is the last thing on the row, so the tail is where it has to be. */
function sigilOf(row: string): string {
  return plain(row).slice(-1);
}

const WORKER_A = "22222222-2222-4222-8222-222222222222";
const WORKER_B = "33333333-3333-4333-8333-333333333333";
const WORKER_MANUAL = "44444444-4444-4444-8444-444444444444";
const WORKER_ORPHAN = "55555555-5555-4555-8555-555555555555";
const ORC_A_ID = "11111111-1111-4111-8111-111111111111";
const ORC_B_ID = "66666666-6666-4666-8666-666666666666";

describe("owner sigil rendering", () => {
  it("closes an owned worker's row with its orchestrator's sigil", () => {
    const lines = render([
      orc(ORC_A_ID, "Orc alpha", ORC_A),
      worker(WORKER_A, "Worker one", { controllerId: ORC_A }),
    ]);
    const sigil = sigilOf(rowFor(lines, "Orc alpha"));

    expect(sigil).not.toBe("");
    // The same shape on the roster row and on the worker row: that pairing is the whole feature.
    expect(sigilOf(rowFor(lines, "Worker one"))).toBe(sigil);
  });

  it("gives two orchestrators different sigils, and their workers follow", () => {
    const lines = render([
      orc(ORC_A_ID, "Orc alpha", ORC_A),
      orc(ORC_B_ID, "Orc beta", ORC_B),
      worker(WORKER_A, "Worker one", { controllerId: ORC_A }),
      worker(WORKER_B, "Worker two", { controllerId: ORC_B }),
    ]);

    expect(sigilOf(rowFor(lines, "Worker one"))).toBe(sigilOf(rowFor(lines, "Orc alpha")));
    expect(sigilOf(rowFor(lines, "Worker two"))).toBe(sigilOf(rowFor(lines, "Orc beta")));
    expect(sigilOf(rowFor(lines, "Orc alpha"))).not.toBe(sigilOf(rowFor(lines, "Orc beta")));
  });

  it("leaves a worker the operator started themselves unmarked", () => {
    const lines = render([
      orc(ORC_A_ID, "Orc alpha", ORC_A),
      worker(WORKER_A, "Worker one", { controllerId: ORC_A }),
      worker(WORKER_MANUAL, "Worker manual", {
        creatorControllerId: LEGACY_CREATOR_CONTROLLER_ID,
      }),
    ]);
    const row = rowFor(lines, "Worker manual");
    const sigil = sigilOf(rowFor(lines, "Worker one"));

    // Absence is the mark: no glyph of its own, and no borrowed one either.
    expect(row).not.toContain(sigil);
    expect(row).not.toContain(ORPHANED_OWNER_SIGIL);
  });

  it("marks a dispatched worker whose lease has no holder as orphaned, not as its creator's", () => {
    const lines = render([
      orc(ORC_A_ID, "Orc alpha", ORC_A),
      worker(WORKER_ORPHAN, "Worker orphan", { creatorControllerId: ORC_A }),
    ]);
    const row = rowFor(lines, "Worker orphan");

    expect(sigilOf(row)).toBe(ORPHANED_OWNER_SIGIL);
    expect(row).not.toContain(sigilOf(rowFor(lines, "Orc alpha")));
  });

  it("keeps the column absent entirely when no thread has an owner", () => {
    const bare = render([
      worker(WORKER_MANUAL, "Worker manual", {
        creatorControllerId: LEGACY_CREATOR_CONTROLLER_ID,
      }),
    ]);
    const owned = render([
      orc(ORC_A_ID, "Orc alpha", ORC_A),
      worker(WORKER_A, "Worker one", { controllerId: ORC_A }),
    ]);

    // A hand-run fleet pays nothing for the column, so its rows end at the age.
    expect(plain(rowFor(bare, "Worker manual"))).toMatch(/[0-9][smhd]$/u);
    expect(plain(rowFor(owned, "Worker one"))).not.toMatch(/[0-9][smhd]$/u);
  });

  it("keeps the sigil when the pane is too narrow for the title it truncates", () => {
    const threads = [
      orc(ORC_A_ID, "Orc alpha", ORC_A),
      worker(WORKER_A, "Worker with a very long name indeed", { controllerId: ORC_A }),
    ];
    const wide = render(threads);
    const narrow = render(threads, {}, { width: 74 });
    const sigil = sigilOf(rowFor(wide, "Orc alpha"));
    const row = narrow.find((line) => line.includes("Worker with"))!;

    expect(row).not.toContain("Worker with a very long name indeed");
    expect(sigilOf(row)).toBe(sigil);
  });
});

describe("ownership lens", () => {
  const threads = [
    orc(ORC_A_ID, "Orc alpha", ORC_A, "2026-08-17T09:00:00.000Z"),
    orc(ORC_B_ID, "Orc beta", ORC_B, "2026-08-17T09:30:00.000Z"),
    worker(WORKER_A, "Worker one", { controllerId: ORC_A }),
    worker(WORKER_B, "Worker two", { controllerId: ORC_B }),
    worker(WORKER_MANUAL, "Worker manual", {
      creatorControllerId: LEGACY_CREATOR_CONTROLLER_ID,
    }),
    worker(WORKER_ORPHAN, "Worker orphan", { creatorControllerId: ORC_A }),
  ];

  /** A dimmed row opens dim and re-asserts it after every reset the cells inside it emit. */
  function dimmed(row: string): boolean {
    return row.startsWith(DIM) && !row.includes(`${RESET}${ESC}[3`);
  }

  it("dims the workers the selected orchestrator does not own, and only those", () => {
    const lines = render(threads, { selectedSessionId: ORC_A_ID });

    expect(dimmed(rowFor(lines, "Worker one"))).toBe(false);
    expect(dimmed(rowFor(lines, "Worker two"))).toBe(true);
    expect(dimmed(rowFor(lines, "Worker manual"))).toBe(true);
    expect(dimmed(rowFor(lines, "Worker orphan"))).toBe(true);
  });

  it("never dims a roster row, which is what the sigil is being read against", () => {
    const lines = render(threads, { selectedSessionId: ORC_A_ID });

    expect(dimmed(rowFor(lines, "Orc alpha"))).toBe(false);
    expect(dimmed(rowFor(lines, "Orc beta"))).toBe(false);
  });

  it("follows the selection onto the other orchestrator", () => {
    const lines = render(threads, { selectedSessionId: ORC_B_ID });

    expect(dimmed(rowFor(lines, "Worker one"))).toBe(true);
    expect(dimmed(rowFor(lines, "Worker two"))).toBe(false);
  });

  it("lifts entirely once the selection leaves the roster", () => {
    const lines = render(threads, { selectedSessionId: WORKER_A });

    for (const name of ["Worker one", "Worker two", "Worker manual", "Worker orphan"]) {
      expect({ name, dimmed: dimmed(rowFor(lines, name)) }).toEqual({ name, dimmed: false });
    }
  });

  it("lifts while a folder header owns the keys, because no orc row is selected then", () => {
    const lines = render(threads, {
      selectedSessionId: ORC_A_ID,
      focusedFolderCwd: "/Users/brandon/code/personal/cyberdeck",
    });

    expect(dimmed(rowFor(lines, "Worker two"))).toBe(false);
  });

  it("dims nothing under --no-color, where there is no dim to apply", () => {
    const lines = render(threads, { selectedSessionId: ORC_A_ID }, { color: false });

    expect(rowFor(lines, "Worker two")).not.toContain(ESC);
    // The sigil is a shape, so it survives the loss of every escape sequence.
    expect(sigilOf(rowFor(lines, "Worker two"))).toBe(sigilOf(rowFor(lines, "Orc beta")));
  });
});
