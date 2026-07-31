import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CUSTODY_COLOR_SLOT_COUNT,
  CustodyColorTableSchema,
  FADED_CUSTODY_MAX_AGE_MS,
  allocateCustodyColorSlot,
  custodyColor,
  reconcileCustodyColorTable,
  releaseCustodyColorSlot,
  type CustodyColorTable,
} from "../../src/domain/custody-color.js";
import type { LeaseState, OwnershipSubject } from "../../src/domain/worker-coordination.js";
import { OwnershipSubjectSchema } from "../../src/domain/worker-coordination.js";

const baseMs = Date.parse("2026-07-28T09:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function at(offsetMs: number): string {
  return new Date(baseMs + offsetMs).toISOString();
}

function subject(input: {
  controllerId?: string;
  state?: LeaseState;
  endedAt?: string;
}): OwnershipSubject {
  const state = input.state ?? "active";
  const ended = input.endedAt ?? at(0);
  return OwnershipSubjectSchema.parse({
    schemaVersion: 1,
    subjectId: randomUUID(),
    subjectKind: "worker",
    origin: {
      creatorControllerId: input.controllerId ?? "orchestrator:fleet",
      taskId: "task-1",
      threadId: "thread-1",
      createdAt: at(0),
    },
    lifecycle: state === "active" ? "working" : "done",
    resources: { eventStreamId: "stream-1" },
    lease: {
      leaseId: randomUUID(),
      version: 1,
      state,
      ...(input.controllerId === undefined ? {} : {
        controller: {
          controllerId: input.controllerId,
          familyId: input.controllerId,
          scope: { kind: "fleet", scopeId: "fleet" },
        },
      }),
      issuedAt: at(0),
      renewedAt: at(0),
      expiresAt: state === "expired" ? ended : at(FADED_CUSTODY_MAX_AGE_MS * 4),
      ...(state === "orphaned" ? { orphanedAt: ended } : {}),
      ...(state === "released" ? { releasedAt: ended } : {}),
    },
    updatedAt: at(0),
  });
}

/** A table where every slot is assigned and released, oldest release on slot 0. */
function exhaustedTable(): CustodyColorTable {
  return CustodyColorTableSchema.parse(
    Array.from({ length: CUSTODY_COLOR_SLOT_COUNT }, (_, slot) => ({
      slot,
      controllerId: `orchestrator:workspace:/repo/${slot}`,
      assignedAt: at(0),
      releasedAt: at((slot + 1) * 1_000),
    })),
  );
}

describe("custodyColor", () => {
  it("is active while the controller holds the lease", () => {
    const table = allocateCustodyColorSlot({
      controllerId: "orchestrator:fleet",
      table: [],
      subjects: [],
      now: at(0),
    }).table;
    const held = subject({ controllerId: "orchestrator:fleet", state: "active" });
    const contested = subject({ controllerId: "orchestrator:fleet", state: "contested" });

    expect(custodyColor(held, table, at(0))).toEqual({ slot: 0, intensity: "active" });
    expect(custodyColor(contested, table, at(0))).toEqual({ slot: 0, intensity: "active" });
  });

  it("fades once the lease is released, orphaned or expired", () => {
    const table = allocateCustodyColorSlot({
      controllerId: "orchestrator:fleet",
      table: [],
      subjects: [],
      now: at(0),
    }).table;
    for (const state of ["released", "orphaned", "expired"] as const) {
      const ended = subject({ controllerId: "orchestrator:fleet", state, endedAt: at(1_000) });
      expect(custodyColor(ended, table, at(2_000))).toEqual({ slot: 0, intensity: "faded" });
    }
  });

  it("goes neutral for an unowned lease and for a controller with no slot", () => {
    const table = allocateCustodyColorSlot({
      controllerId: "orchestrator:fleet",
      table: [],
      subjects: [],
      now: at(0),
    }).table;

    expect(custodyColor(subject({}), [], at(0))).toBeUndefined();
    expect(custodyColor(subject({ controllerId: "orchestrator:other" }), table, at(0)))
      .toBeUndefined();
  });

  it("switches to the adopting orchestrator's hue at full intensity", () => {
    const first = allocateCustodyColorSlot({
      controllerId: "orchestrator:fleet",
      table: [],
      subjects: [],
      now: at(0),
    });
    const table = allocateCustodyColorSlot({
      controllerId: "orchestrator:workspace:/repo",
      table: first.table,
      subjects: [],
      now: at(1_000),
    }).table;

    const adopted = subject({ controllerId: "orchestrator:workspace:/repo", state: "active" });
    expect(custodyColor(adopted, table, at(2_000))).toEqual({ slot: 1, intensity: "active" });
  });

  it("expires a fade older than seven days, lazily at read time", () => {
    const table = allocateCustodyColorSlot({
      controllerId: "orchestrator:fleet",
      table: [],
      subjects: [],
      now: at(0),
    }).table;
    const faded = subject({
      controllerId: "orchestrator:fleet",
      state: "released",
      endedAt: at(0),
    });

    expect(custodyColor(faded, table, at(FADED_CUSTODY_MAX_AGE_MS)))
      .toEqual({ slot: 0, intensity: "faded" });
    expect(custodyColor(faded, table, at(FADED_CUSTODY_MAX_AGE_MS + 1))).toBeUndefined();
  });
});

describe("allocateCustodyColorSlot", () => {
  it("spends a fresh fleet's slots in order", () => {
    let table: CustodyColorTable = [];
    const slots: Array<number | undefined> = [];
    for (let index = 0; index < CUSTODY_COLOR_SLOT_COUNT; index += 1) {
      const allocation = allocateCustodyColorSlot({
        controllerId: `orchestrator:workspace:/repo/${index}`,
        table,
        subjects: [],
        now: at(index * 1_000),
      });
      table = allocation.table;
      slots.push(allocation.slot);
    }

    expect(slots).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("keeps the slot a controller already holds", () => {
    const first = allocateCustodyColorSlot({
      controllerId: "orchestrator:fleet",
      table: [],
      subjects: [],
      now: at(0),
    });
    const again = allocateCustodyColorSlot({
      controllerId: "orchestrator:fleet",
      table: first.table,
      subjects: [],
      now: at(5_000),
    });

    expect(again.slot).toBe(0);
    expect(again.table).toHaveLength(1);
  });

  it("reclaims a released slot for the same controller, relighting its faded workers", () => {
    const first = allocateCustodyColorSlot({
      controllerId: "orchestrator:fleet",
      table: [],
      subjects: [],
      now: at(0),
    });
    const released = releaseCustodyColorSlot(first.table, "orchestrator:fleet", at(1_000));
    const reclaimed = allocateCustodyColorSlot({
      controllerId: "orchestrator:fleet",
      table: released,
      subjects: [subject({
        controllerId: "orchestrator:fleet",
        state: "released",
        endedAt: at(1_000),
      })],
      now: at(2_000),
    });

    expect(reclaimed.slot).toBe(0);
    expect(reclaimed.table[0]?.releasedAt).toBeUndefined();
    expect(custodyColor(
      subject({ controllerId: "orchestrator:fleet", state: "active" }),
      reclaimed.table,
      at(2_000),
    )).toEqual({ slot: 0, intensity: "active" });
  });

  it("prefers the least recently released slot", () => {
    const table = CustodyColorTableSchema.parse([
      { slot: 0, controllerId: "orchestrator:a", assignedAt: at(0), releasedAt: at(9_000) },
      { slot: 1, controllerId: "orchestrator:b", assignedAt: at(0), releasedAt: at(1_000) },
      { slot: 2, controllerId: "orchestrator:c", assignedAt: at(0), releasedAt: at(5_000) },
    ]);

    const allocation = allocateCustodyColorSlot({
      controllerId: "orchestrator:d",
      table,
      subjects: [],
      now: at(10_000),
    });

    // Slots 3..5 were never used, and never-used sorts ahead of ever-released.
    expect(allocation.slot).toBe(3);
    expect(allocateCustodyColorSlot({
      controllerId: "orchestrator:d",
      table: table.filter((entry) => entry.slot !== 3),
      subjects: [
        subject({ controllerId: "orchestrator:untracked" }),
      ],
      now: at(10_000),
    }).slot).toBe(3);
  });

  it("skips a released slot while workers are still fading on it", () => {
    // Every slot released, slot 0 longest ago, so slot 0 is what release order would pick.
    const table = exhaustedTable();
    const fading = subject({
      controllerId: table[0]!.controllerId,
      state: "released",
      endedAt: at(1_000),
    });

    // Turn 7 must not reuse turn 1's hue while turn 1's ex-workers still wear it.
    expect(allocateCustodyColorSlot({
      controllerId: "orchestrator:newcomer",
      table,
      subjects: [fading],
      now: at(2_000),
    }).slot).toBe(1);

    // Once the fade has aged out, the slot is available again and wins on release order.
    expect(allocateCustodyColorSlot({
      controllerId: "orchestrator:newcomer",
      table,
      subjects: [fading],
      now: at(1_000 + FADED_CUSTODY_MAX_AGE_MS + 1),
    }).slot).toBe(0);
  });

  it("evicts the oldest faded cohort when every slot is spoken for", () => {
    const table = exhaustedTable();
    const subjects = table.map((entry, index) => subject({
      controllerId: entry.controllerId,
      state: "released",
      // Slot 2's cohort stopped growing first, so it is the one evicted.
      endedAt: at(index === 2 ? 2_000 : 100_000 + index * 1_000),
    }));

    const allocation = allocateCustodyColorSlot({
      controllerId: "orchestrator:newcomer",
      table,
      subjects,
      now: at(200_000),
    });

    expect(allocation.slot).toBe(2);
    expect(allocation.table).toHaveLength(CUSTODY_COLOR_SLOT_COUNT);
    // The evicted cohort drops to neutral; every other cohort keeps its hue.
    expect(custodyColor(subjects[2]!, allocation.table, at(200_000))).toBeUndefined();
    expect(custodyColor(subjects[3]!, allocation.table, at(200_000)))
      .toEqual({ slot: 3, intensity: "faded" });
  });

  it("leaves the newcomer uncolored when every slot is held by a live orchestrator", () => {
    let table: CustodyColorTable = [];
    for (let index = 0; index < CUSTODY_COLOR_SLOT_COUNT; index += 1) {
      table = allocateCustodyColorSlot({
        controllerId: `orchestrator:workspace:/repo/${index}`,
        table,
        subjects: [],
        now: at(index * 1_000),
      }).table;
    }

    const allocation = allocateCustodyColorSlot({
      controllerId: "orchestrator:newcomer",
      table,
      subjects: [],
      now: at(10_000),
    });

    expect(allocation.slot).toBeUndefined();
    expect(allocation.table).toEqual(table);
  });

  it("never evicts a slot a live orchestrator holds", () => {
    const live = allocateCustodyColorSlot({
      controllerId: "orchestrator:live",
      table: exhaustedTable().filter((entry) => entry.slot !== 0),
      subjects: [],
      now: at(0),
    });
    const subjects = live.table
      .filter((entry) => entry.controllerId !== "orchestrator:live")
      .map((entry, index) => subject({
        controllerId: entry.controllerId,
        state: "released",
        endedAt: at(100_000 + index * 1_000),
      }));
    subjects.push(subject({ controllerId: "orchestrator:live", state: "active" }));

    const allocation = allocateCustodyColorSlot({
      controllerId: "orchestrator:newcomer",
      table: live.table,
      subjects,
      now: at(200_000),
    });

    expect(allocation.slot).not.toBe(0);
    expect(allocation.table.find((entry) => entry.slot === 0)?.controllerId)
      .toBe("orchestrator:live");
  });
});

describe("releaseCustodyColorSlot", () => {
  it("marks the slot released without freeing it", () => {
    const table = allocateCustodyColorSlot({
      controllerId: "orchestrator:fleet",
      table: [],
      subjects: [],
      now: at(0),
    }).table;

    const released = releaseCustodyColorSlot(table, "orchestrator:fleet", at(1_000));

    expect(released[0]).toMatchObject({ slot: 0, releasedAt: at(1_000) });
    expect(custodyColor(
      subject({ controllerId: "orchestrator:fleet", state: "released", endedAt: at(1_000) }),
      released,
      at(2_000),
    )).toEqual({ slot: 0, intensity: "faded" });
  });

  it("returns the same table when there is nothing to release", () => {
    const table = allocateCustodyColorSlot({
      controllerId: "orchestrator:fleet",
      table: [],
      subjects: [],
      now: at(0),
    }).table;
    const released = releaseCustodyColorSlot(table, "orchestrator:fleet", at(1_000));

    expect(releaseCustodyColorSlot(table, "orchestrator:absent", at(1_000))).toBe(table);
    expect(releaseCustodyColorSlot(released, "orchestrator:fleet", at(2_000))).toBe(released);
  });
});

describe("reconcileCustodyColorTable", () => {
  it("reclaims a slot whose holder has no live binding", () => {
    const table = allocateCustodyColorSlot({
      controllerId: "orchestrator:dead",
      table: [],
      subjects: [],
      now: at(0),
    }).table;

    const reconciled = reconcileCustodyColorTable(table, new Set(), at(1_000));

    expect(reconciled[0]).toMatchObject({ slot: 0, releasedAt: at(1_000) });
  });

  it("never touches a slot whose controller is still live", () => {
    const table = allocateCustodyColorSlot({
      controllerId: "orchestrator:live",
      table: [],
      subjects: [],
      now: at(0),
    }).table;

    const reconciled = reconcileCustodyColorTable(table, new Set(["orchestrator:live"]), at(1_000));

    expect(reconciled).toBe(table);
    expect(reconciled[0]?.releasedAt).toBeUndefined();
  });

  it("returns the same table when nothing is stale", () => {
    const table = allocateCustodyColorSlot({
      controllerId: "orchestrator:fleet",
      table: [],
      subjects: [],
      now: at(0),
    }).table;
    const released = releaseCustodyColorSlot(table, "orchestrator:fleet", at(1_000));

    expect(reconcileCustodyColorTable(released, new Set(), at(2_000))).toBe(released);
  });

  it("marks the slot released rather than deleting it, so a reclaimed slot's leftover workers still fade", () => {
    const table = allocateCustodyColorSlot({
      controllerId: "orchestrator:dead",
      table: [],
      subjects: [],
      now: at(0),
    }).table;

    const reconciled = reconcileCustodyColorTable(table, new Set(), at(1_000));

    expect(custodyColor(
      subject({ controllerId: "orchestrator:dead", state: "released", endedAt: at(1_000) }),
      reconciled,
      at(2_000),
    )).toEqual({ slot: 0, intensity: "faded" });
  });
});

describe("CustodyColorTableSchema", () => {
  it("rejects two controllers on one slot", () => {
    expect(() => CustodyColorTableSchema.parse([
      { slot: 1, controllerId: "orchestrator:a", assignedAt: at(0) },
      { slot: 1, controllerId: "orchestrator:b", assignedAt: at(0) },
    ])).toThrow(/only one assignment/);
  });

  it("rejects a slot outside the palette", () => {
    expect(() => CustodyColorTableSchema.parse([
      { slot: CUSTODY_COLOR_SLOT_COUNT, controllerId: "orchestrator:a", assignedAt: at(0) },
    ])).toThrow();
  });
});

describe("fade cutoff", () => {
  it("is seven days", () => {
    expect(FADED_CUSTODY_MAX_AGE_MS).toBe(7 * DAY_MS);
  });
});
