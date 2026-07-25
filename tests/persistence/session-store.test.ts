import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionRecord } from "../../src/domain/session.js";
import { SessionStore } from "../../src/persistence/session-store.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    provider: "codex",
    model: "gpt-5.6-sol",
    effort: "high",
    cwd: "/repo/one",
    detached: true,
    sandbox: "read-only",
    kind: "worker",
    name: "Durable task",
    createdAt: "2026-07-22T10:00:00.000Z",
    updatedAt: "2026-07-22T10:01:00.000Z",
    meaningfulUpdatedAt: "2026-07-22T10:01:00.000Z",
    executionState: "active",
    attachmentState: "detached",
    pid: 4321,
    exitCode: null,
    childIds: [],
    attentionState: "done",
    latestPreview: "The durable result.",
    ...overrides,
  };
}

describe("SessionStore", () => {
  it("replays the latest durable thread snapshot and deletion tombstones", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cyberdeck-session-store-"));
    directories.push(directory);
    const store = new SessionStore(directory);

    await store.put(record());
    await store.put(record({ name: "Renamed", pinned: true, displayOrder: 0 }));
    expect(await store.load()).toEqual([record({ name: "Renamed", pinned: true, displayOrder: 0 })]);

    await store.delete(record().id);
    expect(await store.load()).toEqual([]);
  });

  it("round-trips the sanitized launch record so inspection survives a restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cyberdeck-session-store-"));
    directories.push(directory);
    const store = new SessionStore(directory);
    const launched = record({
      launchRecord: {
        mode: "launch",
        resolvedAt: "2026-07-25T10:00:00.000Z",
        executable: "codex",
        args: ["--no-alt-screen", "-C", "/repo/one"],
        cwd: "/repo/one",
        cyberdeckEnv: { CYBERDECK_PROCESS_ROLE: "worker" },
        inheritedEnvCount: 42,
        truncated: false,
      },
    });

    await store.put(launched);

    expect(await store.load()).toEqual([launched]);
  });

  it("refuses to persist a launch record that is not bounded", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cyberdeck-session-store-"));
    directories.push(directory);
    const store = new SessionStore(directory);
    const unbounded = record({
      launchRecord: {
        mode: "launch",
        resolvedAt: "2026-07-25T10:00:00.000Z",
        executable: "codex",
        args: Array.from({ length: 400 }, () => "-c"),
        cwd: "/repo/one",
        cyberdeckEnv: {},
        inheritedEnvCount: 0,
        truncated: false,
      },
    });

    await expect(store.put(unbounded)).rejects.toThrow();
    expect(await store.load()).toEqual([]);
  });
});
