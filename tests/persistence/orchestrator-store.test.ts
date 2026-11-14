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

  it("exposes the atomic resident and isolates a corrupt resident shard", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cyberdeck-resident-")); directories.push(directory);
    const store = new OrchestratorStore(directory);
    const ordinary = binding("11111111-1111-4111-8111-111111111111", "model");
    await store.put(ordinary);
    const sessionId = "22222222-2222-4222-8222-222222222222";
    const scope = { kind: "fleet" as const };
    const resident: OrchestratorBinding = { ...binding(sessionId, "model"), key: "resident:strigoi", kind: "resident", scope, resident: { name: "strigoi", incarnation: 1 }, grant: { subjectSessionId: sessionId, capabilities: ["thread.list"], scope } };
    const initial = await store.strigoi.read();
    await expect(store.put(resident)).rejects.toThrow("CAS");
    await expect(store.reset(resident.key)).rejects.toThrow("CAS");
    await store.strigoi.compareAndSwap(0, "activate", { ...initial, revision: 1, desired: "enabled", selection: { provider: "codex", model: "model", cwd: "/repo" }, activeBinding: resident, incarnation: 1 });
    expect(await store.get(resident.key)).toEqual(resident);
    expect(await store.findBySessionId(sessionId)).toEqual(resident);
    expect(await store.list()).toContainEqual(resident);
    await writeFile(store.strigoi.path, "corrupt\n");
    await expect(store.get(resident.key)).rejects.toMatchObject({ code: "STRIGOI_CORRUPT_STATE" });
    expect(await store.get(ordinary.key)).toEqual(ordinary);
    expect(await store.list()).toEqual([ordinary]);
    expect(await store.findBySessionId(ordinary.sessionId)).toEqual(ordinary);
  });

  it("rejects legacy resident records while leaving ordinary bindings readable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cyberdeck-resident-legacy-")); directories.push(directory);
    const store = new OrchestratorStore(directory);
    const ordinary = binding("11111111-1111-4111-8111-111111111111", "model");
    await store.put(ordinary);
    const sessionId = "22222222-2222-4222-8222-222222222222", scope = { kind: "fleet" as const };
    const resident = { ...binding(sessionId, "model"), key: "resident:strigoi", kind: "resident", scope, resident: { name: "strigoi", incarnation: 1 }, grant: { subjectSessionId: sessionId, capabilities: ["thread.list"], scope } };
    const { appendFile } = await import("node:fs/promises");
    await appendFile(store.path, `${JSON.stringify(resident)}\n${JSON.stringify(resident)}\n`);
    await expect(store.strigoi.read()).rejects.toMatchObject({ code: "STRIGOI_CORRUPT_STATE" });
    expect(await store.list()).toEqual([ordinary]);
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
    const markerPathSession = "44444444-4444-4444-8444-444444444444";
    const markerPathScope = { kind: "workspace" as const, cwd: "/tmp/repo:peer:archive" };
    const { kind: _markerPathKind, ...legacyMarkerPathPrimary } = {
      ...binding(markerPathSession, "gpt-5.6-sol"),
      key: "workspace:/tmp/repo:peer:archive",
      cwd: markerPathScope.cwd,
      scope: markerPathScope,
      grant: {
        subjectSessionId: markerPathSession,
        capabilities: ["thread.list" as const],
        scope: markerPathScope,
      },
    };
    await mkdir(dirname(store.path), { recursive: true });
    await writeFile(
      store.path,
      `${JSON.stringify(legacyPrimary)}\n${JSON.stringify(legacyPeer)}\n${JSON.stringify(legacyMarkerPathPrimary)}\n`,
      "utf8",
    );

    expect(await store.get(primary.key)).toMatchObject({ key: primary.key, kind: "primary" });
    expect(await store.findBySessionId(peerSession)).toMatchObject({
      key: `workspace:/repo/one:peer:${peerSession}`,
      kind: "peer",
    });
    expect(await store.get(legacyMarkerPathPrimary.key)).toMatchObject({
      key: "workspace:/tmp/repo:peer:archive",
      kind: "primary",
    });
  });
});
