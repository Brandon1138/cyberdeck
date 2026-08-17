import { describe, expect, it } from "vitest";
import {
  AdmissionScheduler,
  type AdmissionCandidate,
} from "../../src/control-plane/admission-scheduler.js";
import type { ConcurrencyDeclaration } from "../../src/domain/budget.js";

const BASE = Date.parse("2026-07-21T00:00:00.000Z");

function at(offsetMs: number): string {
  return new Date(BASE + offsetMs).toISOString();
}

function closedScheduler(limits: Partial<ConcurrencyDeclaration> = {}): AdmissionScheduler {
  let counter = 0;
  return new AdmissionScheduler({
    limits: { schemaVersion: 1, ...limits },
    now: () => at(0),
    idFactory: () => `reservation-${(counter += 1)}`,
  });
}

/** A scheduler whose startup gate is already open, i.e. post-recovery/reconciliation. */
function scheduler(limits: Partial<ConcurrencyDeclaration> = {}): AdmissionScheduler {
  const admission = closedScheduler(limits);
  admission.openAdmission();
  return admission;
}

function candidate(
  jobId: string,
  overrides: Partial<AdmissionCandidate> = {},
): AdmissionCandidate {
  return {
    jobId,
    provider: "codex",
    repositoryKey: "/tmp/repo",
    enqueuedAt: at(0),
    ...overrides,
  };
}

describe("admission scheduler", () => {
  it("admits up to the global concurrency ceiling and queues the remainder", () => {
    const admission = scheduler({ maxConcurrentJobs: 2 });
    admission.enqueue(candidate("a", { enqueuedAt: at(1) }));
    admission.enqueue(candidate("b", { enqueuedAt: at(2) }));
    admission.enqueue(candidate("c", { enqueuedAt: at(3) }));

    expect(admission.admitNext()?.jobId).toBe("a");
    expect(admission.admitNext()?.jobId).toBe("b");
    expect(admission.admitNext()).toBeUndefined();
    expect(admission.snapshot().queued.map((entry) => entry.jobId)).toEqual(["c"]);
    expect(admission.snapshot().queued[0]?.blockedBy).toBe("MAX_CONCURRENT_JOBS");
  });

  it("orders admission deterministically by enqueue time then admission sequence", () => {
    const admission = scheduler({ maxConcurrentJobs: 4 });
    admission.enqueue(candidate("z", { enqueuedAt: at(5) }));
    // Identical timestamps are broken by the order they were enqueued in, not by job id: the
    // ids here are deliberately not in the order the assertion expects.
    admission.enqueue(candidate("b", { enqueuedAt: at(1) }));
    admission.enqueue(candidate("c", { enqueuedAt: at(1) }));
    admission.enqueue(candidate("a", { enqueuedAt: at(1) }));

    expect([
      admission.admitNext()?.jobId,
      admission.admitNext()?.jobId,
      admission.admitNext()?.jobId,
      admission.admitNext()?.jobId,
    ]).toEqual(["b", "c", "a", "z"]);
  });

  it("releases jobs sharing one millisecond in enqueue order, whatever their ids sort like", () => {
    const admission = scheduler({ maxConcurrentJobs: 8 });
    // Real submits carry random UUIDs and a millisecond-resolution clock, so a burst ties on
    // `enqueuedAt`. Descending ids make a job-id tie-break produce exactly the reverse order.
    const burst = ["h", "g", "f", "e", "d", "c", "b", "a"];
    for (const jobId of burst) admission.enqueue(candidate(jobId, { enqueuedAt: at(7) }));

    expect(admission.snapshot().queued.map((entry) => entry.jobId)).toEqual(burst);
    const released = burst.map(() => admission.admitNext()?.jobId);
    expect(released).toEqual(burst);
    expect(admission.admitNext()).toBeUndefined();
  });

  it("keeps a re-enqueued job's place in its timestamp tie rather than restamping it", () => {
    const admission = scheduler({ maxConcurrentJobs: 3 });
    admission.enqueue(candidate("first", { enqueuedAt: at(2) }));
    admission.enqueue(candidate("second", { enqueuedAt: at(2) }));
    // A retried submit must not push the job it re-enqueues behind everything that arrived later.
    admission.enqueue(candidate("first", { enqueuedAt: at(2) }));
    admission.enqueue(candidate("third", { enqueuedAt: at(2) }));

    expect([
      admission.admitNext()?.jobId,
      admission.admitNext()?.jobId,
      admission.admitNext()?.jobId,
    ]).toEqual(["first", "second", "third"]);
  });

  it("still orders strictly by enqueue time when a later arrival carries an older timestamp", () => {
    const admission = scheduler({ maxConcurrentJobs: 2 });
    admission.enqueue(candidate("later-arrival-older-stamp", { enqueuedAt: at(9) }));
    admission.enqueue(candidate("earlier-stamp", { enqueuedAt: at(1) }));

    // Sequence is the tie-break, never an override: a distinct earlier timestamp still wins.
    expect(admission.admitNext()?.jobId).toBe("earlier-stamp");
    expect(admission.admitNext()?.jobId).toBe("later-arrival-older-stamp");
  });

  it("passes over a saturated provider bucket without starving it or reordering within it", () => {
    const admission = scheduler({ maxConcurrentPerProvider: { codex: 1 } });
    admission.enqueue(candidate("codex-1", { enqueuedAt: at(1) }));
    admission.enqueue(candidate("codex-2", { enqueuedAt: at(2) }));
    admission.enqueue(candidate("codex-3", { enqueuedAt: at(3) }));
    admission.enqueue(candidate("cursor-1", { provider: "cursor", enqueuedAt: at(4) }));

    expect(admission.admitNext()?.jobId).toBe("codex-1");
    // The younger cursor job may pass the blocked codex jobs; the codex bucket keeps its order.
    expect(admission.admitNext()?.jobId).toBe("cursor-1");
    expect(admission.admitNext()).toBeUndefined();

    admission.release("codex-1");
    expect(admission.admitNext()?.jobId).toBe("codex-2");
  });

  it("bounds concurrent work per canonical repository", () => {
    const admission = scheduler({ maxConcurrentPerRepository: 1 });
    admission.enqueue(candidate("first", { enqueuedAt: at(1) }));
    admission.enqueue(candidate("second", { enqueuedAt: at(2) }));
    admission.enqueue(candidate("other-repo", { repositoryKey: "/tmp/other", enqueuedAt: at(3) }));

    expect(admission.admitNext()?.jobId).toBe("first");
    expect(admission.admitNext()?.jobId).toBe("other-repo");
    expect(admission.snapshot().queued[0]?.blockedBy).toBe("MAX_CONCURRENT_PER_REPOSITORY");
  });

  it("reserves a slot exactly once per job", () => {
    const admission = scheduler({ maxConcurrentJobs: 2 });
    admission.enqueue(candidate("a"));
    admission.enqueue(candidate("a"));
    expect(admission.snapshot().queued).toHaveLength(1);

    expect(admission.admitNext()?.jobId).toBe("a");
    expect(admission.admitNext()).toBeUndefined();
    expect(admission.activeCount).toBe(1);
  });

  it("releases a slot exactly once and ignores a duplicate release", () => {
    const admission = scheduler({ maxConcurrentJobs: 1 });
    admission.enqueue(candidate("a", { enqueuedAt: at(1) }));
    admission.enqueue(candidate("b", { enqueuedAt: at(2) }));
    admission.admitNext();

    expect(admission.release("a")).toBe(true);
    expect(admission.release("a")).toBe(false);
    expect(admission.release("never-admitted")).toBe(false);
    expect(admission.activeCount).toBe(0);

    expect(admission.admitNext()?.jobId).toBe("b");
    expect(admission.admitNext()).toBeUndefined();
  });

  it("never substitutes a provider or repository to fill spare capacity", () => {
    const admission = scheduler({ maxConcurrentPerProvider: { codex: 1 }, maxConcurrentJobs: 4 });
    admission.enqueue(candidate("codex-1", { enqueuedAt: at(1) }));
    admission.enqueue(candidate("codex-2", { enqueuedAt: at(2) }));
    const first = admission.admitNext();
    const second = admission.admitNext();

    expect(first?.provider).toBe("codex");
    // Three global slots remain free, but a blocked codex job is never admitted as another provider.
    expect(second).toBeUndefined();
    expect(admission.snapshot().queued.map((entry) => entry.provider)).toEqual(["codex"]);
  });

  it("refuses to admit a Claude job whose model is omitted even when capacity is free", () => {
    const admission = scheduler({ maxConcurrentJobs: 4 });
    admission.enqueue(candidate("claude-omitted", { provider: "claude", enqueuedAt: at(1) }));
    admission.enqueue(candidate("codex-ok", { enqueuedAt: at(2) }));

    expect(admission.admitNext()?.jobId).toBe("codex-ok");
    expect(admission.admitNext()).toBeUndefined();
    expect(admission.snapshot().queued[0]?.blockedBy).toBe(
      "CLAUDE_LAUNCH_REQUIRES_EXPLICIT_MODEL",
    );
  });

  it("admits a Claude job that explicitly requests Fable", () => {
    const admission = scheduler({ maxConcurrentJobs: 4 });
    admission.enqueue(candidate("fable", { provider: "claude", model: "claude-fable-5" }));
    expect(admission.admitNext()?.jobId).toBe("fable");
  });

  it("drops a queued job that never launched without consuming a slot", () => {
    const admission = scheduler({ maxConcurrentJobs: 1 });
    admission.enqueue(candidate("a", { enqueuedAt: at(1) }));
    admission.enqueue(candidate("b", { enqueuedAt: at(2) }));

    expect(admission.withdraw("a")).toBe(true);
    expect(admission.withdraw("a")).toBe(false);
    expect(admission.admitNext()?.jobId).toBe("b");
    expect(admission.activeCount).toBe(1);
  });

  it("admits nothing while admission is closed and resumes in order when reopened", () => {
    const admission = scheduler({ maxConcurrentJobs: 4 });
    admission.closeAdmission();
    admission.enqueue(candidate("a", { enqueuedAt: at(1) }));
    admission.enqueue(candidate("b", { enqueuedAt: at(2) }));

    expect(admission.admitNext()).toBeUndefined();
    expect(admission.snapshot().admissionOpen).toBe(false);
    expect(admission.snapshot().queued).toHaveLength(2);

    admission.openAdmission();
    expect(admission.admitNext()?.jobId).toBe("a");
    expect(admission.admitNext()?.jobId).toBe("b");
  });

  it("starts closed so nothing is dispatched before recovery and reconciliation run", () => {
    const admission = closedScheduler({ maxConcurrentJobs: 1 });
    admission.enqueue(candidate("a"));
    expect(admission.snapshot().admissionOpen).toBe(false);
    expect(admission.admitNext()).toBeUndefined();
  });

  it("reports queue and reservation state for control-plane queries", () => {
    const admission = scheduler({ maxConcurrentJobs: 1 });
    admission.enqueue(candidate("a", { enqueuedAt: at(1) }));
    admission.enqueue(candidate("b", { enqueuedAt: at(2) }));
    admission.admitNext();

    const snapshot = admission.snapshot();
    expect(snapshot.limits.maxConcurrentJobs).toBe(1);
    expect(snapshot.reservations).toEqual([
      {
        reservationId: "reservation-1",
        jobId: "a",
        provider: "codex",
        repositoryKey: "/tmp/repo",
        reservedAt: at(0),
      },
    ]);
    expect(snapshot.queued).toEqual([
      {
        jobId: "b",
        provider: "codex",
        repositoryKey: "/tmp/repo",
        enqueuedAt: at(2),
        blockedBy: "MAX_CONCURRENT_JOBS",
      },
    ]);
  });
});
