import { execFile } from "node:child_process";
import { resolve as resolvePath } from "node:path";

/**
 * Pull-request state for a thread, derived from the branch that thread's own
 * work lands on. A thread whose branch has no pull request — or that owns no
 * branch at all, or whose repository is unreachable, or where `gh` is missing
 * or unauthenticated — has no state at all and renders nothing.
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

const TONES: Readonly<Record<PullRequestState, PullRequestTone>> = {
  open: "prOpen",
  draft: "prDraft",
  merged: "prMerged",
  closed: "prClosed",
  "checks-failing": "prFailing",
};

export function pullRequestTone(state: PullRequestState): PullRequestTone {
  return TONES[state];
}

/**
 * What the fleet paints: the pull request's own number, in the colourway of its
 * state. The number is the part an operator can act on — it is what `gh pr view`
 * takes and what the browser tab says — and a glyph never was.
 */
export interface PullRequestSummary {
  readonly state: PullRequestState;
  readonly number: number;
}

/** `#123`. The whole cell; the fleet only pads and paints it. */
export function pullRequestLabel(summary: PullRequestSummary): string {
  return `#${summary.number}`;
}

/** The subset of `gh pr view --json …` we read. Every field is untrusted. */
export interface PullRequestView {
  number?: unknown;
  state?: unknown;
  isDraft?: unknown;
  statusCheckRollup?: unknown;
}

export const PULL_REQUEST_FIELDS = "number,state,isDraft,statusCheckRollup";

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

/**
 * A pull request the fleet cannot name by number is one the operator cannot act
 * on, so a payload without a positive integer `number` is treated as no pull
 * request rather than painted as an anonymous one.
 */
export function pullRequestNumber(view: PullRequestView | null | undefined): number | undefined {
  const value = view?.number;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return undefined;
  return value;
}

/** Parses one `gh pr view --json` payload, tolerating anything unexpected. */
export function parsePullRequestPayload(stdout: string): PullRequestSummary | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const view = parsed as PullRequestView;
    const state = pullRequestState(view);
    const number = pullRequestNumber(view);
    if (state === undefined || number === undefined) return undefined;
    return { state, number };
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

export type PullRequestProbe = (cwd: string, branch: string) => Promise<PullRequestProbeOutcome>;

const PROBE_TIMEOUT_MS = 5_000;

/**
 * A branch name we are willing to hand to `gh` as a positional argument. `gh` has
 * no `--` terminator for `pr view`, so a leading dash would be read as a flag;
 * whitespace and glob characters are not branch names any dispatch has needed.
 * The broker validates declared branches too — this is the client-side half of
 * the same rule, applied to whatever git happens to report as well.
 */
export function isProbeSafeBranch(branch: string): boolean {
  if (branch.length === 0 || branch.length > 255) return false;
  if (branch.startsWith("-")) return false;
  return !/[\s~^:?*[\\]/u.test(branch) && !branch.includes("..");
}

export const probePullRequestWithGh: PullRequestProbe = (cwd, branch) =>
  new Promise((resolve) => {
    execFile(
      "gh",
      ["pr", "view", branch, "--json", PULL_REQUEST_FIELDS],
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

/**
 * Whether a directory gives the thread running in it a branch of its own.
 *
 * `shared` is the answer that fixes the attribution bug. Threads that were
 * dispatched without a worktree all sit in the repository's primary checkout,
 * and that checkout has exactly one branch — so the branch is the checkout's,
 * not any one thread's, and a pull request opened from it cannot be credited to
 * a thread. A linked worktree is the opposite: it exists because one piece of
 * work needed its own branch, so whoever runs there owns what is on it.
 */
export type BranchOwnership =
  | { readonly kind: "owned"; readonly branch: string }
  /** The primary checkout of a repository: its branch belongs to no single thread. */
  | { readonly kind: "shared" }
  /** Not a repository, detached HEAD, git missing — nothing to attribute either way. */
  | { readonly kind: "unknown" };

export type BranchOwnershipProbe = (cwd: string) => Promise<BranchOwnership>;

/**
 * One `git rev-parse` answers both questions. A linked worktree's `--git-dir` is
 * its own administrative directory under the repository's `--git-common-dir`;
 * in the primary checkout the two are the same path. Both may come back relative
 * to `cwd`, so both are resolved before they are compared.
 */
export const probeBranchOwnershipWithGit: BranchOwnershipProbe = (cwd) =>
  new Promise((resolve) => {
    execFile(
      "git",
      ["rev-parse", "--git-dir", "--git-common-dir", "--abbrev-ref", "HEAD"],
      { cwd, timeout: PROBE_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        if (error !== null) {
          resolve({ kind: "unknown" });
          return;
        }
        const [gitDir, commonDir, branch] = stdout.split("\n").map((line) => line.trim());
        if (gitDir === undefined || commonDir === undefined || branch === undefined) {
          resolve({ kind: "unknown" });
          return;
        }
        if (resolvePath(cwd, gitDir) === resolvePath(cwd, commonDir)) {
          resolve({ kind: "shared" });
          return;
        }
        // `--abbrev-ref HEAD` prints the literal string HEAD when it is detached.
        resolve(branch === "HEAD" || !isProbeSafeBranch(branch)
          ? { kind: "unknown" }
          : { kind: "owned", branch });
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
  summary: PullRequestSummary | undefined;
  fetchedAt: number;
}

/**
 * A thread, as far as pull-request attribution is concerned.
 *
 * `branch` is the branch this thread's own work lands on, when the dispatch
 * declared one. It is what makes attribution possible for threads that share a
 * checkout: without it the only branch on offer is the checkout's, which every
 * thread there shares and none of them owns.
 */
export interface PullRequestSubject {
  readonly threadId: string;
  readonly cwd: string;
  readonly branch?: string | undefined;
}

export interface PullRequestStatusPort {
  /** Fire-and-forget. Never throws, never blocks, never awaited by a render. */
  refresh(subjects: readonly PullRequestSubject[]): void;
  /** Synchronous read of whatever has landed so far, keyed by thread id. */
  states(): ReadonlyMap<string, PullRequestSummary>;
}

export interface PullRequestStatusCacheOptions {
  probe?: PullRequestProbe | undefined;
  branchOwnership?: BranchOwnershipProbe | undefined;
  now?: (() => number) | undefined;
}

/**
 * Two threads with the same cwd and the same branch are asking the same question,
 * and pay for one probe between them. The separator is NUL because it is the one
 * byte neither a path nor a branch name may contain.
 */
function subjectKey(subject: PullRequestSubject): string {
  return `${subject.cwd}\u0000${subject.branch ?? ""}`;
}

/**
 * Out-of-band, per-thread pull-request status. Renders read {@link states}
 * synchronously off the cache; probes run detached and land in a later frame.
 *
 * The cache is keyed on the branch a thread owns rather than on the directory it
 * runs in. Keying on the directory was the MIK-86 bug: every thread dispatched
 * without a worktree shares the repository's primary checkout, so one worker's
 * pull request lit up every one of them and the operator could no longer tell
 * which thread had produced what.
 */
export class PullRequestStatusCache implements PullRequestStatusPort {
  readonly #entries = new Map<string, CacheEntry>();
  readonly #queued = new Set<string>();
  /** Thread id → cache key, rebuilt from the latest refresh so departed threads drop out. */
  #subjects = new Map<string, string>();
  readonly #probe: PullRequestProbe;
  readonly #branchOwnership: BranchOwnershipProbe;
  readonly #now: () => number;
  #unavailable = false;
  #pending: Promise<void> = Promise.resolve();

  constructor(options: PullRequestStatusCacheOptions = {}) {
    this.#probe = options.probe ?? probePullRequestWithGh;
    this.#branchOwnership = options.branchOwnership ?? probeBranchOwnershipWithGit;
    this.#now = options.now ?? Date.now;
  }

  refresh(subjects: readonly PullRequestSubject[]): void {
    const wanted = new Map<string, PullRequestSubject>();
    const bindings = new Map<string, string>();
    for (const subject of subjects) {
      const key = subjectKey(subject);
      bindings.set(subject.threadId, key);
      wanted.set(key, subject);
    }
    this.#subjects = bindings;
    for (const key of [...this.#entries.keys()]) {
      if (!wanted.has(key) && !this.#queued.has(key)) this.#entries.delete(key);
    }
    if (this.#unavailable) return;
    const now = this.#now();
    for (const [key, subject] of wanted) {
      if (this.#queued.size >= MAX_QUEUED_PROBES) return;
      if (this.#queued.has(key) || !this.#isStale(key, now)) continue;
      this.#queued.add(key);
      this.#pending = this.#pending.then(async () => {
        await this.#probeOnce(key, subject);
      });
    }
  }

  states(): ReadonlyMap<string, PullRequestSummary> {
    const resolved = new Map<string, PullRequestSummary>();
    for (const [threadId, key] of this.#subjects) {
      const summary = this.#entries.get(key)?.summary;
      if (summary !== undefined) resolved.set(threadId, summary);
    }
    return resolved;
  }

  /** Test seam: settle every probe queued so far. */
  async settled(): Promise<void> {
    await this.#pending;
  }

  #isStale(key: string, now: number): boolean {
    const entry = this.#entries.get(key);
    if (entry === undefined) return true;
    const ttl = entry.summary === undefined ? ABSENT_TTL_MS : PRESENT_TTL_MS;
    return now - entry.fetchedAt >= ttl;
  }

  /**
   * A declared branch is taken at its word — it is what the dispatch said this
   * thread's commits land on. Only a thread that declared nothing has to ask git
   * where it is, and the answer there is as often "you own no branch" as it is a
   * branch name.
   */
  async #ownBranch(subject: PullRequestSubject): Promise<string | undefined> {
    if (subject.branch !== undefined) {
      return isProbeSafeBranch(subject.branch) ? subject.branch : undefined;
    }
    const ownership = await this.#branchOwnership(subject.cwd);
    return ownership.kind === "owned" ? ownership.branch : undefined;
  }

  async #probeOnce(key: string, subject: PullRequestSubject): Promise<void> {
    try {
      const branch = await this.#ownBranch(subject);
      if (branch === undefined) {
        this.#entries.set(key, { summary: undefined, fetchedAt: this.#now() });
        return;
      }
      const outcome = await this.#probe(subject.cwd, branch);
      if (outcome.kind === "unavailable") {
        this.#unavailable = true;
        this.#entries.clear();
        return;
      }
      this.#entries.set(key, {
        summary: outcome.kind === "ok" ? parsePullRequestPayload(outcome.stdout) : undefined,
        fetchedAt: this.#now(),
      });
    } catch {
      // A probe that blows up is indistinguishable from a branch with no pull
      // request, and neither is worth putting in front of the operator.
      this.#entries.set(key, { summary: undefined, fetchedAt: this.#now() });
    } finally {
      this.#queued.delete(key);
    }
  }
}

export const NO_PULL_REQUEST_STATUS: PullRequestStatusPort = {
  refresh() { /* no-op */ },
  states: () => new Map(),
};
