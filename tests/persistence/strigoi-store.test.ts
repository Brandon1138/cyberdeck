import { appendFile, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as privateFiles from "../../src/persistence/private-files.js";
import { StrigoiStore } from "../../src/persistence/strigoi-store.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });
async function store() { const d = await mkdtemp(join(tmpdir(), "strigoi-")); dirs.push(d); return { d, s: new StrigoiStore(d) }; }

describe("StrigoiStore", () => {
  it("serializes CAS and durably replays mutation IDs", async () => {
    const { d, s } = await store(); const initial = await s.read();
    const next = { ...initial, revision: 1, desired: "suspended" as const };
    const results = await Promise.allSettled([s.compareAndSwap(0, "one", next), new StrigoiStore(d).compareAndSwap(0, "two", next)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { code: "STRIGOI_REVISION_CONFLICT" } });
    const winner = results[0].status === "fulfilled" ? "one" : "two";
    const reopened = new StrigoiStore(d);
    expect(await reopened.compareAndSwap(0, winner, next)).toEqual(next);
    await expect(reopened.compareAndSwap(0, winner, { ...next, desired: "disabled" })).rejects.toMatchObject({ code: "STRIGOI_MUTATION_CONFLICT" });
  });
  it("ignores and preserves an incomplete tail before a new commit", async () => {
    const { s } = await store(); const initial = await s.read();
    const first = { ...initial, revision: 1, desired: "suspended" as const };
    await s.compareAndSwap(0, "one", first);
    await appendFile(s.path, '{"partial":');
    expect(await s.read()).toEqual(first);
    await s.compareAndSwap(1, "two", { ...first, revision: 2 });
    expect((await readFile(s.path, "utf8")).trim().split("\n")).toHaveLength(2);
    expect(JSON.parse(await readFile(join(s.path.slice(0, s.path.lastIndexOf("/")), (await readdir(s.path.slice(0, s.path.lastIndexOf("/")))).find((name) => name.startsWith("records.jsonl.tail-"))!), "utf8"))).toEqual({ encoding: "base64", bytes: Buffer.from('{"partial":').toString("base64") });
  });
  it("revalidates replacement and holds on corrupt committed records", async () => {
    const { s } = await store(); const initial = await s.read();
    await s.compareAndSwap(0, "one", { ...initial, revision: 1 });
    const original = await readFile(s.path, "utf8");
    await writeFile(`${s.path}.replacement`, original.replace('"schemaVersion":1', '"schemaVersion":2'));
    await rename(`${s.path}.replacement`, s.path);
    await expect(s.read()).rejects.toMatchObject({ code: "STRIGOI_CORRUPT_STATE" });
  });
  it("lets suspension defeat a prepared activation", async () => {
    const { d, s } = await store(); const initial = await s.read();
    const id = "11111111-1111-4111-8111-111111111111", scope = { kind: "fleet" as const };
    const activeBinding = { key: "resident:strigoi", kind: "resident" as const, sessionId: id, provider: "codex" as const, cwd: "/repo", sandbox: "read-only" as const, scope, grant: { subjectSessionId: id, capabilities: ["thread.list" as const], scope }, resident: { name: "strigoi" as const, incarnation: 1 }, createdAt: initial.updatedAt, updatedAt: initial.updatedAt };
    const activation = { ...initial, revision: 1, desired: "enabled" as const, selection: { provider: "codex" as const, model: "model", cwd: "/repo" }, activeBinding, incarnation: 1, activeGeneration: 1 };
    await s.compareAndSwap(0, "suspend", { ...initial, revision: 1, desired: "suspended" });
    await expect(s.compareAndSwap(0, "activation", activation)).rejects.toMatchObject({ code: "STRIGOI_REVISION_CONFLICT" });
    expect((await new StrigoiStore(d).read()).desired).toBe("suspended");
  });
  it("commits binding and succession evidence together and pins both sessions", async () => {
    const { s } = await store(); const initial = await s.read();
    const scope = { kind: "fleet" as const }, firstId = "11111111-1111-4111-8111-111111111111", nextId = "22222222-2222-4222-8222-222222222222";
    const binding = (sessionId: string, incarnation: number) => ({ key: "resident:strigoi", kind: "resident" as const, sessionId, provider: "codex" as const, model: "model", cwd: "/repo", sandbox: "read-only" as const, scope, grant: { subjectSessionId: sessionId, capabilities: ["thread.list" as const], scope }, resident: { name: "strigoi" as const, incarnation }, createdAt: initial.updatedAt, updatedAt: initial.updatedAt });
    const first = { ...initial, revision: 1, desired: "enabled" as const, selection: { provider: "codex" as const, model: "model", cwd: "/repo" }, activeBinding: binding(firstId, 1), incarnation: 1, activeGeneration: 1 };
    await s.compareAndSwap(0, "first", first);
    const packet = { artifactId: "packet", sha256: "a".repeat(64), coverageId: "coverage" };
    const next = { ...first, revision: 2, activeBinding: binding(nextId, 2), incarnation: 2, activeGeneration: 2, latestPacket: packet, transition: { id: "transition", expectedIncarnation: 1, reason: "renew", phase: "committed" as const, predecessor: { sessionId: firstId, incarnation: 1, generation: 1 }, successor: { sessionId: nextId, incarnation: 2, generation: 2 }, packet, attempts: 0 } };
    await expect(s.compareAndSwap(1, "incomplete", { ...next, latestPacket: undefined })).rejects.toThrow("Incomplete resident cutover");
    await s.compareAndSwap(1, "cutover", next);
    const record = JSON.parse((await readFile(s.path, "utf8")).trim().split("\n")[1]!);
    expect(record.state).toMatchObject({ activeBinding: { sessionId: nextId }, transition: { id: "transition", successor: { generation: 2 }, packet: { sha256: packet.sha256 } } });
    await s.compareAndSwap(2, "complete", { ...next, revision: 3, transition: undefined });
    expect((await s.read()).activeGeneration).toBe(2);
    await expect(s.compareAndSwap(3, "lose-generation", { ...next, revision: 4, transition: undefined, activeGeneration: undefined })).rejects.toThrow();
    expect(await s.retentionPins()).toEqual(new Set([firstId, nextId]));
  });
  it("holds on a corrupt interior record", async () => {
    const { s } = await store(); const initial = await s.read();
    await s.compareAndSwap(0, "one", { ...initial, revision: 1 });
    await appendFile(s.path, "invalid\n{}\n");
    await expect(s.read()).rejects.toMatchObject({ code: "STRIGOI_CORRUPT_STATE" });
  });

  it("does not acknowledge a replay until the journal is synced after failed fsync", async () => {
    const { d, s } = await store(); const initial = await s.read(), next = { ...initial, revision: 1 };
    const original = privateFiles.openPrivateAppendFile;
    const spy = vi.spyOn(privateFiles, "openPrivateAppendFile").mockImplementationOnce(async (path) => {
      const handle = await original(path); vi.spyOn(handle, "sync").mockRejectedValueOnce(new Error("injected fsync")); return handle;
    });
    await expect(s.compareAndSwap(0, "retry", next)).rejects.toMatchObject({ code: "STRIGOI_IO_ERROR" }); spy.mockRestore();
    const atomic = await import("../../src/persistence/atomic-private-file.js");
    const sync = vi.spyOn(atomic, "syncPrivateFile").mockRejectedValueOnce(new Error("replay sync failed"));
    await expect(new StrigoiStore(d).compareAndSwap(0, "retry", next)).rejects.toMatchObject({ code: "STRIGOI_IO_ERROR" });
    sync.mockRestore();
    expect(await new StrigoiStore(d).compareAndSwap(0, "retry", next)).toEqual(next);
  });
  it("serializes symlink aliases while an append is in flight", async () => {
    const { d, s } = await store(); const alias = `${d}-alias`; dirs.push(alias); await symlink(d, alias);
    const initial = await s.read(), next = { ...initial, revision: 1 };
    let entered!: () => void, release!: () => void;
    const inside = new Promise<void>((r) => { entered = r; }), gate = new Promise<void>((r) => { release = r; });
    const original = privateFiles.openPrivateAppendFile;
    const spy = vi.spyOn(privateFiles, "openPrivateAppendFile").mockImplementationOnce(async (path) => {
      const handle = await original(path), sync = handle.sync.bind(handle);
      vi.spyOn(handle, "sync").mockImplementationOnce(async () => { entered(); await gate; return sync(); }); return handle;
    });
    const first = s.compareAndSwap(0, "first", next); await inside;
    let finished = false;
    const second = new StrigoiStore(alias).compareAndSwap(0, "second", next).then(() => ({ code: "SUCCESS" }), (error: { code: string }) => error).finally(() => { finished = true; });
    await new Promise((r) => setTimeout(r, 50));
    const prematurelyFinished = finished; release(); await first;
    expect(await second).toMatchObject({ code: "STRIGOI_REVISION_CONFLICT" }); spy.mockRestore();
    expect(prematurelyFinished).toBe(false);
  });

});
