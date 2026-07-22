import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OrchestratorBinding } from "../../src/domain/orchestrator.js";
import { OrchestratorStore } from "../../src/persistence/orchestrator-store.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function binding(sessionId: string, model: string): OrchestratorBinding {
  const now = "2026-07-22T12:00:00.000Z";
  const scope = { kind: "workspace" as const, cwd: "/repo/one" };
  return {
    key: "workspace:/repo/one",
    sessionId,
    provider: "codex",
    model,
    cwd: "/repo/one",
    sandbox: "read-only",
    scope,
    grant: { subjectSessionId: sessionId, capabilities: ["thread.list"], scope },
    createdAt: now,
    updatedAt: now,
  };
}

describe("OrchestratorStore", () => {
  it("invalidates a binding with an append-only reset and accepts a clean replacement", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cyberdeck-orchestrator-store-"));
    directories.push(directory);
    const store = new OrchestratorStore(directory);
    const stale = binding("11111111-1111-4111-8111-111111111111", "invalid-model");
    const replacement = binding("22222222-2222-4222-8222-222222222222", "gpt-5.6-sol");

    await store.put(stale);
    await store.reset(stale.key, "2026-07-22T12:01:00.000Z");
    expect(await store.get(stale.key)).toBeUndefined();
    expect(await store.findBySessionId(stale.sessionId)).toBeUndefined();

    await store.put(replacement);
    expect(await store.get(replacement.key)).toEqual(replacement);
    expect(await store.findBySessionId(replacement.sessionId)).toEqual(replacement);

    const records = (await readFile(store.path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(records).toHaveLength(3);
    expect(records[1]).toEqual({
      recordType: "reset",
      key: stale.key,
      resetAt: "2026-07-22T12:01:00.000Z",
    });
  });
});
