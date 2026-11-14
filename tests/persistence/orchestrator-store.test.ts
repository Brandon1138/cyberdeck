import { deferred, fixture } from "../orchestration/strigoi-admission-fixture.js";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { orchestratorController, type OrchestratorBinding } from "../../src/domain/orchestrator.js";
import { OrchestratorControllerDirectory } from "../../src/orchestration/orchestrator-controller-directory.js";
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
  it("serializes resident CAS behind the same final-effect authority boundary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "resident-transaction-")); directories.push(directory);
    const store = new OrchestratorStore(directory), writer = new OrchestratorStore(directory);
    const state = fixture().state();
    await store.strigoi.compareAndSwap(0, "activate", state);
    const entered = deferred(), finish = deferred();
    let effectFinished = false;
    const effect = store.withAuthority(async () => {
      expect(await writer.findBySessionId(state.activeBinding!.sessionId)).toEqual(state.activeBinding);
      entered.resolve(); await finish.promise;
      expect((await store.strigoi.read()).desired).toBe("enabled");
      effectFinished = true;
    });
    await entered.promise;
    const suspend = writer.strigoi.compareAndSwap(1, "suspend", { ...state, revision: 2, desired: "suspended" })
      .then(() => { expect(effectFinished).toBe(true); });
    finish.resolve(); await effect; await suspend;
    expect((await store.strigoi.read()).desired).toBe("suspended");
  });
  it("holds one coherent authority transaction across instances, nested reads/writes and reset", async () => {
    const directory = await mkdtemp(join(tmpdir(), "binding-transaction-")); directories.push(directory);
    const store = new OrchestratorStore(directory), writer = new OrchestratorStore(directory);
    const original = binding("11111111-1111-4111-8111-111111111111", "model");
    await store.put(original);
    const entered = deferred(), finish = deferred(), reset = vi.fn();
    const transaction = store.withAuthority(async () => {
      expect(await writer.findBySessionId(original.sessionId)).toEqual(original);
      entered.resolve(); await finish.promise;
      await writer.put({ ...original, model: "replacement" });
      expect((await store.get(original.key))!.model).toBe("replacement");
    });
    await entered.promise;
    const resetPending = writer.reset(original.key).then(reset);
    await new Promise((resolve) => setTimeout(resolve, 10)); expect(reset).not.toHaveBeenCalled();
    finish.resolve(); await transaction; await resetPending;
    expect(await store.get(original.key)).toBeUndefined();
  });
  it("releases authority after failure and cannot reuse an expired async owner", async () => {
    const directory = await mkdtemp(join(tmpdir(), "binding-owner-")); directories.push(directory);
    const store = new OrchestratorStore(directory), startLate = deferred(), lateEntered = vi.fn();
    let late!: Promise<void>;
    await expect(store.withAuthority(async () => {
      late = startLate.promise.then(() => store.withAuthority(async () => { lateEntered(); }));
      throw new Error("activation failed");
    })).rejects.toThrow("activation failed");
    const entered = deferred(), finish = deferred();
    const next = store.withAuthority(async () => { entered.resolve(); await finish.promise; });
    await entered.promise; startLate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 10)); expect(lateEntered).not.toHaveBeenCalled();
    finish.resolve(); await next; await late; expect(lateEntered).toHaveBeenCalledOnce();
  });
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
    await store.strigoi.compareAndSwap(0, "activate", { ...initial, revision: 1, desired: "enabled", selection: { provider: "codex", model: "model", cwd: "/repo" }, activeBinding: resident, incarnation: 1, activeGeneration: 1 });
    expect(await store.get(resident.key)).toEqual(resident);
    expect(await store.findBySessionId(sessionId)).toEqual(resident);
    expect(await store.list()).toContainEqual(resident);
    await writeFile(store.strigoi.path, "corrupt\n");
    await expect(store.get(resident.key)).rejects.toMatchObject({ code: "STRIGOI_CORRUPT_STATE" });
    expect(await store.get(ordinary.key)).toEqual(ordinary);
    expect(await store.list()).toEqual([ordinary]);
    expect(await store.findBySessionId(ordinary.sessionId)).toEqual(ordinary);
    await expect(store.findBySessionId(sessionId)).rejects.toMatchObject({ code: "STRIGOI_CORRUPT_STATE" });
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


  it("rejects session collisions in both write orders and concurrent writes", async () => {
    for (const order of ["resident-first", "ordinary-first", "concurrent"] as const) {
      const directory = await mkdtemp(join(tmpdir(), "cyberdeck-collision-")); directories.push(directory);
      const store = new OrchestratorStore(directory), sessionId = "22222222-2222-4222-8222-222222222222", scope = { kind: "fleet" as const };
      const ordinary = binding(sessionId, "model");
      const resident: OrchestratorBinding = { ...ordinary, key: "resident:strigoi", kind: "resident", scope, resident: { name: "strigoi", incarnation: 1 }, grant: { subjectSessionId: sessionId, capabilities: ["thread.list"], scope } };
      const initial = await store.strigoi.read();
      const activate = () => store.strigoi.compareAndSwap(0, "activate", { ...initial, revision: 1, desired: "enabled", selection: { provider: "codex", model: "model", cwd: "/repo" }, activeBinding: resident, incarnation: 1, activeGeneration: 1 });
      if (order === "resident-first") { await activate(); await expect(store.put(ordinary)).rejects.toMatchObject({ code: "STRIGOI_SESSION_CONFLICT" }); }
      else if (order === "ordinary-first") { await store.put(ordinary); await expect(activate()).rejects.toMatchObject({ code: "STRIGOI_SESSION_CONFLICT" }); }
      else { const results = await Promise.allSettled([store.put(ordinary), activate()]); expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1); expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { code: "STRIGOI_SESSION_CONFLICT" } }); }
    }
  });
  it("fails closed on a preexisting collision while unrelated bindings remain readable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cyberdeck-existing-collision-")); directories.push(directory);
    const store = new OrchestratorStore(directory), id = "22222222-2222-4222-8222-222222222222", scope = { kind: "fleet" as const };
    const ordinary = binding("11111111-1111-4111-8111-111111111111", "model"); await store.put(ordinary);
    const resident: OrchestratorBinding = { ...binding(id, "model"), key: "resident:strigoi", kind: "resident", scope, resident: { name: "strigoi", incarnation: 1 }, grant: { subjectSessionId: id, capabilities: ["thread.list"], scope } };
    const initial = await store.strigoi.read();
    await store.strigoi.compareAndSwap(0, "activate", { ...initial, revision: 1, desired: "enabled", selection: { provider: "codex", model: "model", cwd: "/repo" }, activeBinding: resident, incarnation: 1, activeGeneration: 1 });
    const collision: OrchestratorBinding = { ...binding(id, "model"), key: "fleet", scope, grant: { subjectSessionId: id, capabilities: ["thread.list"], scope } };
    await appendFile(store.path, `${JSON.stringify(collision)}\n`);
    await expect(store.findBySessionId(id)).rejects.toMatchObject({ code: "STRIGOI_SESSION_CONFLICT" });
    await expect(store.get("fleet")).rejects.toMatchObject({ code: "STRIGOI_SESSION_CONFLICT" });
    await expect(store.get(resident.key)).rejects.toMatchObject({ code: "STRIGOI_SESSION_CONFLICT" });
    expect(await store.list()).toEqual([ordinary]);
    const directoryView = new OrchestratorControllerDirectory(store);
    const controller = orchestratorController(ordinary);
    expect(await directoryView.forController(controller.controllerId)).toEqual({ controllerId: controller.controllerId, familyId: controller.familyId, sessionId: ordinary.sessionId });
    await expect(store.put({ ...collision, model: "updated" })).rejects.toMatchObject({ code: "STRIGOI_SESSION_CONFLICT" });
    await store.put({ ...ordinary, model: "updated" });
    expect(await store.get(ordinary.key)).toEqual({ ...ordinary, model: "updated" });
    expect(await store.findBySessionId(ordinary.sessionId)).toEqual({ ...ordinary, model: "updated" });
  });
  it("permits established grant revocation during resident corruption but rejects new identities", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cyberdeck-resident-revoke-")); directories.push(directory);
    const store = new OrchestratorStore(directory);
    const ordinary = binding("11111111-1111-4111-8111-111111111111", "model");
    const granted: OrchestratorBinding = { ...ordinary, grant: { ...ordinary.grant, capabilities: ["thread.list", "orchestrator.create"] } };
    await store.put(granted);
    await mkdir(dirname(store.strigoi.path), { recursive: true });
    await writeFile(store.strigoi.path, "corrupt\n");
    await store.put(ordinary);
    expect(await store.get(ordinary.key)).toEqual(ordinary);
    await expect(store.put(binding("22222222-2222-4222-8222-222222222222", "model"))).rejects.toMatchObject({ code: "STRIGOI_CORRUPT_STATE" });
    await expect(store.put({ ...ordinary, key: "workspace:/repo/two" })).rejects.toMatchObject({ code: "STRIGOI_CORRUPT_STATE" });
  });
  it("isolates filesystem faults but fails closed for unknown session authority", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cyberdeck-resident-fs-")); directories.push(directory);
    const store = new OrchestratorStore(directory), ordinary = binding("11111111-1111-4111-8111-111111111111", "model");
    await store.put(ordinary); await mkdir(store.strigoi.path, { recursive: true });
    await expect(store.strigoi.read()).rejects.toMatchObject({ code: "STRIGOI_CORRUPT_STATE" });
    expect(await store.list()).toEqual([ordinary]); expect(await store.findBySessionId(ordinary.sessionId)).toEqual(ordinary);
    await expect(store.findBySessionId("22222222-2222-4222-8222-222222222222")).rejects.toMatchObject({ code: "STRIGOI_CORRUPT_STATE" });
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
