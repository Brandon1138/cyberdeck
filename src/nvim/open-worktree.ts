import { spawnSync as nodeSpawnSync } from "node:child_process";
import type { SessionRecord } from "../domain/session.js";
import type { SpawnSyncLike } from "../tmux/cockpit.js";
import { callNvim } from "./bridge.js";
import { discoverNvimPane, type NvimSpawnOptions } from "./pane.js";
import { worktreeRequest } from "./quickfix.js";
import { worktreeChanges, type WorktreeChangeSet } from "./worktree-changes.js";

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

export interface OpenWorktreeOptions {
  session: SessionRecord;
  /** The pane the invoking client occupies; nvim is looked for in that pane's window. */
  hostPaneId: string;
  spawnSync?: SpawnSyncLike | undefined;
  changes?: ((cwd: string) => Promise<WorktreeChangeSet>) | undefined;
  nvimPath?: string | undefined;
  uid?: number | undefined;
  /** Seams for the case where this window has no nvim and one has to be started. */
  spawn?: NvimSpawnOptions | undefined;
}

export interface OpenedWorktree {
  sessionId: string;
  worktree: string;
  paneId: string;
  address: string;
  entries: number;
  live: boolean;
}

/**
 * Open one worker's worktree in the nvim running in this tmux window, starting one if there is none.
 *
 * The order matters: the pane is resolved before any git work, so the nvim the change list is
 * destined for exists — and answers — before a large tree is diffed for it.
 */
export async function openWorktreeInNvim(options: OpenWorktreeOptions): Promise<OpenedWorktree> {
  const pane = await discoverNvimPane({
    spawnSync: options.spawnSync ?? (nodeSpawnSync as SpawnSyncLike),
    hostPaneId: options.hostPaneId,
    ...(options.uid === undefined ? {} : { uid: options.uid }),
    spawn: {
      ...(options.nvimPath === undefined ? {} : { nvimPath: options.nvimPath }),
      ...(options.spawn ?? {}),
    },
  });
  const live = isWorkerLive(options.session);
  const changes = await (options.changes ?? worktreeChanges)(options.session.cwd);
  const request = worktreeRequest({
    session: options.session.id,
    worktree: options.session.cwd,
    subject: worktreeSubject(options.session),
    live,
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
    sessionId: options.session.id,
    worktree: options.session.cwd,
    paneId: pane.paneId,
    address: pane.address,
    entries: request.entries.length,
    live,
  };
}
