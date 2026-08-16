import { spawnSync as nodeSpawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { SessionRecord } from "../domain/session.js";
import type { SpawnSyncLike } from "../tmux/cockpit.js";
import { callNvim } from "./bridge.js";
import { discoverNvimPane, type NvimSpawnOptions } from "./pane.js";
import { worktreeRequest } from "./quickfix.js";
import {
  worktreeChanges,
  type WorktreeBaseline,
  type WorktreeChangeSet,
} from "./worktree-changes.js";

/**
 * Live means a provider process can still be writing to the worktree.
 *
 * `starting` counts as live: the process is about to exist, and opening its worktree writable for
 * the seconds before it does is exactly the window in which a co-edit is silently lost.
 */
export function isWorkerLive(record: Pick<SessionRecord, "executionState">): boolean {
  return record.executionState === "active" || record.executionState === "starting";
}

/** What a worker row calls itself in nvim's list title. */
export function worktreeSubject(record: Pick<SessionRecord, "id" | "name">): string {
  const name = record.name?.trim();
  return name === undefined || name === "" ? record.id.slice(0, 8) : name;
}

/**
 * Resolve the session an operator named on the command line.
 *
 * Exact id, then exact name, and nothing else: a near-miss that opens the wrong agent's worktree
 * read-write is worse than being told to type the id.
 */
export function selectSession(
  records: readonly SessionRecord[],
  query: string,
): SessionRecord {
  const wanted = query.trim();
  const byId = records.find((record) => record.id === wanted);
  if (byId !== undefined) return byId;
  const byName = records.filter((record) => record.name === wanted);
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) {
    throw Object.assign(
      new Error(`Several sessions are named ${wanted}; name one by id: ${byName.map((record) => record.id).join(", ")}`),
      { code: "SESSION_AMBIGUOUS" },
    );
  }
  throw Object.assign(new Error(`No session matches ${wanted}`), { code: "SESSION_NOT_FOUND" });
}

/** Everything an open needs that is the same whether a worker or a checkout is being opened. */
export interface NvimOpenOptions {
  /** The pane the invoking client occupies; nvim is looked for in that pane's window. */
  hostPaneId: string;
  spawnSync?: SpawnSyncLike | undefined;
  changes?: ((cwd: string) => Promise<WorktreeChangeSet>) | undefined;
  nvimPath?: string | undefined;
  uid?: number | undefined;
  /** Seams for the case where this window has no nvim and one has to be started. */
  spawn?: NvimSpawnOptions | undefined;
  layout?: {
    enabled: boolean;
    orchestratorSessionIds: readonly string[];
  } | undefined;
  /** The one disk check this function makes, injected so the ordering below can be asserted. */
  worktreeExists?: ((path: string) => boolean) | undefined;
}

export interface OpenWorktreeOptions extends NvimOpenOptions {
  session: SessionRecord;
}

export interface OpenCheckoutOptions extends NvimOpenOptions {
  /** The repository's primary checkout — the folder header's own path, not a worker's worktree. */
  checkout: string;
  /**
   * Every thread the client knows about, so the open can see who is running in the checkout.
   *
   * The nvim module learns a guard only from a live open request, so a worker whose row was never
   * opened has no guard standing there. Omitting this is a claim that nothing is running in the
   * checkout, which is why the caller passes its whole list rather than pre-filtering it.
   */
  sessions?: readonly CheckoutOccupant[] | undefined;
}

/** All an occupancy check needs of a thread: where it runs and whether it still can be writing. */
export type CheckoutOccupant = Pick<SessionRecord, "cwd" | "executionState">;

/** What every open reports back, whoever it was opened for. */
interface OpenedInNvim {
  paneId: string;
  address: string;
  entries: number;
  live: boolean;
  /** What the entry count is measured from, for the operator's status line. */
  baseline: WorktreeBaseline;
}

export interface OpenedWorktree extends OpenedInNvim {
  sessionId: string;
  worktree: string;
}

export interface OpenedCheckout extends OpenedInNvim {
  checkout: string;
}

/**
 * The prefix a checkout's nvim-side identity carries.
 *
 * Every request names the thing it is about, and the nvim module keys its read-only guard by that
 * name. A worker sends its session id; a main checkout has no session, so it sends its path — under
 * a prefix no session id can take, because ids are UUIDs. A checkout that reused a worker's id
 * would release that worker's files the moment the operator opened the repository beside it.
 */
export const CHECKOUT_IDENTITY_PREFIX = "checkout:";

export function checkoutIdentity(checkout: string): string {
  return `${CHECKOUT_IDENTITY_PREFIX}${checkout}`;
}

/** One thing to open: who it belongs to, where it is, and whether anything is still writing to it. */
interface NvimOpenTarget {
  identity: string;
  path: string;
  subject: string;
  live: boolean;
  /** What the operator is told when the path is gone, in the words of the thing they asked for. */
  missing: { code: string; message: (path: string) => string };
}

/**
 * Open one worker's worktree in the nvim running in this tmux window, starting one if there is none.
 *
 * Live means locked: the buffers land read-only for as long as the agent can still be writing to
 * them. Releasing that lock early is the operator's own deliberate act on the nvim side, never
 * something Cyberdeck infers for them — see `docs/architecture/nvim-surface.md`.
 */
export async function openWorktreeInNvim(options: OpenWorktreeOptions): Promise<OpenedWorktree> {
  const opened = await openInNvim({
    identity: options.session.id,
    path: options.session.cwd,
    subject: worktreeSubject(options.session),
    live: isWorkerLive(options.session),
    missing: {
      code: "WORKTREE_MISSING",
      message: (path) => `The worktree ${path} is no longer on disk, so there is nothing to open`,
    },
  }, options);
  return { ...opened, sessionId: options.session.id, worktree: options.session.cwd };
}

/**
 * Is a live worker running in this checkout itself?
 *
 * The nvim module derives a buffer's lock from the guards that are standing, and it learns a guard
 * only from a live open request. A worker running directly in the checkout whose row the operator
 * never opened has therefore installed nothing, and an unlocked checkout open would hand back the
 * very files that worker is rewriting — the silent co-edit the lock exists to prevent. So the open
 * asks who is there rather than trusting a guard that may never have been installed.
 *
 * Equality, not containment. A worker one directory down — including one in a worktree nested under
 * the checkout — carries its own guard covering exactly its own tree, and locking a whole repository
 * on its behalf would take away the manual edit this open exists for.
 */
export function isCheckoutOccupied(
  checkout: string,
  sessions: readonly CheckoutOccupant[],
): boolean {
  const path = trimTrailingSlash(checkout);
  return sessions.some((record) => isWorkerLive(record) && trimTrailingSlash(record.cwd) === path);
}

/** `/code/x/` and `/code/x` are one directory; only the spelling differs. */
function trimTrailingSlash(path: string): string {
  const trimmed = path.replace(/\/+$/u, "");
  return trimmed === "" ? path : trimmed;
}

/**
 * Open a repository's primary checkout — the one place in a project no worker's worktree reaches.
 *
 * It is opened unlocked whenever it can be: the checkout is where the operator makes the quick
 * manual edit that Ctrl+N on a worker exists to prevent them making. A checkout a live worker is
 * running *in* is the exception, and it lands read-only under the checkout's own identity, because
 * that worker may never have had its row opened and so may have no guard standing here at all.
 *
 * That guard is the checkout's, not the worker's: it is dropped by the next unoccupied open of the
 * same checkout, and `:CyberdeckUnlock` is the operator's immediate way out of it in the meantime.
 *
 * No binding follows this open. A binding exists to lift a worker's lock when that worker finishes,
 * and a checkout has neither.
 */
export async function openCheckoutInNvim(options: OpenCheckoutOptions): Promise<OpenedCheckout> {
  const opened = await openInNvim({
    identity: checkoutIdentity(options.checkout),
    path: options.checkout,
    subject: basename(options.checkout),
    live: isCheckoutOccupied(options.checkout, options.sessions ?? []),
    missing: {
      code: "CHECKOUT_MISSING",
      message: (path) => `The checkout ${path} is no longer on disk, so there is nothing to open`,
    },
  }, options);
  return { ...opened, checkout: options.checkout };
}

/**
 * The one path both opens take.
 *
 * The order matters: the pane is resolved before any git work, so the nvim the change list is
 * destined for exists — and answers — before a large tree is diffed for it.
 *
 * The one thing that goes *ahead* of the pane is whether the directory is still on disk. A worktree
 * that has been cleaned up has nothing to open, and resolving the pane first would spawn an nvim
 * into the operator's window purely to then fail. This is a single `existsSync`, not a diff, so it
 * costs the ordering above nothing: the expensive work stays behind the pane, as before.
 *
 * A directory that exists but is not a repository is *not* an error — the operator keeps scratchpad
 * threads like that, and they open with an empty list that says so.
 */
async function openInNvim(
  target: NvimOpenTarget,
  options: NvimOpenOptions,
): Promise<OpenedInNvim> {
  const exists = options.worktreeExists ?? existsSync;
  if (!exists(target.path)) {
    throw Object.assign(new Error(target.missing.message(target.path)), { code: target.missing.code });
  }
  const pane = await discoverNvimPane({
    spawnSync: options.spawnSync ?? (nodeSpawnSync as SpawnSyncLike),
    hostPaneId: options.hostPaneId,
    ...(options.uid === undefined ? {} : { uid: options.uid }),
    spawn: {
      ...(options.nvimPath === undefined ? {} : { nvimPath: options.nvimPath }),
      ...(options.spawn ?? {}),
    },
    ...(options.layout === undefined ? {} : { layout: options.layout }),
  });
  const changes = await (options.changes ?? worktreeChanges)(target.path);
  const request = worktreeRequest({
    session: target.identity,
    worktree: target.path,
    subject: target.subject,
    live: target.live,
    changes,
  });
  callNvim({
    address: pane.address,
    entryPoint: "open",
    request,
    ...(options.spawnSync === undefined ? {} : { spawnSync: options.spawnSync }),
    ...(options.nvimPath === undefined ? {} : { nvimPath: options.nvimPath }),
  });
  return {
    paneId: pane.paneId,
    address: pane.address,
    entries: request.entries.length,
    live: target.live,
    baseline: changes.baseline,
  };
}
