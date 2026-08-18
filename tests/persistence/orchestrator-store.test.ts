import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
    kind: "primary",
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

  /**
   * The log is append-only and predates MIK-98's `kind` field, so lines written by an older build
   * are still the ones this build reads. A primary and a peer written before the field existed both
   * load, and each reads back as what its key already said it was.
   */
  it("loads bindings written before the kind field existed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cyberdeck-orchestrator-store-legacy-"));
    directories.push(directory);
    const store = new OrchestratorStore(directory);
    const peerSession = "33333333-3333-4333-8333-333333333333";
    const primary = binding("11111111-1111-4111-8111-111111111111", "gpt-5.6-sol");
    const { kind: _primaryKind, ...legacyPrimary } = primary;
    const { kind: _peerKind, ...legacyPeer } = {
      ...binding(peerSession, "gpt-5.6-sol"),
      key: `workspace:/repo/one:peer:${peerSession}`,
    };
    await mkdir(dirname(store.path), { recursive: true });
    await writeFile(
      store.path,
      `${JSON.stringify(legacyPrimary)}\n${JSON.stringify(legacyPeer)}\n`,
      "utf8",
    );

    expect(await store.get(primary.key)).toMatchObject({ key: primary.key, kind: "primary" });
    expect(await store.findBySessionId(peerSession)).toMatchObject({
      key: `workspace:/repo/one:peer:${peerSession}`,
      kind: "peer",
    });
  });
});
