import { describe, expect, it, vi } from "vitest";
import {
  isProbeSafeBranch,
  NO_PULL_REQUEST_STATUS,
  parsePullRequestPayload,
  PullRequestStatusCache,
  pullRequestLabel,
  pullRequestState,
  pullRequestTone,
  rollupHasFailure,
  type BranchOwnership,
  type PullRequestProbeOutcome,
  type PullRequestState,
} from "../../src/client/pr-status.js";

function checkRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS", ...overrides };
}

function statusContext(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { __typename: "StatusContext", context: "ci/legacy", state: "SUCCESS", ...overrides };
}

function open(rollup: unknown, isDraft = false): PullRequestState | undefined {
  return pullRequestState({ state: "OPEN", isDraft, statusCheckRollup: rollup });
}

describe("rollupHasFailure", () => {
  it("treats a null rollup as no checks rather than failing checks", () => {
    expect(rollupHasFailure(null)).toBe(false);
    expect(rollupHasFailure(undefined)).toBe(false);
  });

  it("treats an empty rollup as no checks rather than failing checks", () => {
    expect(rollupHasFailure([])).toBe(false);
  });

  describe("CheckRun nodes, which carry status plus a nullable conclusion", () => {
    it.each([
      ["FAILURE", true],
      ["TIMED_OUT", true],
      ["STARTUP_FAILURE", true],
      ["ACTION_REQUIRED", true],
      ["SUCCESS", false],
      ["NEUTRAL", false],
      ["SKIPPED", false],
      ["CANCELLED", false],
      ["STALE", false],
    ])("maps a COMPLETED run concluding %s to failing=%s", (conclusion, failing) => {
      expect(rollupHasFailure([checkRun({ conclusion })])).toBe(failing);
    });

    it.each(["QUEUED", "IN_PROGRESS", "WAITING", "PENDING", "REQUESTED"])(
      "never reports a %s run as failing, even with a null conclusion",
      (status) => {
        expect(rollupHasFailure([checkRun({ status, conclusion: null })])).toBe(false);
      },
    );

    it("does not read a CheckRun's conclusion before it has completed", () => {
      expect(rollupHasFailure([checkRun({ status: "IN_PROGRESS", conclusion: "FAILURE" })])).toBe(false);
    });
  });

  describe("StatusContext nodes, which carry a single state field", () => {
    it.each([
      ["FAILURE", true],
      ["ERROR", true],
      ["SUCCESS", false],
      ["PENDING", false],
      ["EXPECTED", false],
    ])("maps state %s to failing=%s", (state, failing) => {
      expect(rollupHasFailure([statusContext({ state })])).toBe(failing);
    });

    it("does not mistake a StatusContext for a CheckRun awaiting a conclusion", () => {
      // `status` is absent here; reading it as a CheckRun would swallow the failure.
      expect(rollupHasFailure([{ __typename: "StatusContext", context: "ci", state: "FAILURE" }])).toBe(true);
    });
  });

  it("reports a mixed rollup with at least one failure as failing", () => {
    expect(rollupHasFailure([
      checkRun({ name: "lint", conclusion: "SUCCESS" }),
      statusContext({ context: "ci/legacy", state: "PENDING" }),
      checkRun({ name: "test", conclusion: "FAILURE" }),
      statusContext({ context: "ci/deploy", state: "SUCCESS" }),
    ])).toBe(true);
  });

  it("reports a mixed rollup with no failures as clean", () => {
    expect(rollupHasFailure([
      checkRun({ name: "lint", conclusion: "SUCCESS" }),
      checkRun({ name: "flake", status: "IN_PROGRESS", conclusion: null }),
      statusContext({ state: "PENDING" }),
      checkRun({ name: "optional", conclusion: "SKIPPED" }),
    ])).toBe(false);
  });

  it("classifies nodes by shape when __typename is absent", () => {
    expect(rollupHasFailure([{ status: "COMPLETED", conclusion: "FAILURE" }])).toBe(true);
    expect(rollupHasFailure([{ state: "ERROR" }])).toBe(true);
    expect(rollupHasFailure([{ status: "COMPLETED", conclusion: "SUCCESS" }])).toBe(false);
  });

  it("never guesses at a node variant it does not recognise", () => {
    expect(rollupHasFailure([{ __typename: "SomethingNew", verdict: "FAILURE" }])).toBe(false);
    expect(rollupHasFailure([null, 7, "FAILURE"])).toBe(false);
  });

  it("ignores a rollup that is not an array", () => {
    expect(rollupHasFailure({ state: "FAILURE" })).toBe(false);
  });
});

describe("pullRequestState", () => {
  it("reports an open pull request with no CI configured as open, not failing", () => {
    expect(open(null)).toBe("open");
    expect(open([])).toBe("open");
  });

  it("reports an open pull request with passing checks as open", () => {
    expect(open([checkRun(), statusContext()])).toBe("open");
  });

  it("reports a draft pull request as draft", () => {
    expect(open(null, true)).toBe("draft");
  });

  it("prefers checks-failing over draft, because a red check wants action", () => {
    expect(open([checkRun({ conclusion: "FAILURE" })], true)).toBe("checks-failing");
  });

  it("reports an open pull request with a failing check as checks-failing", () => {
    expect(open([checkRun({ conclusion: "FAILURE" })])).toBe("checks-failing");
  });

  it("ignores checks on merged and closed pull requests", () => {
    const rollup = [checkRun({ conclusion: "FAILURE" })];
    expect(pullRequestState({ state: "MERGED", isDraft: false, statusCheckRollup: rollup })).toBe("merged");
    expect(pullRequestState({ state: "CLOSED", isDraft: true, statusCheckRollup: rollup })).toBe("closed");
  });

  it("shows nothing for a missing, unknown, or malformed state", () => {
    expect(pullRequestState(undefined)).toBeUndefined();
    expect(pullRequestState(null)).toBeUndefined();
    expect(pullRequestState({})).toBeUndefined();
    expect(pullRequestState({ state: "SOMETHING_ELSE" })).toBeUndefined();
    expect(pullRequestState({ state: 42 })).toBeUndefined();
  });
});

describe("pullRequestTone", () => {
  it("gives every state a distinct tone", () => {
    const states: PullRequestState[] = ["open", "draft", "merged", "closed", "checks-failing"];
    const tones = states.map((state) => pullRequestTone(state));
    expect(new Set(tones).size).toBe(states.length);
  });

  it("reserves the alarm tone for failing checks among live pull requests", () => {
    expect(pullRequestTone("checks-failing")).toBe("prFailing");
    expect(pullRequestTone("open")).toBe("prOpen");
  });

  it("names semantic palette tokens rather than raw hues", () => {
    // The column paints pull-request state, so the tone travels as state and
    // the fleet palette owns the hue. Closed is inert, not a fault; merged is
    // its own token so it can never collapse into the reserved brand purple.
    expect(pullRequestTone("draft")).toBe("prDraft");
    expect(pullRequestTone("merged")).toBe("prMerged");
    expect(pullRequestTone("closed")).toBe("prClosed");
  });
});

describe("pullRequestLabel", () => {
  it("is the pull request's own number", () => {
    expect(pullRequestLabel({ state: "open", number: 123 })).toBe("#123");
    expect(pullRequestLabel({ state: "merged", number: 7 })).toBe("#7");
  });
});

describe("isProbeSafeBranch", () => {
  it("accepts the branch shapes dispatches actually use", () => {
    expect(isProbeSafeBranch("main")).toBe(true);
    expect(isProbeSafeBranch("brandonaron38/mik-86-77-pr-indicator")).toBe(true);
  });

  it("refuses anything gh would read as a flag or git as a pattern", () => {
    // `gh pr view` has no `--` terminator, so a leading dash is not a branch.
    expect(isProbeSafeBranch("--json")).toBe(false);
    expect(isProbeSafeBranch("")).toBe(false);
    expect(isProbeSafeBranch("feature branch")).toBe(false);
    expect(isProbeSafeBranch("feature..other")).toBe(false);
    expect(isProbeSafeBranch("feature^")).toBe(false);
  });

  it("refuses an all-digit branch, which gh reads as a PR number instead", () => {
    expect(isProbeSafeBranch("123")).toBe(false);
    expect(isProbeSafeBranch("0")).toBe(false);
    // Not a digit-only match: a leading zero or a mixed name is still a branch.
    expect(isProbeSafeBranch("123abc")).toBe(true);
    expect(isProbeSafeBranch("v123")).toBe(true);
  });
});

describe("parsePullRequestPayload", () => {
  it("reads a gh payload", () => {
    expect(parsePullRequestPayload(JSON.stringify({
      number: 412,
      state: "OPEN",
      isDraft: false,
      statusCheckRollup: [checkRun({ conclusion: "TIMED_OUT" })],
    }))).toEqual({ state: "checks-failing", number: 412 });
  });

  it("shows nothing for output that is not a pull request object", () => {
    expect(parsePullRequestPayload("")).toBeUndefined();
    expect(parsePullRequestPayload("not json")).toBeUndefined();
    expect(parsePullRequestPayload("null")).toBeUndefined();
    expect(parsePullRequestPayload("[]")).toBeUndefined();
  });

  it("shows nothing for a pull request it cannot name by number", () => {
    // The number is the whole indicator now; an anonymous one is not paintable.
    expect(parsePullRequestPayload(JSON.stringify({ state: "OPEN" }))).toBeUndefined();
    expect(parsePullRequestPayload(JSON.stringify({ state: "OPEN", number: 0 }))).toBeUndefined();
    expect(parsePullRequestPayload(JSON.stringify({ state: "OPEN", number: "12" }))).toBeUndefined();
    expect(parsePullRequestPayload(JSON.stringify({ state: "OPEN", number: 1.5 }))).toBeUndefined();
  });

  it("shows nothing for a numbered payload whose state is unreadable", () => {
    expect(parsePullRequestPayload(JSON.stringify({ number: 5, state: "SOMETHING" }))).toBeUndefined();
  });
});

describe("PullRequestStatusCache", () => {
  const okWith = (state: string, number = 1, rollup: unknown = null): PullRequestProbeOutcome => ({
    kind: "ok",
    stdout: JSON.stringify({ number, state, isDraft: false, statusCheckRollup: rollup }),
  });

  /** A thread that declared the branch its work lands on, which is what makes it attributable. */
  const onBranch = (threadId: string, branch: string, cwd = "/repo"): {
    threadId: string;
    cwd: string;
    branch: string;
  } => ({ threadId, cwd, branch });

  /** No thread here asks git anything unless a test says what git would answer. */
  const noOwnership = async (): Promise<BranchOwnership> => ({ kind: "unknown" });

  it("never blocks a read: states are empty until a probe lands", async () => {
    let release = (): void => undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const probe = vi.fn(async () => {
      await blocked;
      return okWith("OPEN", 12);
    });
    const cache = new PullRequestStatusCache({ probe, branchOwnership: noOwnership });

    cache.refresh([onBranch("t1", "feature")]);
    expect(cache.states().size).toBe(0);

    release();
    await cache.settled();
    expect(cache.states().get("t1")).toEqual({ state: "open", number: 12 });
  });

  describe("attribution", () => {
    it("credits a pull request to the one thread whose branch produced it", async () => {
      // Four workers in the same checkout. Only one of them opened a PR, and the
      // operator has to be able to see which — this is MIK-86.
      const cache = new PullRequestStatusCache({
        probe: async (_cwd, branch) => (branch === "worker-two" ? okWith("OPEN", 91) : { kind: "absent" }),
        branchOwnership: noOwnership,
        now: () => 0,
      });

      cache.refresh([
        onBranch("t1", "worker-one"),
        onBranch("t2", "worker-two"),
        onBranch("t3", "worker-three"),
      ]);
      await cache.settled();

      expect([...cache.states()]).toEqual([["t2", { state: "open", number: 91 }]]);
    });

    it("moves a thread through merged on its own, leaving its neighbours alone", async () => {
      let state = "OPEN";
      let now = 0;
      const cache = new PullRequestStatusCache({
        probe: async (_cwd, branch) => (branch === "worker-two" ? okWith(state, 91) : { kind: "absent" }),
        branchOwnership: noOwnership,
        now: () => now,
      });
      const threads = [onBranch("t1", "worker-one"), onBranch("t2", "worker-two")];

      cache.refresh(threads);
      await cache.settled();
      expect(cache.states().get("t2")?.state).toBe("open");

      state = "MERGED";
      now += 61_000;
      cache.refresh(threads);
      await cache.settled();

      expect(cache.states().get("t2")).toEqual({ state: "merged", number: 91 });
      expect(cache.states().has("t1")).toBe(false);
    });

    it("asks about the branch a thread declared, in that thread's own directory", async () => {
      const probe = vi.fn(async () => okWith("OPEN", 5));
      const cache = new PullRequestStatusCache({
        probe,
        branchOwnership: noOwnership,
        now: () => 0,
      });

      cache.refresh([{ threadId: "t1", cwd: "/repo/checkout", branch: "worker-one" }]);
      await cache.settled();

      expect(probe).toHaveBeenCalledWith("/repo/checkout", "worker-one");
    });

    it("never hands gh a digit-only branch, which it would read as an unrelated PR number", async () => {
      // Regression: a thread declaring branch "123" must not surface PR #123's
      // state — `gh pr view 123` reads a bare number as a PR number, not a branch.
      const probe = vi.fn(async () => okWith("OPEN", 123));
      const cache = new PullRequestStatusCache({
        probe,
        branchOwnership: noOwnership,
        now: () => 0,
      });

      cache.refresh([{ threadId: "t1", cwd: "/repo", branch: "123" }]);
      await cache.settled();

      expect(probe).not.toHaveBeenCalled();
      expect(cache.states().size).toBe(0);
    });

    it("says nothing about a thread sharing a checkout it does not own a branch in", async () => {
      // The primary checkout's branch belongs to the checkout, not to any one of
      // the threads sitting in it, so no thread inherits its pull request.
      const probe = vi.fn(async () => okWith("OPEN", 5));
      const cache = new PullRequestStatusCache({
        probe,
        branchOwnership: async () => ({ kind: "shared" }),
        now: () => 0,
      });

      cache.refresh([{ threadId: "t1", cwd: "/repo" }, { threadId: "t2", cwd: "/repo" }]);
      await cache.settled();

      expect(probe).not.toHaveBeenCalled();
      expect(cache.states().size).toBe(0);
    });

    it("keeps a thread in a worktree branch-scoped without any declaration", async () => {
      const probe = vi.fn(async () => okWith("OPEN", 33));
      const cache = new PullRequestStatusCache({
        probe,
        branchOwnership: async (cwd) => (cwd === "/repo/cd-task"
          ? { kind: "owned", branch: "task-branch" }
          : { kind: "shared" }),
        now: () => 0,
      });

      cache.refresh([{ threadId: "t1", cwd: "/repo/cd-task" }, { threadId: "t2", cwd: "/repo" }]);
      await cache.settled();

      expect(probe).toHaveBeenCalledExactlyOnceWith("/repo/cd-task", "task-branch");
      expect([...cache.states()]).toEqual([["t1", { state: "open", number: 33 }]]);
    });

    it("gives both threads in one worktree the pull request they share", async () => {
      const probe = vi.fn(async () => okWith("OPEN", 33));
      const cache = new PullRequestStatusCache({
        probe,
        branchOwnership: async () => ({ kind: "owned", branch: "task-branch" }),
        now: () => 0,
      });

      cache.refresh([{ threadId: "t1", cwd: "/repo/cd-task" }, { threadId: "t2", cwd: "/repo/cd-task" }]);
      await cache.settled();

      expect(probe).toHaveBeenCalledTimes(1);
      expect(cache.states().get("t1")).toEqual({ state: "open", number: 33 });
      expect(cache.states().get("t2")).toEqual({ state: "open", number: 33 });
    });

    it("never hands gh a declared branch that would read as a flag", async () => {
      const probe = vi.fn(async () => okWith("OPEN", 5));
      const cache = new PullRequestStatusCache({ probe, branchOwnership: noOwnership, now: () => 0 });

      cache.refresh([onBranch("t1", "--json")]);
      await cache.settled();

      expect(probe).not.toHaveBeenCalled();
      expect(cache.states().size).toBe(0);
    });

    it("forgets a thread that has left the fleet", async () => {
      const cache = new PullRequestStatusCache({
        probe: async () => okWith("OPEN", 5),
        branchOwnership: noOwnership,
        now: () => 0,
      });

      cache.refresh([onBranch("t1", "feature")]);
      await cache.settled();
      expect(cache.states().size).toBe(1);

      cache.refresh([]);
      expect(cache.states().size).toBe(0);
    });
  });

  it("does not re-probe a resolved branch inside the TTL, and does after it", async () => {
    let now = 1_000;
    const probe = vi.fn(async () => okWith("OPEN"));
    const cache = new PullRequestStatusCache({ probe, branchOwnership: noOwnership, now: () => now });

    cache.refresh([onBranch("t1", "feature")]);
    await cache.settled();
    now += 59_000;
    cache.refresh([onBranch("t1", "feature")]);
    await cache.settled();
    expect(probe).toHaveBeenCalledTimes(1);

    now += 2_000;
    cache.refresh([onBranch("t1", "feature")]);
    await cache.settled();
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("backs off harder on a branch with no pull request", async () => {
    let now = 1_000;
    const probe = vi.fn(async (): Promise<PullRequestProbeOutcome> => ({ kind: "absent" }));
    const cache = new PullRequestStatusCache({ probe, branchOwnership: noOwnership, now: () => now });

    cache.refresh([onBranch("t1", "feature")]);
    await cache.settled();
    expect(cache.states().size).toBe(0);

    now += 120_000;
    cache.refresh([onBranch("t1", "feature")]);
    await cache.settled();
    expect(probe).toHaveBeenCalledTimes(1);

    now += 200_000;
    cache.refresh([onBranch("t1", "feature")]);
    await cache.settled();
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("stops probing for good once gh turns out to be missing", async () => {
    const probe = vi.fn(async (): Promise<PullRequestProbeOutcome> => ({ kind: "unavailable" }));
    const cache = new PullRequestStatusCache({ probe, branchOwnership: noOwnership });

    cache.refresh([onBranch("t1", "one")]);
    await cache.settled();
    cache.refresh([onBranch("t1", "one"), onBranch("t2", "two")]);
    await cache.settled();

    expect(probe).toHaveBeenCalledTimes(1);
    expect(cache.states().size).toBe(0);
  });

  it("drops everything it knew when gh disappears mid-session", async () => {
    const outcomes: PullRequestProbeOutcome[] = [okWith("OPEN"), { kind: "unavailable" }];
    let index = 0;
    const cache = new PullRequestStatusCache({
      probe: async () => outcomes[index++] ?? { kind: "absent" },
      branchOwnership: noOwnership,
      now: () => 0,
    });

    cache.refresh([onBranch("t1", "one")]);
    await cache.settled();
    expect(cache.states().get("t1")?.state).toBe("open");

    cache.refresh([onBranch("t1", "one"), onBranch("t2", "two")]);
    await cache.settled();
    expect(cache.states().size).toBe(0);
  });

  it("swallows a probe that throws and treats the branch as having no PR", async () => {
    const cache = new PullRequestStatusCache({
      probe: async () => { throw new Error("gh exploded"); },
      branchOwnership: noOwnership,
    });

    cache.refresh([onBranch("t1", "one")]);
    await expect(cache.settled()).resolves.toBeUndefined();
    expect(cache.states().size).toBe(0);
  });

  it("deduplicates identical questions within one refresh and bounds the queue", async () => {
    const probe = vi.fn(async () => okWith("MERGED"));
    const cache = new PullRequestStatusCache({ probe, branchOwnership: noOwnership, now: () => 0 });

    cache.refresh([onBranch("t1", "one"), onBranch("t2", "one"), onBranch("t3", "one")]);
    await cache.settled();
    expect(probe).toHaveBeenCalledTimes(1);

    cache.refresh([
      onBranch("a", "a"), onBranch("b", "b"), onBranch("c", "c"),
      onBranch("d", "d"), onBranch("e", "e"), onBranch("f", "f"),
    ]);
    await cache.settled();
    expect(probe).toHaveBeenCalledTimes(5);
  });

  it("omits threads whose probe resolved to no pull request", async () => {
    const cache = new PullRequestStatusCache({
      probe: async (_cwd, branch) => (branch === "one" ? okWith("CLOSED", 4) : { kind: "absent" }),
      branchOwnership: noOwnership,
      now: () => 0,
    });

    cache.refresh([onBranch("t1", "one"), onBranch("t2", "two")]);
    await cache.settled();
    expect([...cache.states()]).toEqual([["t1", { state: "closed", number: 4 }]]);
  });
});

describe("NO_PULL_REQUEST_STATUS", () => {
  it("is inert", () => {
    expect(() => NO_PULL_REQUEST_STATUS.refresh([{ threadId: "t1", cwd: "/repo" }])).not.toThrow();
    expect(NO_PULL_REQUEST_STATUS.states().size).toBe(0);
  });
});
