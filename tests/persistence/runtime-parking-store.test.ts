import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ParkingRecord } from "../../src/orchestration/runtime-parking-service.js";

const fault = vi.hoisted(() => ({ rename: "none" as "none" | "before" | "after" }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: async (...args: Parameters<typeof actual.rename>) => {
    if (fault.rename === "before") throw Object.assign(new Error("injected-pre-rename-crash"), { code: "EIO" });
    await actual.rename(...args);
    if (fault.rename === "after") throw Object.assign(new Error("injected-post-rename-crash"), { code: "EIO" });
  } };
});
import { RuntimeParkingStore } from "../../src/persistence/runtime-parking-store.js";

const directories: string[] = [];
afterEach(async () => { fault.rename = "none"; for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
const record = (sessionId = "session-1"): ParkingRecord => ({ sessionId,
  identity: { generation: 1, executionId: "execution-1", workspaceId: "/private/workspace", conversationId: "conversation-1", authorityEpoch: "lease-1" },
  phase: "parking", wakeAttempts: 0, reason: null });
async function fixture(options: Parameters<typeof RuntimeParkingStore.open>[2] = {}) {
  const directory = await mkdtemp(join(tmpdir(), "parking-store-test-")); directories.push(directory);
  let held = true;
  const assertOwner = () => { if (!held) throw new Error("owner-lost"); };
  const store = await RuntimeParkingStore.open(directory, assertOwner, options);
  return { directory, path: join(directory, "runtime-parking.json"), assertOwner, store, loseOwner: () => { held = false; } };
}
const checksum = (body: unknown) => createHash("sha256").update(JSON.stringify(body)).digest("hex");

describe("durable runtime parking store", () => {
  it("reopens exact intent privately, makes duplicate writes idempotent, and returns detached copies", async () => {
    const f = await fixture(); await f.store.put(record());
    const bytes = await readFile(f.path, "utf8"); await f.store.put(record());
    expect(await readFile(f.path, "utf8")).toBe(bytes);
    expect((await stat(f.directory)).mode & 0o777).toBe(0o700);
    expect((await stat(f.path)).mode & 0o777).toBe(0o600);
    const reopened = await RuntimeParkingStore.open(f.directory, f.assertOwner);
    expect(reopened.list()).toEqual([record()]);
    const copy = reopened.get("session-1")!; copy.identity.generation = 99;
    expect(reopened.get("session-1")?.identity.generation).toBe(1);
    f.loseOwner(); expect(() => reopened.get("session-1")).toThrow("owner-lost");
    await expect(reopened.put(record())).rejects.toThrow("owner-lost");
  });
  it("serializes concurrent durable records and never regresses or changes an existing runtime identity", async () => {
    const f = await fixture(); await Promise.all([f.store.put(record("one")), f.store.put(record("two"))]);
    expect(f.store.list().map(entry => entry.sessionId)).toEqual(["one", "two"]);
    const next = record("one"); next.identity.generation = 2; next.phase = "active";
    await f.store.put(next);
    await expect(f.store.put(record("one"))).rejects.toThrow("GENERATION_REGRESSION");
    await expect(f.store.put({ ...next, identity: { ...next.identity, conversationId: "different" } })).rejects.toThrow("IDENTITY_CONFLICT");
    const reopened = await RuntimeParkingStore.open(f.directory, f.assertOwner);
    expect(reopened.get("one")).toEqual(next); expect(reopened.get("two")).toEqual(record("two"));
  });
  it("refuses stale facades or corrupted durable state instead of overwriting their evidence", async () => {
    const f = await fixture(); await f.store.put(record());
    const second = await RuntimeParkingStore.open(f.directory, f.assertOwner);
    await f.store.put({ ...record(), phase: "parked" });
    await expect(second.put(record("another"))).rejects.toThrow("SNAPSHOT_CHANGED");
    expect(() => second.list()).toThrow("STORE_UNAVAILABLE");
    const reopened = await RuntimeParkingStore.open(f.directory, f.assertOwner);
    expect(reopened.get("session-1")?.phase).toBe("parked");
    await writeFile(f.path, "{corruption");
    await expect(reopened.put(record("another"))).rejects.toThrow();
    expect(await readFile(f.path, "utf8")).toBe("{corruption");
    expect(() => reopened.list()).toThrow("STORE_UNAVAILABLE");
  });
  it.each(["before", "after"] as const)("fails closed around %s rename and reopens the sole committed snapshot", async point => {
    const f = await fixture(); await f.store.put(record());
    const next = { ...record(), phase: "parked" as const };
    fault.rename = point;
    await expect(f.store.put(next)).rejects.toThrow("injected");
    expect(() => f.store.get("session-1")).toThrow("STORE_UNAVAILABLE");
    await expect(f.store.put(record("two"))).rejects.toThrow("STORE_UNAVAILABLE");
    fault.rename = "none";
    const reopened = await RuntimeParkingStore.open(f.directory, f.assertOwner);
    expect(reopened.get("session-1")).toEqual(point === "before" ? record() : next);
    expect((await readdir(f.directory)).filter(path => path.endsWith(".pending"))).toEqual([]);
  });
  it("preserves but never promotes an orphan transaction, including a torn first write", async () => {
    const f = await fixture();
    const pending = join(f.directory, "runtime-parking-write-12345678-1234-1234-1234-123456789abc.pending");
    await writeFile(pending, "{torn", { mode: 0o600 });
    const empty = await RuntimeParkingStore.open(f.directory, f.assertOwner);
    expect(empty.list()).toEqual([]); expect(await readFile(pending, "utf8")).toBe("{torn");
    await empty.put(record());
    const reopened = await RuntimeParkingStore.open(f.directory, f.assertOwner);
    expect(reopened.list()).toEqual([record()]); expect(await readFile(pending, "utf8")).toBe("{torn");
  });
  it.each([
    { phase: "not-a-phase" }, { phase: "waking", wakeAttempts: 0 }, { phase: "intervention", reason: null },
    { wakeAttempts: 4 }, { unexpected: true }, { identity: { ...record().identity, generation: 0 } },
  ])("refuses invalid input state without damaging prior evidence: %j", async invalid => {
    const f = await fixture(); await f.store.put(record());
    await expect(f.store.put({ ...record(), ...invalid } as ParkingRecord)).rejects.toThrow("RECORD_INVALID");
    expect(f.store.list()).toEqual([record()]);
  });
  it("preserves corrupt snapshots and rejects checksum changes, duplicate IDs and unknown versions", async () => {
    const f = await fixture(); await f.store.put(record());
    const original = JSON.parse(await readFile(f.path, "utf8"));
    const changed = structuredClone(original); changed.body.records[0].identity.authorityEpoch = "another-lease";
    const duplicate = structuredClone(original); duplicate.body.records.push(record()); duplicate.sha256 = checksum(duplicate.body);
    const future = structuredClone(original); future.body.schemaVersion = 2; future.sha256 = checksum(future.body);
    for (const bytes of ["{torn", JSON.stringify(changed), JSON.stringify(duplicate), JSON.stringify(future)]) {
      await writeFile(f.path, bytes);
      await expect(RuntimeParkingStore.open(f.directory, f.assertOwner)).rejects.toThrow();
      expect(await readFile(f.path, "utf8")).toBe(bytes);
    }
  });
  it("pins unresolved records at capacity and retires only an explicitly retired active generation", async () => {
    const f = await fixture({ maxRecords: 1, isRetired: () => true }); await f.store.put(record());
    await expect(f.store.put(record("other"))).rejects.toThrow("RECORD_CAPACITY");
    for (const phase of ["parking", "parked", "waking", "intervention"] as const) {
      await f.store.put({ ...record(), phase, wakeAttempts: phase === "waking" ? 1 : 0, reason: phase === "intervention" ? "stop-unknown" : null });
      await expect(f.store.retire("session-1", 1)).rejects.toThrow("RETIREMENT_UNPROVEN");
    }
    await f.store.put({ ...record(), phase: "active" });
    await expect(f.store.retire("session-1", 2)).rejects.toThrow("RETIREMENT_UNPROVEN");
    expect(await f.store.retire("session-1", 1)).toBe(true); expect(await f.store.retire("session-1", 1)).toBe(false);
    await f.store.put(record("other"));
    const reopened = await RuntimeParkingStore.open(f.directory, f.assertOwner, { maxRecords: 1 });
    expect(reopened.list()).toEqual([record("other")]);
    const g = await fixture(); await g.store.put({ ...record(), phase: "active" });
    await expect(g.store.retire("session-1", 1)).rejects.toThrow("RETIREMENT_UNPROVEN");
  });
  it("counts crash remnants against disk capacity and preserves the last snapshot when a transaction cannot fit", async () => {
    const f = await fixture({ maxBytes: 65536 }); await f.store.put(record());
    const pending = join(f.directory, "runtime-parking-write-12345678-1234-1234-1234-123456789abc.pending");
    const currentBytes = (await stat(f.path)).size;
    await writeFile(pending, Buffer.alloc(65536 - currentBytes - 10));
    const reopened = await RuntimeParkingStore.open(f.directory, f.assertOwner, { maxBytes: 65536 });
    await expect(reopened.put({ ...record(), phase: "parked" })).rejects.toThrow("DISK_CAPACITY");
    expect(reopened.get("session-1")).toEqual(record()); expect((await stat(pending)).size).toBe(65536 - currentBytes - 10);
  });
  it("refuses symlinks and a replaced or exposed private directory", async () => {
    const f = await fixture(); await f.store.put(record());
    const alias = `${f.directory}-link`; directories.push(alias); await symlink(f.directory, alias);
    await expect(RuntimeParkingStore.open(alias, f.assertOwner)).rejects.toThrow("DIRECTORY_UNSAFE");
    await chmod(f.directory, 0o755); expect(() => f.store.list()).toThrow("DIRECTORY_CHANGED"); await chmod(f.directory, 0o700);
    const moved = `${f.directory}-moved`; directories.push(moved); await rename(f.directory, moved); await symlink(moved, f.directory);
    expect(() => f.store.get("session-1")).toThrow("DIRECTORY_CHANGED");
  });
});
