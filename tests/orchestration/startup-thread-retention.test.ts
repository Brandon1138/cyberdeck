import { describe, expect, it } from "vitest";
import type { SessionRecord } from "../../src/domain/session.js";
import type { ThreadRetentionPolicy } from "../../src/domain/thread-retention.js";
import { retainStartupThreads } from "../../src/orchestration/startup-thread-retention.js";

const policy: ThreadRetentionPolicy = {
  maxAgeDays: 7,
  maxThreads: null,
  keepPinned: true,
};

function record(
  id: string,
  profile: "scout" | "codex" = "codex",
  updatedAt = "2020-01-01T00:00:00.000Z",
): SessionRecord {
  return {
    id,
    profile,
    updatedAt,
    meaningfulUpdatedAt: updatedAt,
    executionState: "exited",
    exitCode: 0,
    pinned: false,
    childIds: [],
  } as unknown as SessionRecord;
}

function ports(records: SessionRecord[], operations: string[] = []) {
  return {
    catalog: {
      async load() {
        operations.push("load");
        return records;
      },
      async compact(survivors: readonly SessionRecord[]) {
        operations.push(`compact:${survivors.map(({ id }) => id).join(",")}`);
      },
    },
    scoutReports: {
      async remove(sessionId: string) {
        operations.push(`scout:${sessionId}`);
      },
    },
    claudeBindings: {
      async dropClaudeBinding(sessionId: string) {
        operations.push(`binding:${sessionId}`);
      },
    },
    operations,
  };
}

describe("startup thread retention", () => {
  it("returns the loaded records without work when none expire", async () => {
    const loaded = [record("fresh", "codex", "2025-01-01T00:00:00.000Z")];
    const fake = ports(loaded);

    await expect(retainStartupThreads(fake, policy, Date.parse("2025-01-02T00:00:00.000Z")))
      .resolves.toBe(loaded);
    expect(fake.operations).toEqual(["load"]);
  });

  it("cleans expired resources, compacts survivors, and preserves order", async () => {
    const loaded = [
      record("keep-first", "codex", "2025-01-01T00:00:00.000Z"),
      record("scout-old", "scout"),
      record("keep-second", "codex", "2025-01-01T00:00:00.000Z"),
      record("ordinary-old"),
    ];
    const fake = ports(loaded);

    await expect(retainStartupThreads(fake, policy, Date.parse("2025-01-02T00:00:00.000Z")))
      .resolves.toEqual([loaded[0], loaded[2]]);
    expect(fake.operations[0]).toBe("load");
    expect(fake.operations).toContain("scout:scout-old");
    expect(fake.operations).toContain("binding:scout-old");
    expect(fake.operations).toContain("binding:ordinary-old");
    expect(fake.operations).not.toContain("scout:ordinary-old");
    expect(fake.operations.at(-1)).toBe("compact:keep-first,keep-second");
    expect(fake.operations.indexOf("scout:scout-old"))
      .toBeLessThan(fake.operations.indexOf("binding:scout-old"));
  });

  it("settles cleanup rejection before compacting", async () => {
    const loaded = [record("expired")];
    const operations: string[] = [];
    const fake = ports(loaded, operations);
    fake.claudeBindings.dropClaudeBinding = async (sessionId: string) => {
      operations.push(`binding:${sessionId}`);
      throw new Error("binding cleanup failed");
    };

    await expect(retainStartupThreads(fake, policy, Date.parse("2025-01-02T00:00:00.000Z")))
      .resolves.toEqual([]);
    expect(fake.operations).toEqual(["load", "binding:expired", "compact:"]);
  });

  it("skips binding cleanup when Scout removal rejects", async () => {
    const loaded = [record("scout-old", "scout")];
    const fake = ports(loaded);
    fake.scoutReports.remove = async (sessionId: string) => {
      fake.operations.push(`scout:${sessionId}`);
      throw new Error("Scout cleanup failed");
    };

    await expect(retainStartupThreads(fake, policy, Date.parse("2025-01-02T00:00:00.000Z")))
      .resolves.toEqual([]);
    expect(fake.operations).toEqual(["load", "scout:scout-old", "compact:"]);
  });

  it("starts cleanup for later records before earlier cleanup settles", async () => {
    const loaded = [record("first-old"), record("second-old")];
    const operations: string[] = [];
    const fake = ports(loaded, operations);
    let releaseFirst!: () => void;
    let rejectFirst!: () => void;
    let releaseSecond!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
    fake.claudeBindings.dropClaudeBinding = async (sessionId: string) => {
      operations.push(`binding:start:${sessionId}`);
      if (sessionId === "first-old") {
        await firstGate;
        rejectFirst();
        throw new Error("first cleanup failed");
      }
      await secondGate;
      operations.push(`binding:done:${sessionId}`);
    };
    const rejectedFirst = new Promise<void>((_, reject) => { rejectFirst = () => reject(); });
    const retention = retainStartupThreads(
      fake,
      policy,
      Date.parse("2025-01-02T00:00:00.000Z"),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(operations).toEqual(["load", "binding:start:first-old", "binding:start:second-old"]);
    expect(operations).not.toContain("compact:");
    releaseFirst();
    releaseSecond();
    await rejectedFirst.catch(() => undefined);
    await expect(retention).resolves.toEqual([]);
    expect(operations).toEqual([
      "load",
      "binding:start:first-old",
      "binding:start:second-old",
      "binding:done:second-old",
      "compact:",
    ]);
    expect(operations).not.toContain("scout:first-old");
    expect(operations).not.toContain("scout:second-old");
  });
});
