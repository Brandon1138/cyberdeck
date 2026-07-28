import type { FleetWorkerCoordinationView } from "../broker/worker-coordination-view.js";

/**
 * The creator recorded for workers that predate lease custody. Those workers can never
 * be attributed to a controller, so an unowned lease on them is the expected steady
 * state rather than something an operator should act on.
 */
export const LEGACY_CREATOR_CONTROLLER_ID = "legacy-unresolved";

/**
 * What the broker's five custody fields actually mean to an operator.
 *
 * The projection carries `leaseHealth`, `currentController`, `orphaned` and `adoptable`
 * separately, but they are not independent: `orphaned` restates `leaseHealth`, an absent
 * controller is implied by every unowned lease, and `adoptable` only ever varies within
 * the unowned states. Collapsing them here is what lets the list render one badge instead
 * of five redundant fields, and it gives contradictions — combinations the broker should
 * never emit — a single place to land.
 */
export type LeaseCustody =
  /** A controller holds the lease. The healthy steady state; renders no badge. */
  | { kind: "attached"; controllerName: string }
  /** Unowned and claimable: the one state where adoption is the operator's move. */
  | { kind: "orphaned-adoptable" }
  /** Unowned and not claimable. Expected, and the common case for legacy workers. */
  | { kind: "orphaned-legacy"; legacyOrigin: boolean }
  /** Two controllers contesting, or a field combination that cannot be true at once. */
  | { kind: "conflict-or-anomalous"; conflict: boolean; reason: string };

/**
 * Tone names stay a subset of the fleet palette keys so the hue can move without touching
 * this file. Only three are reachable: the healthy state is rendered by omission, expected
 * unowned leases recede into chrome, and the remaining two escalate.
 */
export type LeaseCustodyTone = "subtle" | "attention" | "alert";

export interface LeaseCustodyBadge {
  label: string;
  tone: LeaseCustodyTone;
}

/**
 * Combinations the broker's own projection rules make impossible. Reporting them as
 * anomalies is the point: silently picking one field to believe would hide a broker bug
 * behind a badge that looks routine.
 */
function contradiction(view: FleetWorkerCoordinationView): string | undefined {
  const controlled = view.leaseHealth === "active" || view.leaseHealth === "contested";
  if (controlled !== (view.currentController !== undefined)) {
    return controlled ? "held lease without a controller" : "controller on an unowned lease";
  }
  if (view.orphaned !== (view.leaseHealth === "orphaned")) {
    return "orphaned flag disagrees with lease state";
  }
  if (view.adoptable && view.leaseHealth !== "orphaned" && view.leaseHealth !== "expired") {
    return "adoptable with no claimable lease";
  }
  return undefined;
}

/**
 * Contradictions are checked before anything else, so a malformed record can never be
 * reported as one of the three well-formed states.
 */
export function leaseCustody(view: FleetWorkerCoordinationView): LeaseCustody {
  const anomaly = contradiction(view);
  if (anomaly !== undefined) {
    return { kind: "conflict-or-anomalous", conflict: false, reason: anomaly };
  }
  if (view.leaseHealth === "contested") {
    return {
      kind: "conflict-or-anomalous",
      conflict: true,
      reason: `contested while held by ${view.currentController!.controllerId}`,
    };
  }
  if (view.leaseHealth === "active") {
    return { kind: "attached", controllerName: view.currentController!.controllerId };
  }
  if (view.adoptable) return { kind: "orphaned-adoptable" };
  return {
    kind: "orphaned-legacy",
    legacyOrigin: view.origin.creatorControllerId === LEGACY_CREATOR_CONTROLLER_ID,
  };
}

/**
 * Exception-only rendering: the healthy state has no badge at all, so anything painted on
 * a worker row is by construction something that departs from it.
 */
export function leaseCustodyBadge(custody: LeaseCustody): LeaseCustodyBadge | undefined {
  switch (custody.kind) {
    case "attached":
      return undefined;
    case "orphaned-legacy":
      return { label: custody.legacyOrigin ? "legacy" : "unowned", tone: "subtle" };
    case "orphaned-adoptable":
      return { label: "adoptable", tone: "attention" };
    case "conflict-or-anomalous":
      return { label: custody.conflict ? "conflict" : "anomaly", tone: "alert" };
  }
}

/** The long form, for the group rollup and the custody detail line. */
export function leaseCustodySummary(custody: LeaseCustody): string {
  switch (custody.kind) {
    case "attached":
      return `attached — ${custody.controllerName}`;
    case "orphaned-legacy":
      return custody.legacyOrigin
        ? "orphaned, legacy — not adoptable"
        : "orphaned — not adoptable";
    case "orphaned-adoptable":
      return "orphaned — adoptable";
    case "conflict-or-anomalous":
      return `${custody.conflict ? "lease conflict" : "lease anomaly"} — ${custody.reason}`;
  }
}

function sameCustody(left: LeaseCustody, right: LeaseCustody): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "attached" && right.kind === "attached") {
    return left.controllerName === right.controllerName;
  }
  if (left.kind === "orphaned-legacy" && right.kind === "orphaned-legacy") {
    return left.legacyOrigin === right.legacyOrigin;
  }
  if (left.kind === "conflict-or-anomalous" && right.kind === "conflict-or-anomalous") {
    return left.conflict === right.conflict && left.reason === right.reason;
  }
  return true;
}

/**
 * The shared custody of a group, or `undefined` when the group does not have one.
 *
 * A group only rolls up when every member reports custody and they all agree. A lone
 * worker never rolls up: "all" reads as a claim about a population, and its own badge
 * already says the same thing in less space.
 */
export function uniformLeaseCustody(
  custodies: ReadonlyArray<LeaseCustody | undefined>,
): LeaseCustody | undefined {
  if (custodies.length < 2) return undefined;
  const [first, ...rest] = custodies;
  if (first === undefined) return undefined;
  return rest.every((custody) => custody !== undefined && sameCustody(first, custody))
    ? first
    : undefined;
}
