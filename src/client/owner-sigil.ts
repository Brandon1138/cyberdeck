import type { FleetWorkerCoordinationView } from "../broker/worker-coordination-view.js";
import { LEGACY_CREATOR_CONTROLLER_ID } from "./lease-custody.js";

/**
 * Owner sigils: which orchestrator a worker belongs to, said in one monochrome glyph.
 *
 * This replaces the six broker-side custody color slots, which shipped and failed. Color in
 * Fleet carries state and nothing else, so provenance had to find a channel that is not hue —
 * and a hue could only ever say "these rows go together", never *which* orchestrator, because
 * there was nothing on the Orc's own row to match it against beyond the same hue again.
 *
 * A sigil is a shape, so it works with `--no-color`, it survives a narrow pane, and it appears
 * identically on the Orc's row and on every row that Orc owns. Nothing here is persisted: the
 * assignment is a pure function of the live roster, which is what makes it agree across redraws
 * without a ledger to reconcile.
 *
 * Every glyph below is one terminal cell wide under `displayWidth` and carries no emoji
 * presentation, so the sigil column never shifts a row. `owner-sigil.test.ts` asserts that.
 */
export const OWNER_SIGIL_ALPHABET = ["◆", "◇", "▲", "△", "■", "□", "●", "○"] as const;

/**
 * A worker an orchestrator created and nobody holds now.
 *
 * Deliberately not that orchestrator's sigil: the lease substrate is the only authority on
 * ownership, and it says this worker has no owner. Deliberately not blank either — blank is
 * the operator's own mark, and telling them a dispatched worker was theirs is the same lie in
 * the other direction. A sigil-shaped hole says the third thing.
 */
export const ORPHANED_OWNER_SIGIL = "⊘";

/** One owner the roster has to distinguish. */
export interface SigilOwner {
  controllerId: string;
  /**
   * When this owner appeared. Used only to break a collision, and only in one direction: the
   * older owner keeps the glyph it already wore, so a newly spawned orchestrator can never
   * move a sigil the operator has been reading all session.
   */
  since: string;
}

export type OwnerSigils = ReadonlyMap<string, string>;

/**
 * What the lease substrate says about who owns one worker.
 *
 * Three answers, not two. `unattributed` is the operator's own worker — no controller ever held
 * it — and renders as nothing at all. `orphaned` is a worker that *was* dispatched and now has
 * no holder. Collapsing those two would either invent an owner or hand the operator credit for
 * a worker they never dispatched.
 */
export type WorkerOwner =
  | { kind: "controlled"; controllerId: string }
  | { kind: "orphaned" }
  | { kind: "unattributed" };

/**
 * The current lease controller, never the creator.
 *
 * `currentController` is only populated for a held lease — the projection drops it for every
 * released, expired and orphaned one — so reading it is reading the substrate's own answer to
 * "who owns this now". An adopted worker therefore wears its new orchestrator's sigil the moment
 * the lease moves, with no separate sweep to keep in step.
 */
export function workerOwner(view: FleetWorkerCoordinationView): WorkerOwner {
  const controllerId = view.currentController?.controllerId;
  if (controllerId !== undefined) return { kind: "controlled", controllerId };
  return view.origin.creatorControllerId === LEGACY_CREATOR_CONTROLLER_ID
    ? { kind: "unattributed" }
    : { kind: "orphaned" };
}

/**
 * The sigil one worker row wears, or `undefined` for a row that wears none.
 *
 * A held lease naming a controller the roster does not know about — an orchestrator whose row
 * has been deleted while its lease lived on — falls through to `undefined` rather than borrowing
 * a glyph some live Orc is already wearing.
 */
export function workerOwnerSigil(
  view: FleetWorkerCoordinationView,
  sigils: OwnerSigils,
): string | undefined {
  const owner = workerOwner(view);
  if (owner.kind === "unattributed") return undefined;
  if (owner.kind === "orphaned") return ORPHANED_OWNER_SIGIL;
  return sigils.get(owner.controllerId);
}

/**
 * Assign every owner a distinct sigil.
 *
 * Two passes, because that is what makes an assignment both deterministic and stable. The first
 * pass hands each owner the glyph its own controller id hashes to, which is the same glyph on
 * every machine, in every redraw, and after every restart — no state is read and none is written.
 * Only owners whose preferred glyph was already claimed reach the second pass, where they probe
 * forward from it.
 *
 * Seniority decides the first pass, so joining the roster cannot take a glyph off an incumbent:
 * a new orchestrator with a free preference is invisible to everyone else, and one that collides
 * is the party that moves. Ties fall back to the controller id, which is stable and total.
 */
export function assignOwnerSigils(owners: readonly SigilOwner[]): OwnerSigils {
  const ordered = [...dedupe(owners)].sort((left, right) =>
    left.since === right.since
      ? left.controllerId.localeCompare(right.controllerId)
      : left.since.localeCompare(right.since));
  const sigils = new Map<string, string>();
  const taken = new Set<string>();
  const contested: SigilOwner[] = [];
  for (const owner of ordered) {
    const preferred = preferredSigil(owner.controllerId);
    if (taken.has(preferred)) {
      contested.push(owner);
      continue;
    }
    taken.add(preferred);
    sigils.set(owner.controllerId, preferred);
  }
  for (const owner of contested) {
    const sigil = probeSigil(owner.controllerId, taken);
    taken.add(sigil);
    sigils.set(owner.controllerId, sigil);
  }
  return sigils;
}

/**
 * The roster Fleet actually renders against: the bound orchestrators, plus any controller a
 * worker's live lease names that has no row of its own.
 *
 * Off-roster controllers are included because a held lease is a fact about the present, and a
 * worker with a real owner must not render as the operator's own. They are seeded from the
 * earliest worker that names them, which is deterministic, and they cannot displace a bound
 * orchestrator whose own start predates them.
 */
export function fleetOwnerSigils(input: {
  orchestrators: readonly SigilOwner[];
  workers: readonly FleetWorkerCoordinationView[];
}): OwnerSigils {
  const roster = new Set(input.orchestrators.map(({ controllerId }) => controllerId));
  const offRoster = new Map<string, string>();
  for (const view of input.workers) {
    const owner = workerOwner(view);
    if (owner.kind !== "controlled" || roster.has(owner.controllerId)) continue;
    const seen = offRoster.get(owner.controllerId);
    const since = view.origin.createdAt;
    if (seen === undefined || since < seen) offRoster.set(owner.controllerId, since);
  }
  return assignOwnerSigils([
    ...input.orchestrators,
    ...[...offRoster].map(([controllerId, since]) => ({ controllerId, since })),
  ]);
}

function dedupe(owners: readonly SigilOwner[]): SigilOwner[] {
  const earliest = new Map<string, SigilOwner>();
  for (const owner of owners) {
    const seen = earliest.get(owner.controllerId);
    if (seen === undefined || owner.since < seen.since) earliest.set(owner.controllerId, owner);
  }
  return [...earliest.values()];
}

function preferredSigil(controllerId: string): string {
  return OWNER_SIGIL_ALPHABET[hash(controllerId) % OWNER_SIGIL_ALPHABET.length]!;
}

/**
 * The nearest free glyph, then — once the alphabet is spent — the lettered space.
 *
 * The letters are the exhaustion fallback: eight distinct shapes is what a terminal can hold and
 * still be read at a glance, and a ninth orchestrator is better served by a legible `a` than by a
 * shape nobody can tell from the one above it. The letter space is bijective base-26 and grows a
 * character when it runs out, so the loop always terminates and two owners never share a sigil.
 * Sigils past `zz` cost a third cell, which the row layout pays for out of the title and preview
 * columns: a collision would be the worse trade.
 */
function probeSigil(controllerId: string, taken: ReadonlySet<string>): string {
  const start = hash(controllerId);
  for (let step = 0; step < OWNER_SIGIL_ALPHABET.length; step += 1) {
    const glyph = OWNER_SIGIL_ALPHABET[(start + step) % OWNER_SIGIL_ALPHABET.length]!;
    if (!taken.has(glyph)) return glyph;
  }
  for (let step = 0; ; step += 1) {
    // The first 26 steps cover every single letter, rotated by the hash so two owners that
    // spilled out of the alphabet do not both start at `a`.
    const letters = letterSigil(step < 26 ? (start + step) % 26 : step);
    if (!taken.has(letters)) return letters;
  }
}

/** Bijective base-26: 0 is `a`, 25 is `z`, 26 is `aa`, 701 is `zz`, 702 is `aaa`. */
function letterSigil(index: number): string {
  let remaining = index;
  let sigil = "";
  do {
    sigil = String.fromCharCode(97 + (remaining % 26)) + sigil;
    remaining = Math.floor(remaining / 26) - 1;
  } while (remaining >= 0);
  return sigil;
}

/** FNV-1a, 32 bit. Any stable hash would do; this one is short and has no dependency. */
function hash(value: string): number {
  let accumulator = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    accumulator ^= value.charCodeAt(index);
    accumulator = Math.imul(accumulator, 0x01000193) >>> 0;
  }
  return accumulator;
}
