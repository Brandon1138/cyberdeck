import { execFile } from "node:child_process";

/**
 * Pull-request state for a thread, derived from the branch checked out in the
 * thread's worktree. A thread whose branch has no pull request — or whose
 * repository is unreachable, or where `gh` is missing or unauthenticated —
 * has no state at all and renders nothing.
 */
export type PullRequestState =
  | "open"
  | "draft"
  | "merged"
  | "closed"
  | "checks-failing";

/**
 * Tone names must stay a subset of the fleet palette keys, and specifically of
 * its semantic `pr*` tokens: the column paints pull-request state, so it names
 * that state rather than a raw hue and the hue can move without touching this
 * file. `prClosed` is inert grey — closed unmerged is terminal, not a fault —
 * and `prMerged` is deliberately not the brand purple the logo alone owns.
 */
export type PullRequestTone = "prOpen" | "prDraft" | "prMerged" | "prClosed" | "prFailing";

export interface PullRequestGlyph {
  glyph: string;
  tone: PullRequestTone;
}

const GLYPHS: Readonly<Record<PullRequestState, PullRequestGlyph>> = {
  open: { glyph: "●", tone: "prOpen" },
  draft: { glyph: "○", tone: "prDraft" },
  merged: { glyph: "◆", tone: "prMerged" },
  closed: { glyph: "⊘", tone: "prClosed" },
  "checks-failing": { glyph: "✗", tone: "prFailing" },
};

export function pullRequestGlyph(state: PullRequestState): PullRequestGlyph {
  return GLYPHS[state];
}

/** The subset of `gh pr view --json …` we read. Every field is untrusted. */
export interface PullRequestView {
  state?: unknown;
  isDraft?: unknown;
  statusCheckRollup?: unknown;
}

export const PULL_REQUEST_FIELDS = "state,isDraft,statusCheckRollup";

/**
 * A CheckRun is failing only once it has COMPLETED: an in-flight run carries a
 * null conclusion and must not be reported as a failure.
 */
const FAILING_CHECK_RUN_CONCLUSIONS: ReadonlySet<string> = new Set([
  "FAILURE",
  "TIMED_OUT",
  "STARTUP_FAILURE",
  "ACTION_REQUIRED",
]);

/**
 * CANCELLED and STALE are deliberately absent: they overwhelmingly mean a run
 * was superseded by a newer push, and painting that red is the wrong glyph.
 * NEUTRAL and SKIPPED are passes.
 */
const FAILING_STATUS_CONTEXT_STATES: ReadonlySet<string> = new Set([
  "FAILURE",
  "ERROR",
]);

function upper(value: unknown): string {
  return typeof value === "string" ? value.toUpperCase() : "";
}

/**
 * `statusCheckRollup` is a union of CheckRun and StatusContext nodes that name
 * their fields differently: CheckRun carries `status` plus a nullable
 * `conclusion`, StatusContext carries a single `state`. Dispatch on
 * `__typename` when GitHub sends it and fall back to the shape otherwise; a
 * node we cannot classify is never counted as a failure.
 */
function nodeIsFailing(node: unknown): boolean {
  if (typeof node !== "object" || node === null) return false;
  const candidate = node as Record<string, unknown>;
  const typename = candidate["__typename"];

  if (typename === "StatusContext" || (typename === undefined && "state" in candidate)) {
    return FAILING_STATUS_CONTEXT_STATES.has(upper(candidate["state"]));
  }
  if (typename === "CheckRun" || (typename === undefined && "status" in candidate)) {
    if (upper(candidate["status"]) !== "COMPLETED") return false;
    return FAILING_CHECK_RUN_CONCLUSIONS.has(upper(candidate["conclusion"]));
  }
  return false;
}

/**
 * A null rollup (no CI configured) and an empty rollup are both "no checks",
 * which is not the same as failing checks.
 */
export function rollupHasFailure(rollup: unknown): boolean {
  if (!Array.isArray(rollup)) return false;
  return rollup.some(nodeIsFailing);
}

/**
 * Checks only qualify an OPEN pull request: once a PR is merged or closed its
 * CI history is history. Among live pull requests a failing check outranks
 * draft, because it is the state that wants action.
 */
export function pullRequestState(view: PullRequestView | null | undefined): PullRequestState | undefined {
  if (view === null || view === undefined) return undefined;
  switch (upper(view.state)) {
    case "MERGED": return "merged";
    case "CLOSED": return "closed";
    case "OPEN": break;
    default: return undefined;
  }
  if (rollupHasFailure(view.statusCheckRollup)) return "checks-failing";
  return view.isDraft === true ? "draft" : "open";
}

/** Parses one `gh pr view --json` payload, tolerating anything unexpected. */
export function parsePullRequestPayload(stdout: string): PullRequestState | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    return pullRequestState(parsed as PullRequestView);
  } catch {
    return undefined;
  }
}

export type PullRequestProbeOutcome =
  | { readonly kind: "ok"; readonly stdout: string }
  /** No PR, no repo, not authenticated, timed out — all silent, all retryable. */
  | { readonly kind: "absent" }
  /** `gh` is not installed. Not transient: stop probing for this process. */
  | { readonly kind: "unavailable" };

export type PullRequestProbe = (cwd: string) => Promise<PullRequestProbeOutcome>;

const PROBE_TIMEOUT_MS = 5_000;

export const probePullRequestWithGh: PullRequestProbe = (cwd) =>
  new Promise((resolve) => {
    execFile(
      "gh",
      ["pr", "view", "--json", PULL_REQUEST_FIELDS],
      { cwd, timeout: PROBE_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        if (error === null) {
          resolve({ kind: "ok", stdout });
          return;
        }
        const code = (error as NodeJS.ErrnoException).code;
        resolve(code === "ENOENT" ? { kind: "unavailable" } : { kind: "absent" });
      },
    );
  });

/** A resolved pull request may move (checks land, PR merges); re-probe often. */
const PRESENT_TTL_MS = 60_000;
/** Most threads never have a PR. Re-probe those rarely so we stay cheap. */
const ABSENT_TTL_MS = 300_000;
/** Probes run one at a time; this bounds how many a single tick may enqueue. */
const MAX_QUEUED_PROBES = 4;

interface CacheEntry {
  state: PullRequestState | undefined;
  fetchedAt: number;
}

export interface PullRequestStatusPort {
  /** Fire-and-forget. Never throws, never blocks, never awaited by a render. */
  refresh(cwds: readonly string[]): void;
  /** Synchronous read of whatever has landed so far. */
  states(): ReadonlyMap<string, PullRequestState>;
}

export interface PullRequestStatusCacheOptions {
  probe?: PullRequestProbe | undefined;
  now?: (() => number) | undefined;
}

/**
 * Out-of-band, per-worktree pull-request status. Renders read {@link states}
 * synchronously off the cache; probes run detached and land in a later frame.
 */
export class PullRequestStatusCache implements PullRequestStatusPort {
  readonly #entries = new Map<string, CacheEntry>();
  readonly #queued = new Set<string>();
  readonly #probe: PullRequestProbe;
  readonly #now: () => number;
  #unavailable = false;
  #pending: Promise<void> = Promise.resolve();

  constructor(options: PullRequestStatusCacheOptions = {}) {
    this.#probe = options.probe ?? probePullRequestWithGh;
    this.#now = options.now ?? Date.now;
  }

  refresh(cwds: readonly string[]): void {
    if (this.#unavailable) return;
    const now = this.#now();
    for (const cwd of new Set(cwds)) {
      if (this.#queued.size >= MAX_QUEUED_PROBES) return;
      if (this.#queued.has(cwd) || !this.#isStale(cwd, now)) continue;
      this.#queued.add(cwd);
      this.#pending = this.#pending.then(async () => {
        await this.#probeOnce(cwd);
      });
    }
  }

  states(): ReadonlyMap<string, PullRequestState> {
    const resolved = new Map<string, PullRequestState>();
    for (const [cwd, entry] of this.#entries) {
      if (entry.state !== undefined) resolved.set(cwd, entry.state);
    }
    return resolved;
  }

  /** Test seam: settle every probe queued so far. */
  async settled(): Promise<void> {
    await this.#pending;
  }

  #isStale(cwd: string, now: number): boolean {
    const entry = this.#entries.get(cwd);
    if (entry === undefined) return true;
    const ttl = entry.state === undefined ? ABSENT_TTL_MS : PRESENT_TTL_MS;
    return now - entry.fetchedAt >= ttl;
  }

  async #probeOnce(cwd: string): Promise<void> {
    try {
      const outcome = await this.#probe(cwd);
      if (outcome.kind === "unavailable") {
        this.#unavailable = true;
        this.#entries.clear();
        return;
      }
      this.#entries.set(cwd, {
        state: outcome.kind === "ok" ? parsePullRequestPayload(outcome.stdout) : undefined,
        fetchedAt: this.#now(),
      });
    } catch {
      // A probe that blows up is indistinguishable from a branch with no pull
      // request, and neither is worth putting in front of the operator.
      this.#entries.set(cwd, { state: undefined, fetchedAt: this.#now() });
    } finally {
      this.#queued.delete(cwd);
    }
  }
}

export const NO_PULL_REQUEST_STATUS: PullRequestStatusPort = {
  refresh() { /* no-op */ },
  states: () => new Map(),
};
