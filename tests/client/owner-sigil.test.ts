import { describe, expect, it } from "vitest";

import type { FleetWorkerCoordinationView } from "../../src/broker/worker-coordination-view.js";
import { LEGACY_CREATOR_CONTROLLER_ID } from "../../src/client/lease-custody.js";
import {
  assignOwnerSigils,
  fleetOwnerSigils,
  ORPHANED_OWNER_SIGIL,
  OWNER_SIGIL_ALPHABET,
  workerOwner,
  workerOwnerSigil,
  type SigilOwner,
} from "../../src/client/owner-sigil.js";
import { displayWidth } from "../../src/client/display-width.js";

const NOW = "2026-08-17T12:00:00.000Z";

function owner(controllerId: string, since = NOW): SigilOwner {
  return { controllerId, since };
}

function orchestrators(count: number, since = NOW): SigilOwner[] {
  return Array.from({ length: count }, (_, index) => owner(`orchestrator:workspace:/repo/${index}`, since));
}

function coordination(overrides: {
  sessionId?: string;
  controllerId?: string;
  creatorControllerId?: string;
  createdAt?: string;
} = {}): FleetWorkerCoordinationView {
  const controlled = overrides.controllerId !== undefined;
  return {
    sessionId: overrides.sessionId ?? "11111111-1111-4111-8111-111111111111",
    subjectId: overrides.sessionId ?? "11111111-1111-4111-8111-111111111111",
    origin: {
      creatorControllerId: overrides.creatorControllerId ?? "orchestrator:fleet",
      taskId: "task-1",
      threadId: overrides.sessionId ?? "11111111-1111-4111-8111-111111111111",
      createdAt: overrides.createdAt ?? NOW,
    },
    ...(controlled
      ? {
        currentController: {
          controllerId: overrides.controllerId!,
          familyId: "family-1",
          scope: "workspace:/repo/one",
        },
      }
      : {}),
    leaseHealth: controlled ? "active" : "orphaned",
    orphaned: !controlled,
    adoptable: !controlled,
  };
}

describe("owner sigil alphabet", () => {
  it("spends exactly one terminal cell per glyph, so the column never shifts a row", () => {
    for (const glyph of OWNER_SIGIL_ALPHABET) {
      expect({ glyph, width: displayWidth(glyph) }).toEqual({ glyph, width: 1 });
    }
    expect(displayWidth(ORPHANED_OWNER_SIGIL)).toBe(1);
  });

  it("keeps the orphan mark out of the alphabet, so no live orc can wear it", () => {
    expect(OWNER_SIGIL_ALPHABET).not.toContain(ORPHANED_OWNER_SIGIL);
  });
});

describe("assignOwnerSigils", () => {
  it("gives every owner a distinct sigil", () => {
    const sigils = assignOwnerSigils(orchestrators(OWNER_SIGIL_ALPHABET.length));

    expect(sigils.size).toBe(OWNER_SIGIL_ALPHABET.length);
    expect(new Set(sigils.values()).size).toBe(OWNER_SIGIL_ALPHABET.length);
  });

  it("returns the same sigil for the same owner every time, with no state in between", () => {
    const roster = orchestrators(5);

    expect([...assignOwnerSigils(roster)]).toEqual([...assignOwnerSigils(roster)]);
  });

  it("does not depend on the order owners are listed in", () => {
    const roster = orchestrators(6);
    const forward = assignOwnerSigils(roster);
    const backward = assignOwnerSigils([...roster].reverse());

    for (const { controllerId } of roster) {
      expect(backward.get(controllerId)).toBe(forward.get(controllerId));
    }
  });

  it("leaves an incumbent's sigil alone when a newer orchestrator joins", () => {
    const incumbents = orchestrators(4, "2026-08-17T09:00:00.000Z");
    const before = assignOwnerSigils(incumbents);
    const after = assignOwnerSigils([
      ...incumbents,
      owner("orchestrator:workspace:/repo/newcomer", "2026-08-17T18:00:00.000Z"),
    ]);

    for (const { controllerId } of incumbents) {
      expect(after.get(controllerId)).toBe(before.get(controllerId));
    }
    expect(after.get("orchestrator:workspace:/repo/newcomer")).toBeDefined();
  });

  it("moves the junior party when two owners prefer the same glyph", () => {
    // Two ids that hash to the same preference, found by search rather than asserted by hand.
    const [first, second] = collidingPair();
    const senior = assignOwnerSigils([
      owner(first, "2026-08-17T09:00:00.000Z"),
      owner(second, "2026-08-17T18:00:00.000Z"),
    ]);
    const alone = assignOwnerSigils([owner(first)]);

    expect(senior.get(first)).toBe(alone.get(first));
    expect(senior.get(second)).not.toBe(senior.get(first));
  });

  it("breaks a seniority tie on the controller id, so the answer is still total", () => {
    const [first, second] = collidingPair();
    const sigils = assignOwnerSigils([owner(second), owner(first)]);
    const expected = [first, second].sort((left, right) => left.localeCompare(right))[0]!;

    expect(sigils.get(expected)).toBe(assignOwnerSigils([owner(expected)]).get(expected));
  });

  it("folds a repeated owner into one entry, keeping its earliest appearance", () => {
    const sigils = assignOwnerSigils([
      owner("orchestrator:fleet", "2026-08-17T18:00:00.000Z"),
      owner("orchestrator:fleet", "2026-08-17T09:00:00.000Z"),
    ]);

    expect(sigils.size).toBe(1);
  });

  it("falls back to letters once the glyph alphabet is spent", () => {
    const roster = orchestrators(OWNER_SIGIL_ALPHABET.length + 4);
    const sigils = assignOwnerSigils(roster);
    const glyphs = new Set<string>(OWNER_SIGIL_ALPHABET);
    const spilled = [...sigils.values()].filter((sigil) => !glyphs.has(sigil));

    expect(sigils.size).toBe(roster.length);
    expect(new Set(sigils.values()).size).toBe(roster.length);
    expect(spilled).toHaveLength(4);
    for (const sigil of spilled) expect(sigil).toMatch(/^[a-z]+$/);
  });

  it("stays collision-free well past the single letters", () => {
    const sigils = assignOwnerSigils(orchestrators(760));

    expect(new Set(sigils.values()).size).toBe(760);
    expect([...sigils.values()].filter((sigil) => sigil.length > 1).length).toBeGreaterThan(0);
  });

  it("assigns nothing for an empty roster", () => {
    expect(assignOwnerSigils([]).size).toBe(0);
  });
});

describe("workerOwner", () => {
  it("reads the current lease controller, never the creator", () => {
    expect(workerOwner(coordination({
      controllerId: "orchestrator:workspace:/repo/adopter",
      creatorControllerId: "orchestrator:workspace:/repo/creator",
    }))).toEqual({ kind: "controlled", controllerId: "orchestrator:workspace:/repo/adopter" });
  });

  it("calls a dispatched worker with no holder orphaned, not owned by its creator", () => {
    expect(workerOwner(coordination({ creatorControllerId: "orchestrator:fleet" })))
      .toEqual({ kind: "orphaned" });
  });

  it("calls a worker that never had a controller unattributed", () => {
    expect(workerOwner(coordination({ creatorControllerId: LEGACY_CREATOR_CONTROLLER_ID })))
      .toEqual({ kind: "unattributed" });
  });
});

describe("workerOwnerSigil", () => {
  const sigils = assignOwnerSigils([owner("orchestrator:fleet")]);

  it("wears its owner's sigil while the lease is held", () => {
    expect(workerOwnerSigil(coordination({ controllerId: "orchestrator:fleet" }), sigils))
      .toBe(sigils.get("orchestrator:fleet"));
  });

  it("wears the orphan mark once the lease names nobody", () => {
    expect(workerOwnerSigil(coordination({ creatorControllerId: "orchestrator:fleet" }), sigils))
      .toBe(ORPHANED_OWNER_SIGIL);
  });

  it("wears nothing at all when nobody ever dispatched it", () => {
    expect(workerOwnerSigil(
      coordination({ creatorControllerId: LEGACY_CREATOR_CONTROLLER_ID }),
      sigils,
    )).toBeUndefined();
  });

  it("wears nothing rather than borrow a glyph when its holder is off the roster", () => {
    expect(workerOwnerSigil(
      coordination({ controllerId: "orchestrator:workspace:/repo/unknown" }),
      sigils,
    )).toBeUndefined();
  });
});

describe("fleetOwnerSigils", () => {
  it("gives a live holder with no orc row a sigil, so its worker never reads as manual", () => {
    const sigils = fleetOwnerSigils({
      orchestrators: [owner("orchestrator:fleet")],
      workers: [coordination({ controllerId: "orchestrator:workspace:/repo/detached" })],
    });

    expect(sigils.get("orchestrator:workspace:/repo/detached")).toBeDefined();
    expect(sigils.get("orchestrator:workspace:/repo/detached"))
      .not.toBe(sigils.get("orchestrator:fleet"));
  });

  it("seeds an off-roster holder from its earliest worker, so the answer does not move", () => {
    const workers = [
      coordination({
        sessionId: "22222222-2222-4222-8222-222222222222",
        controllerId: "orchestrator:workspace:/repo/detached",
        createdAt: "2026-08-17T18:00:00.000Z",
      }),
      coordination({
        sessionId: "33333333-3333-4333-8333-333333333333",
        controllerId: "orchestrator:workspace:/repo/detached",
        createdAt: "2026-08-17T09:00:00.000Z",
      }),
    ];
    const forward = fleetOwnerSigils({ orchestrators: [], workers });
    const backward = fleetOwnerSigils({ orchestrators: [], workers: [...workers].reverse() });

    expect([...forward]).toEqual([...backward]);
  });

  it("ignores orphaned and unattributed workers, which name no owner to assign", () => {
    const sigils = fleetOwnerSigils({
      orchestrators: [],
      workers: [
        coordination({ creatorControllerId: "orchestrator:fleet" }),
        coordination({ creatorControllerId: LEGACY_CREATOR_CONTROLLER_ID }),
      ],
    });

    expect(sigils.size).toBe(0);
  });

  it("lets a senior orc keep its glyph against a colliding off-roster holder", () => {
    const [first, second] = collidingPair();
    const sigils = fleetOwnerSigils({
      orchestrators: [owner(first, "2026-08-17T09:00:00.000Z")],
      workers: [coordination({ controllerId: second, createdAt: "2026-08-17T18:00:00.000Z" })],
    });

    expect(sigils.get(first)).toBe(assignOwnerSigils([owner(first)]).get(first));
    expect(sigils.get(second)).not.toBe(sigils.get(first));
  });
});

/**
 * Two controller ids whose preferred glyph is the same one.
 *
 * Searched for rather than hardcoded: the hash is an implementation detail, and a test that
 * spelled out two ids from it would fail for the wrong reason if it ever changed.
 */
function collidingPair(): [string, string] {
  const seen = new Map<string, string>();
  for (let index = 0; index < 10_000; index += 1) {
    const controllerId = `orchestrator:workspace:/repo/collide-${index}`;
    const sigil = assignOwnerSigils([owner(controllerId)]).get(controllerId)!;
    const previous = seen.get(sigil);
    if (previous !== undefined) return [previous, controllerId];
    seen.set(sigil, controllerId);
  }
  throw new Error("no collision found in the search space");
}
