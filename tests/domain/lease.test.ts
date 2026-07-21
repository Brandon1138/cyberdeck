import { describe, expect, it } from "vitest";
import { WorktreeLeaseSchema } from "../../src/domain/lease.js";

const now = "2026-07-21T00:00:00.000Z";

describe("WorktreeLeaseSchema", () => {
  it("records a held worktree lease with absolute paths", () => {
    const lease = WorktreeLeaseSchema.parse({
      leaseId: crypto.randomUUID(),
      repositoryPath: "/repo",
      worktreePath: "/repo/.worktrees/a",
      branch: "agent-a",
      state: "held",
      acquiredAt: now,
    });
    expect(lease.state).toBe("held");
    expect(lease.releasedAt).toBeUndefined();
  });

  it("rejects relative paths and unknown states", () => {
    expect(() =>
      WorktreeLeaseSchema.parse({
        leaseId: crypto.randomUUID(),
        repositoryPath: "repo",
        worktreePath: "/x",
        state: "held",
        acquiredAt: now,
      }),
    ).toThrow();
    expect(() =>
      WorktreeLeaseSchema.parse({
        leaseId: crypto.randomUUID(),
        repositoryPath: "/repo",
        worktreePath: "/x",
        state: "leased",
        acquiredAt: now,
      }),
    ).toThrow();
  });
});
