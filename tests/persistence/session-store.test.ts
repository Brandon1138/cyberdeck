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
});
