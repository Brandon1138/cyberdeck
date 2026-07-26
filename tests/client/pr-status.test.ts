import { describe, expect, it, vi } from "vitest";
import {
  NO_PULL_REQUEST_STATUS,
  parsePullRequestPayload,
  PullRequestStatusCache,
  pullRequestGlyph,
  pullRequestState,
  rollupHasFailure,
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

describe("pullRequestGlyph", () => {
  it("gives every state a distinct glyph", () => {
    const states: PullRequestState[] = ["open", "draft", "merged", "closed", "checks-failing"];
    const glyphs = states.map((state) => pullRequestGlyph(state).glyph);
    expect(new Set(glyphs).size).toBe(states.length);
    expect(glyphs.every((glyph) => glyph.length === 1)).toBe(true);
  });

  it("reserves the alarm tone for failing checks among live pull requests", () => {
    expect(pullRequestGlyph("checks-failing").tone).toBe("prFailing");
    expect(pullRequestGlyph("open").tone).toBe("prOpen");
  });

  it("names semantic palette tokens rather than raw hues", () => {
    // The column paints pull-request state, so the tone travels as state and
    // the fleet palette owns the hue. Closed is inert, not a fault; merged is
    // its own token so it can never collapse into the reserved brand purple.
    expect(pullRequestGlyph("draft").tone).toBe("prDraft");
    expect(pullRequestGlyph("merged").tone).toBe("prMerged");
    expect(pullRequestGlyph("closed").tone).toBe("prClosed");
  });
});

describe("parsePullRequestPayload", () => {
  it("reads a gh payload", () => {
    expect(parsePullRequestPayload(JSON.stringify({
      state: "OPEN",
      isDraft: false,
      statusCheckRollup: [checkRun({ conclusion: "TIMED_OUT" })],
    }))).toBe("checks-failing");
  });

  it("shows nothing for output that is not a pull request object", () => {
    expect(parsePullRequestPayload("")).toBeUndefined();
    expect(parsePullRequestPayload("not json")).toBeUndefined();
    expect(parsePullRequestPayload("null")).toBeUndefined();
    expect(parsePullRequestPayload("[]")).toBeUndefined();
  });
});

describe("PullRequestStatusCache", () => {
  const okWith = (state: string, rollup: unknown = null): PullRequestProbeOutcome => ({
    kind: "ok",
    stdout: JSON.stringify({ state, isDraft: false, statusCheckRollup: rollup }),
  });

  it("never blocks a read: states are empty until a probe lands", async () => {
    let release = (): void => undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const probe = vi.fn(async () => {
      await blocked;
      return okWith("OPEN");
    });
    const cache = new PullRequestStatusCache({ probe });

    cache.refresh(["/repo/one"]);
    expect(cache.states().size).toBe(0);

    release();
    await cache.settled();
    expect(cache.states().get("/repo/one")).toBe("open");
  });

  it("does not re-probe a resolved worktree inside the TTL, and does after it", async () => {
    let now = 1_000;
    const probe = vi.fn(async () => okWith("OPEN"));
    const cache = new PullRequestStatusCache({ probe, now: () => now });

    cache.refresh(["/repo/one"]);
    await cache.settled();
    now += 59_000;
    cache.refresh(["/repo/one"]);
    await cache.settled();
    expect(probe).toHaveBeenCalledTimes(1);

    now += 2_000;
    cache.refresh(["/repo/one"]);
    await cache.settled();
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("backs off harder on a worktree with no pull request", async () => {
    let now = 1_000;
    const probe = vi.fn(async (): Promise<PullRequestProbeOutcome> => ({ kind: "absent" }));
    const cache = new PullRequestStatusCache({ probe, now: () => now });

    cache.refresh(["/repo/one"]);
    await cache.settled();
    expect(cache.states().size).toBe(0);

    now += 120_000;
    cache.refresh(["/repo/one"]);
    await cache.settled();
    expect(probe).toHaveBeenCalledTimes(1);

    now += 200_000;
    cache.refresh(["/repo/one"]);
    await cache.settled();
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("stops probing for good once gh turns out to be missing", async () => {
    const probe = vi.fn(async (): Promise<PullRequestProbeOutcome> => ({ kind: "unavailable" }));
    const cache = new PullRequestStatusCache({ probe });

    cache.refresh(["/repo/one"]);
    await cache.settled();
    cache.refresh(["/repo/one", "/repo/two"]);
    await cache.settled();

    expect(probe).toHaveBeenCalledTimes(1);
    expect(cache.states().size).toBe(0);
  });

  it("drops everything it knew when gh disappears mid-session", async () => {
    const outcomes: PullRequestProbeOutcome[] = [okWith("OPEN"), { kind: "unavailable" }];
    let index = 0;
    const cache = new PullRequestStatusCache({
      probe: async () => outcomes[index++] ?? { kind: "absent" },
      now: () => 0,
    });

    cache.refresh(["/repo/one"]);
    await cache.settled();
    expect(cache.states().get("/repo/one")).toBe("open");

    cache.refresh(["/repo/two"]);
    await cache.settled();
    expect(cache.states().size).toBe(0);
  });

  it("swallows a probe that throws and treats the worktree as having no PR", async () => {
    const cache = new PullRequestStatusCache({
      probe: async () => { throw new Error("gh exploded"); },
    });

    cache.refresh(["/repo/one"]);
    await expect(cache.settled()).resolves.toBeUndefined();
    expect(cache.states().size).toBe(0);
  });

  it("deduplicates worktrees within one refresh and bounds the queue", async () => {
    const probe = vi.fn(async () => okWith("MERGED"));
    const cache = new PullRequestStatusCache({ probe, now: () => 0 });

    cache.refresh(["/repo/one", "/repo/one", "/repo/one"]);
    await cache.settled();
    expect(probe).toHaveBeenCalledTimes(1);

    cache.refresh(["/a", "/b", "/c", "/d", "/e", "/f"]);
    await cache.settled();
    expect(probe).toHaveBeenCalledTimes(5);
  });

  it("omits worktrees whose probe resolved to no pull request", async () => {
    const cache = new PullRequestStatusCache({
      probe: async (cwd) => (cwd === "/repo/one" ? okWith("CLOSED") : { kind: "absent" }),
      now: () => 0,
    });

    cache.refresh(["/repo/one", "/repo/two"]);
    await cache.settled();
    expect([...cache.states()]).toEqual([["/repo/one", "closed"]]);
  });
});

describe("NO_PULL_REQUEST_STATUS", () => {
  it("is inert", () => {
    expect(() => NO_PULL_REQUEST_STATUS.refresh(["/repo/one"])).not.toThrow();
    expect(NO_PULL_REQUEST_STATUS.states().size).toBe(0);
  });
});
