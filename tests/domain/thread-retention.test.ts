import { describe, expect, it } from "vitest";
import type { SessionRecord } from "../../src/domain/session.js";
import {
  isRetirableThread,
  selectExpiredThreads,
  ThreadRetentionPolicySchema,
} from "../../src/domain/thread-retention.js";

const NOW = Date.parse("2026-07-26T12:00:00.000Z");

function daysAgo(days: number): string {
  return new Date(NOW - days * 24 * 60 * 60 * 1_000).toISOString();
}

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    provider: "codex",
    cwd: "/repo/one",
    detached: true,
    sandbox: "read-only",
    kind: "worker",
    createdAt: daysAgo(1),
    updatedAt: daysAgo(1),
    meaningfulUpdatedAt: daysAgo(1),
    executionState: "exited",
    attachmentState: "detached",
    pid: 4321,
    exitCode: 0,
    childIds: [],
    attentionState: "done",
    ...overrides,
  } as SessionRecord;
}

function id(value: number): string {
  return `1111111${value}-1111-4111-8111-111111111111`;
}

describe("thread retention", () => {
  it("defaults to seven days and two hundred retained threads", () => {
    expect(ThreadRetentionPolicySchema.parse({})).toEqual({
      maxAgeDays: 7,
      maxThreads: 200,
      keepPinned: true,
    });
  });

  it("only treats threads whose process is gone as retirable", () => {
    expect(isRetirableThread(record({ executionState: "exited", exitCode: 0 }))).toBe(true);
    expect(isRetirableThread(record({ executionState: "failed", exitCode: 1 }))).toBe(true);
    expect(isRetirableThread(record({ executionState: "cancelled", exitCode: 0 }))).toBe(true);
    expect(isRetirableThread(record({ executionState: "active", exitCode: null }))).toBe(false);
    // Errored keeps a live OS process, so its record still stands for something on the machine.
    expect(isRetirableThread(record({ executionState: "errored", exitCode: null }))).toBe(false);
  });

  it("retires finished threads past the age bound and leaves live ones alone", () => {
    const policy = ThreadRetentionPolicySchema.parse({});
    const expired = selectExpiredThreads([
      record({ id: id(1), meaningfulUpdatedAt: daysAgo(30) }),
      record({ id: id(2), meaningfulUpdatedAt: daysAgo(2) }),
      record({ id: id(3), meaningfulUpdatedAt: daysAgo(30), executionState: "active", exitCode: null }),
    ], policy, NOW);

    expect(expired).toEqual([id(1)]);
  });

  it("never retires a pinned thread while keepPinned holds", () => {
    const aged = record({ id: id(1), meaningfulUpdatedAt: daysAgo(90), pinned: true });
    expect(selectExpiredThreads([aged], ThreadRetentionPolicySchema.parse({}), NOW)).toEqual([]);
    expect(selectExpiredThreads([aged], ThreadRetentionPolicySchema.parse({ keepPinned: false }), NOW))
      .toEqual([id(1)]);
  });

  it("keeps the newest threads when the count bound bites", () => {
    const policy = ThreadRetentionPolicySchema.parse({ maxAgeDays: null, maxThreads: 2 });
    const expired = selectExpiredThreads([
      record({ id: id(1), meaningfulUpdatedAt: daysAgo(3) }),
      record({ id: id(2), meaningfulUpdatedAt: daysAgo(1) }),
      record({ id: id(3), meaningfulUpdatedAt: daysAgo(2) }),
    ], policy, NOW);

    expect(expired).toEqual([id(1)]);
  });

  it("keeps an expired parent whose child is still retained", () => {
    const policy = ThreadRetentionPolicySchema.parse({});
    const expired = selectExpiredThreads([
      record({ id: id(1), meaningfulUpdatedAt: daysAgo(30), childIds: [id(2)] }),
      record({ id: id(2), meaningfulUpdatedAt: daysAgo(1), parentSessionId: id(1) }),
    ], policy, NOW);

    expect(expired).toEqual([]);
  });

  it("retires a whole tree once every member has aged out", () => {
    const policy = ThreadRetentionPolicySchema.parse({});
    const expired = selectExpiredThreads([
      record({ id: id(1), meaningfulUpdatedAt: daysAgo(30), childIds: [id(2)] }),
      record({ id: id(2), meaningfulUpdatedAt: daysAgo(30), parentSessionId: id(1) }),
    ], policy, NOW);

    expect(new Set(expired)).toEqual(new Set([id(1), id(2)]));
  });

  it("retains everything when both bounds are disabled", () => {
    const policy = ThreadRetentionPolicySchema.parse({ maxAgeDays: null, maxThreads: null });
    expect(selectExpiredThreads([record({ meaningfulUpdatedAt: daysAgo(900) })], policy, NOW)).toEqual([]);
  });
});
