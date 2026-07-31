import { z } from "zod";
import type { ControllerLease, OwnershipSubject } from "./worker-coordination.js";

/**
 * Custody color: which orchestrator a worker belongs to, said in hue.
 *
 * Six slots, because six is what a terminal palette can hold and still keep every hue
 * clearly distinct from the status tones and from each other. A slot is owned by a
 * durable controller family, never by one provider process, so an orchestrator keeps
 * its color across restarts and its ex-workers keep wearing it while they fade out.
 */
export const CUSTODY_COLOR_SLOT_COUNT = 6;

/**
 * How long a worker keeps its former controller's hue after the lease ends.
 *
 * Evaluated lazily, at projection read time: nothing in this feature runs on a timer, so
 * a fleet nobody looks at costs nothing and a fleet somebody looks at is always current.
 */
export const FADED_CUSTODY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export const CustodyColorSlotSchema = z.number().int().min(0).max(CUSTODY_COLOR_SLOT_COUNT - 1);

export const CustodyColorAssignmentSchema = z.object({
  slot: CustodyColorSlotSchema,
  controllerId: z.string().min(1).max(256),
  assignedAt: z.iso.datetime(),
  /** Set when the orchestrator's binding goes away. The slot stays taken while workers still fade. */
  releasedAt: z.iso.datetime().optional(),
});

/**
 * At most one assignment per slot, ever. Two controllers sharing a slot is precisely the
 * confusion this feature exists to prevent, so the invariant is enforced by the schema
 * rather than trusted to the allocator.
 */
export const CustodyColorTableSchema = z.array(CustodyColorAssignmentSchema)
  .max(CUSTODY_COLOR_SLOT_COUNT)
  .refine(
    (entries) => new Set(entries.map((entry) => entry.slot)).size === entries.length,
    "a custody color slot may hold only one assignment",
  );

export type CustodyColorAssignment = z.infer<typeof CustodyColorAssignmentSchema>;
export type CustodyColorTable = readonly CustodyColorAssignment[];

/** `active` while the lease is held; `faded` once it ends and until the worker goes neutral. */
export interface CustodyColor {
  slot: number;
  intensity: "active" | "faded";
}

export interface CustodyColorAllocation {
  table: CustodyColorTable;
  /** Absent when every slot is held by a live orchestrator; that orchestrator renders neutral. */
  slot?: number;
}

/** When custody ended. `expiresAt` is the floor: an expired lease records no other instant. */
function leaseEndedAt(lease: ControllerLease): string {
  return lease.releasedAt ?? lease.orphanedAt ?? lease.expiresAt;
}

function leaseHeld(lease: ControllerLease): boolean {
  return lease.state === "active" || lease.state === "contested";
}

/**
 * The hue a worker wears, or `undefined` for the natural, uncolored row.
 *
 * Four things clear a color, and all four fall out of this one rule rather than needing a
 * sweep: adoption rewrites `lease.controller`, so the worker switches to the new
 * orchestrator's slot at full intensity; an archived thread has no subject left to project;
 * an evicted slot has no assignment left to find; and a fade older than the cutoff is read
 * as expired the moment anyone looks.
 */
export function custodyColor(
  subject: OwnershipSubject,
  table: CustodyColorTable,
  now: string,
): CustodyColor | undefined {
  const controllerId = subject.lease.controller?.controllerId;
  if (controllerId === undefined) return undefined;
  const assignment = table.find((entry) => entry.controllerId === controllerId);
  if (assignment === undefined) return undefined;
  if (leaseHeld(subject.lease)) return { slot: assignment.slot, intensity: "active" };
  return Date.parse(now) - Date.parse(leaseEndedAt(subject.lease)) > FADED_CUSTODY_MAX_AGE_MS
    ? undefined
    : { slot: assignment.slot, intensity: "faded" };
}

/**
 * The most recent fade still worn on each slot, which is how old that slot's cohort is.
 *
 * A slot is unavailable while anyone is still fading on it, and when nothing is available the
 * cohort that stopped growing longest ago is the one evicted.
 */
function fadedCohorts(
  table: CustodyColorTable,
  subjects: readonly OwnershipSubject[],
  now: string,
): Map<number, number> {
  const newestFade = new Map<number, number>();
  for (const subject of subjects) {
    const color = custodyColor(subject, table, now);
    if (color?.intensity !== "faded") continue;
    const endedAt = Date.parse(leaseEndedAt(subject.lease));
    newestFade.set(color.slot, Math.max(newestFade.get(color.slot) ?? endedAt, endedAt));
  }
  return newestFade;
}

/**
 * Give a newly spawned orchestrator its slot.
 *
 * The allocation order is what keeps a color from meaning two things at once. A controller
 * that already holds a slot keeps it, and one whose slot was only released reclaims it — an
 * orchestrator rebound to the same scope is the same custody, and its own faded workers
 * should light back up rather than be orphaned into a second hue. Otherwise the slot must be
 * free of both live holders and fading workers, and among those the least recently released
 * wins, so a color has the longest possible gap between two different meanings.
 */
export function allocateCustodyColorSlot(input: {
  controllerId: string;
  table: CustodyColorTable;
  subjects: readonly OwnershipSubject[];
  now: string;
}): CustodyColorAllocation {
  const { controllerId, table, subjects, now } = input;
  const owned = table.find((entry) => entry.controllerId === controllerId);
  if (owned !== undefined) {
    return {
      table: replaceSlot(table, { slot: owned.slot, controllerId, assignedAt: owned.assignedAt }),
      slot: owned.slot,
    };
  }

  const faded = fadedCohorts(table, subjects, now);
  const held = new Set(
    table.filter((entry) => entry.releasedAt === undefined).map((entry) => entry.slot),
  );
  const slots = Array.from({ length: CUSTODY_COLOR_SLOT_COUNT }, (_, slot) => slot);
  const available = slots.filter((slot) => !held.has(slot) && !faded.has(slot));
  const slot = available.length > 0
    ? leastRecentlyReleased(available, table)
    : oldestCohort(slots.filter((candidate) => !held.has(candidate)), faded);
  if (slot === undefined) return { table };
  return {
    table: replaceSlot(table, { slot, controllerId, assignedAt: now }),
    slot,
  };
}

/**
 * Reclaim slots whose holder has no live binding. A crash or SIGKILL skips the graceful
 * `releaseCustodyColorSlot` path entirely, so without this sweep a dead orchestrator's slot
 * is held forever — the table has no other way to learn the holder is gone. Marks the slot
 * released rather than deleting the row, the same as a graceful release, so any of that
 * controller's workers still fade on it instead of losing their hue outright.
 */
export function reconcileCustodyColorTable(
  table: CustodyColorTable,
  liveControllerIds: ReadonlySet<string>,
  now: string,
): CustodyColorTable {
  const stale = table.some((entry) =>
    entry.releasedAt === undefined && !liveControllerIds.has(entry.controllerId));
  if (!stale) return table;
  return table.map((entry) =>
    entry.releasedAt === undefined && !liveControllerIds.has(entry.controllerId)
      ? { ...entry, releasedAt: now }
      : entry);
}

/**
 * Release the slot without freeing it: workers keep fading on it until they time out.
 * Returns the same table when there was nothing to release, so callers can skip the write.
 */
export function releaseCustodyColorSlot(
  table: CustodyColorTable,
  controllerId: string,
  now: string,
): CustodyColorTable {
  const held = table.some((entry) =>
    entry.controllerId === controllerId && entry.releasedAt === undefined);
  if (!held) return table;
  return table.map((entry) =>
    entry.controllerId === controllerId && entry.releasedAt === undefined
      ? { ...entry, releasedAt: now }
      : entry);
}

/** Never used sorts before ever released, so a fresh fleet spends its slots in order. */
function leastRecentlyReleased(available: readonly number[], table: CustodyColorTable): number {
  return [...available].sort((left, right) => {
    const leftAt = releaseInstant(table, left);
    const rightAt = releaseInstant(table, right);
    return leftAt === rightAt ? left - right : leftAt - rightAt;
  })[0]!;
}

function releaseInstant(table: CustodyColorTable, slot: number): number {
  const assignment = table.find((entry) => entry.slot === slot);
  return assignment?.releasedAt === undefined ? 0 : Date.parse(assignment.releasedAt);
}

/**
 * Exhaustion. Every slot is spoken for, so the oldest fading cohort loses its hue and its
 * workers drop to neutral. A slot a live orchestrator holds is never a candidate: recoloring
 * a running orchestrator's fleet would be a worse lie than leaving the newcomer uncolored.
 */
function oldestCohort(
  candidates: readonly number[],
  faded: ReadonlyMap<number, number>,
): number | undefined {
  return [...candidates]
    .filter((slot) => faded.has(slot))
    .sort((left, right) => {
      const difference = faded.get(left)! - faded.get(right)!;
      return difference === 0 ? left - right : difference;
    })[0];
}

function replaceSlot(
  table: CustodyColorTable,
  assignment: CustodyColorAssignment,
): CustodyColorTable {
  return CustodyColorTableSchema.parse([
    ...table.filter((entry) => entry.slot !== assignment.slot),
    assignment,
  ].sort((left, right) => left.slot - right.slot));
}
