import { describe, expect, it } from "vitest";
import {
  createFleetState,
  renderFleet,
  type FleetSnapshot,
  type FleetThread,
} from "../../src/client/fleet.js";
import { custodyColorTone } from "../../src/client/lease-custody.js";
import type { CustodyColor } from "../../src/domain/custody-color.js";
import type { SessionRecord } from "../../src/domain/session.js";

const NOW = "2026-07-28T10:00:00.000Z";
const NOW_MS = Date.parse(NOW);

/** Built rather than pasted, so no raw escape byte ever lands in this file. */
const ESC = String.fromCharCode(27);
const CUSTODY_1 = `${ESC}[38;2;104;178;168m`;
const CUSTODY_2 = `${ESC}[38;2;112;156;204m`;
const CUSTODY_1_FADED = `${ESC}[38;2;62;107;101m`;
const CUSTODY_ANSI = [CUSTODY_1, CUSTODY_2, CUSTODY_1_FADED];
const MUTED = `${ESC}[38;2;154;163;175m`;
const BOLD = `${ESC}[1m`;

const VIEW = {
  color: true,
  width: 220,
  height: 50,
  now: NOW_MS,
  home: "/Users/brandon",
} as const;

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    provider: "claude",
    cwd: "/Users/brandon/code/personal/cyberdeck",
    detached: true,
    sandbox: "read-only",
    name: "Orc one",
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

function worker(id: string, name: string): SessionRecord {
  return session({ id, name, kind: "worker", role: "worker" } as Partial<SessionRecord>);
}

function thread(record: SessionRecord, custodyColor?: CustodyColor): FleetThread {
  return { record, replay: "", ...(custodyColor === undefined ? {} : { custodyColor }) };
}

function render(...threads: FleetThread[]): string[] {
  const snapshot: FleetSnapshot = { threads };
  return renderFleet(snapshot, createFleetState(snapshot), VIEW).split("\n");
}

function rowFor(lines: string[], name: string): string {
  return lines.find((line) => line.includes(name))!;
}

describe("custody color rendering", () => {
  it("colors a worker's leading glyph and nothing else on the row", () => {
    const first = "22222222-2222-4222-8222-222222222222";
    const second = "77777777-7777-4777-8777-777777777777";
    const lines = render(
      thread(worker(first, "Worker one"), { slot: 0, intensity: "active" }),
      thread(worker(second, "Worker six"), { slot: 0, intensity: "active" }),
    );

    // The glyph is the only cell that takes the hue: no rainbow rows.
    for (const name of ["Worker one", "Worker six"]) {
      const row = rowFor(lines, name);
      expect(row).toContain(`${CUSTODY_1}·`);
      expect(row.indexOf(CUSTODY_1)).toBeLessThan(row.indexOf(name));
      expect(row.slice(row.indexOf(name))).not.toContain(CUSTODY_1);
    }
    // The selected row keeps its bold title; every other row keeps the neutral title tone.
    expect(rowFor(lines, "Worker one")).toContain(`${BOLD}Worker one`);
    expect(rowFor(lines, "Worker six")).toContain(`${MUTED}Worker six`);
  });

  it("dims the glyph to the same hue's faded twin once the lease has ended", () => {
    const id = "33333333-3333-4333-8333-333333333333";
    const lines = render(thread(worker(id, "Worker two"), { slot: 0, intensity: "faded" }));
    const row = rowFor(lines, "Worker two");

    expect(row).toContain(`${CUSTODY_1_FADED}·`);
    expect(row).not.toContain(CUSTODY_1);
  });

  it("colors an orchestrator's glyph and its name", () => {
    const lines = render(thread(session({ name: "Orc one" }), { slot: 1, intensity: "active" }));
    const row = rowFor(lines, "Orc one");

    expect(row).toContain(`${CUSTODY_2}·`);
    expect(row).toContain(`${CUSTODY_2}Orc one`);
    // The neutral title tone is gone, so the name reads as the orchestrator's own hue.
    expect(row).not.toContain(`${MUTED}Orc one`);
  });

  it("leaves a worker with no custody on its status tone", () => {
    const id = "44444444-4444-4444-8444-444444444444";
    const row = rowFor(render(thread(worker(id, "Worker three"))), "Worker three");

    for (const ansi of CUSTODY_ANSI) expect(row).not.toContain(ansi);
  });

  it("falls back to the status tone for a slot outside this client's palette", () => {
    const id = "55555555-5555-4555-8555-555555555555";
    const lines = render(thread(worker(id, "Worker four"), { slot: 9, intensity: "active" }));
    const row = rowFor(lines, "Worker four");

    for (const ansi of CUSTODY_ANSI) expect(row).not.toContain(ansi);
  });

  it("keeps custody off the preview, status and identity columns", () => {
    const id = "66666666-6666-4666-8666-666666666666";
    const lines = render(thread(worker(id, "Worker five"), { slot: 0, intensity: "active" }));

    // One occurrence on the whole row, and it is the glyph.
    expect(rowFor(lines, "Worker five").split(CUSTODY_1)).toHaveLength(2);
  });
});

describe("custodyColorTone", () => {
  it("maps each slot to its hue, and each ended lease to that hue's faded twin", () => {
    expect(custodyColorTone({ slot: 0, intensity: "active" })).toBe("custody1");
    expect(custodyColorTone({ slot: 5, intensity: "active" })).toBe("custody6");
    expect(custodyColorTone({ slot: 0, intensity: "faded" })).toBe("custody1Faded");
    expect(custodyColorTone({ slot: 5, intensity: "faded" })).toBe("custody6Faded");
  });

  it("refuses a slot this client has no hue for rather than borrowing one", () => {
    expect(custodyColorTone({ slot: 6, intensity: "active" })).toBeUndefined();
    expect(custodyColorTone({ slot: -1, intensity: "active" })).toBeUndefined();
    expect(custodyColorTone({ slot: 1.5, intensity: "active" })).toBeUndefined();
  });
});
