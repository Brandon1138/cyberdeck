import { describe, expect, it } from "vitest";
import type { FleetWorkerCoordinationView } from "../../src/broker/worker-coordination-view.js";
import {
  LEGACY_CREATOR_CONTROLLER_ID,
  leaseCustody,
  leaseCustodyBadge,
  leaseCustodySummary,
  uniformLeaseCustody,
  type LeaseCustody,
} from "../../src/client/lease-custody.js";

const NOW = "2026-07-22T10:00:00.000Z";
const LEASE_HEALTHS = ["active", "expired", "released", "orphaned", "contested"] as const;

function view(overrides: {
  leaseHealth: FleetWorkerCoordinationView["leaseHealth"];
  controller?: boolean;
  orphaned?: boolean;
  adoptable?: boolean;
  creatorControllerId?: string;
}): FleetWorkerCoordinationView {
  const { leaseHealth, creatorControllerId = "orc-1" } = overrides;
  const controller = overrides.controller
    ?? (leaseHealth === "active" || leaseHealth === "contested");
  return {
    sessionId: "22222222-2222-4222-8222-222222222222",
    subjectId: "22222222-2222-4222-8222-222222222222",
    origin: {
      creatorControllerId,
      taskId: "task-1",
      threadId: "thread-1",
      createdAt: NOW,
    },
    ...(controller
      ? {
        currentController: {
          controllerId: "controller-1",
          familyId: "family-1",
          scope: "fleet:local",
        },
      }
      : {}),
    leaseHealth,
    orphaned: overrides.orphaned ?? leaseHealth === "orphaned",
    adoptable: overrides.adoptable
      ?? (leaseHealth === "orphaned" || leaseHealth === "expired"),
  };
}

/** Restates the projection's own invariants, independently of how the derivation checks them. */
function wellFormed(projection: FleetWorkerCoordinationView): boolean {
  const held = projection.leaseHealth === "active" || projection.leaseHealth === "contested";
  if (held !== (projection.currentController !== undefined)) return false;
  if (projection.orphaned !== (projection.leaseHealth === "orphaned")) return false;
  return !projection.adoptable
    || projection.leaseHealth === "orphaned"
    || projection.leaseHealth === "expired";
}

describe("leaseCustody", () => {
  it("collapses every well-formed field combination into one custody state", () => {
    for (const leaseHealth of LEASE_HEALTHS) {
      for (const adoptable of [true, false]) {
        for (const creatorControllerId of ["orc-1", LEGACY_CREATOR_CONTROLLER_ID]) {
          const projection = view({ leaseHealth, adoptable, creatorControllerId });
          if (!wellFormed(projection)) continue;
          const custody = leaseCustody(projection);
          if (leaseHealth === "active") {
            expect(custody).toEqual({ kind: "attached", controllerName: "controller-1" });
            continue;
          }
          if (leaseHealth === "contested") {
            expect(custody).toEqual({
              kind: "conflict-or-anomalous",
              conflict: true,
              reason: "contested while held by controller-1",
            });
            continue;
          }
          if (adoptable) {
            expect(custody).toEqual({ kind: "orphaned-adoptable" });
            continue;
          }
          expect(custody).toEqual({
            kind: "orphaned-legacy",
            legacyOrigin: creatorControllerId === LEGACY_CREATOR_CONTROLLER_ID,
          });
        }
      }
    }
  });

  it("maps every contradictory field combination to an anomaly", () => {
    let contradictions = 0;
    for (const leaseHealth of LEASE_HEALTHS) {
      for (const controller of [true, false]) {
        for (const orphaned of [true, false]) {
          for (const adoptable of [true, false]) {
            const projection = view({ leaseHealth, controller, orphaned, adoptable });
            if (wellFormed(projection)) continue;
            contradictions += 1;
            const custody = leaseCustody(projection);
            expect(custody).toMatchObject({ kind: "conflict-or-anomalous", conflict: false });
            expect(leaseCustodyBadge(custody)).toEqual({ label: "anomaly", tone: "alert" });
          }
        }
      }
    }
    expect(contradictions).toBeGreaterThan(0);
  });

  it("reports a held lease with no controller and a controller on an unowned lease", () => {
    expect(leaseCustody(view({ leaseHealth: "active", controller: false, adoptable: false })))
      .toEqual({
        kind: "conflict-or-anomalous",
        conflict: false,
        reason: "held lease without a controller",
      });
    expect(leaseCustody(view({ leaseHealth: "released", controller: true, adoptable: false })))
      .toEqual({
        kind: "conflict-or-anomalous",
        conflict: false,
        reason: "controller on an unowned lease",
      });
  });

  it("reports an orphaned flag that disagrees with the lease state", () => {
    expect(leaseCustody(view({ leaseHealth: "released", orphaned: true, adoptable: false })))
      .toMatchObject({ reason: "orphaned flag disagrees with lease state" });
  });

  it("reports adoptability claimed on a lease that cannot be claimed", () => {
    expect(leaseCustody(view({ leaseHealth: "released", adoptable: true })))
      .toMatchObject({ reason: "adoptable with no claimable lease" });
  });

  it("checks contradictions before contests, so a malformed contest is not read as one", () => {
    expect(leaseCustody(view({ leaseHealth: "contested", controller: false })))
      .toMatchObject({ conflict: false, reason: "held lease without a controller" });
  });
});

describe("leaseCustodyBadge", () => {
  it("renders nothing for the healthy attached state", () => {
    expect(leaseCustodyBadge({ kind: "attached", controllerName: "controller-1" }))
      .toBeUndefined();
  });

  it("renders nothing for an unowned lease, whatever an operator could do about it", () => {
    // No unowned state earns a row tag any more: the operator has no move to make about one, and
    // the width it took is the width the model and state columns needed. The states themselves
    // still exist and still read in full through the rollup and the detail line.
    expect(leaseCustodyBadge({ kind: "orphaned-legacy", legacyOrigin: true })).toBeUndefined();
    expect(leaseCustodyBadge({ kind: "orphaned-legacy", legacyOrigin: false })).toBeUndefined();
    expect(leaseCustodyBadge({ kind: "orphaned-adoptable" })).toBeUndefined();
  });

  it("escalates only for a broker that contradicts itself", () => {
    expect(leaseCustodyBadge({ kind: "conflict-or-anomalous", conflict: true, reason: "x" }))
      .toEqual({ label: "conflict", tone: "alert" });
    expect(leaseCustodyBadge({ kind: "conflict-or-anomalous", conflict: false, reason: "x" }))
      .toEqual({ label: "anomaly", tone: "alert" });
  });
});

describe("leaseCustodySummary", () => {
  it("names each state in full for the rollup and the detail line", () => {
    expect(leaseCustodySummary({ kind: "attached", controllerName: "controller-1" }))
      .toBe("attached — controller-1");
    expect(leaseCustodySummary({ kind: "orphaned-legacy", legacyOrigin: true }))
      .toBe("orphaned, legacy — not adoptable");
    expect(leaseCustodySummary({ kind: "orphaned-legacy", legacyOrigin: false }))
      .toBe("orphaned — not adoptable");
    expect(leaseCustodySummary({ kind: "orphaned-adoptable" })).toBe("orphaned — adoptable");
    expect(leaseCustodySummary({ kind: "conflict-or-anomalous", conflict: true, reason: "held by b" }))
      .toBe("lease conflict — held by b");
    expect(leaseCustodySummary({ kind: "conflict-or-anomalous", conflict: false, reason: "bad" }))
      .toBe("lease anomaly — bad");
  });
});

describe("uniformLeaseCustody", () => {
  const legacy: LeaseCustody = { kind: "orphaned-legacy", legacyOrigin: true };

  it("rolls up a group whose members all agree", () => {
    expect(uniformLeaseCustody([legacy, legacy, legacy])).toEqual(legacy);
  });

  it("does not roll up a lone worker, whose own badge already says it", () => {
    expect(uniformLeaseCustody([legacy])).toBeUndefined();
    expect(uniformLeaseCustody([])).toBeUndefined();
  });

  it("does not roll up when a member has no custody at all", () => {
    expect(uniformLeaseCustody([legacy, undefined])).toBeUndefined();
    expect(uniformLeaseCustody([undefined, legacy])).toBeUndefined();
  });

  it("separates states that differ only in their payload", () => {
    expect(uniformLeaseCustody([legacy, { kind: "orphaned-legacy", legacyOrigin: false }]))
      .toBeUndefined();
    expect(uniformLeaseCustody([
      { kind: "attached", controllerName: "a" },
      { kind: "attached", controllerName: "b" },
    ])).toBeUndefined();
    expect(uniformLeaseCustody([
      { kind: "attached", controllerName: "a" },
      { kind: "attached", controllerName: "a" },
    ])).toEqual({ kind: "attached", controllerName: "a" });
    expect(uniformLeaseCustody([
      { kind: "conflict-or-anomalous", conflict: true, reason: "x" },
      { kind: "conflict-or-anomalous", conflict: false, reason: "x" },
    ])).toBeUndefined();
    expect(uniformLeaseCustody([legacy, { kind: "orphaned-adoptable" }])).toBeUndefined();
  });
});
