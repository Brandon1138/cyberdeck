import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ResourceReservationStore } from "../../src/persistence/resource-reservation-store.js";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function directory() { const path = await mkdtemp(join(tmpdir(), "resource-store-test-")); directories.push(path); return path; }
describe("resource ledger persistence", () => {
  it("holds one owner, commits privately, compares revisions and restores exact state", async () => {
    const path = await directory(), store = await ResourceReservationStore.open(path, "test");
    await expect(ResourceReservationStore.open(path, "test")).rejects.toMatchObject({ code: "EEXIST" });
    const next = store.read(); next.revision = 1; next.nextSequence = 4; next.lastFamily = "family";
    await store.save(next, 0);
    await expect(store.save(next, 0)).rejects.toThrow("CONFLICT");
    expect((await stat(join(path, "resource-ledger.json"))).mode & 0o777).toBe(0o600);
    await store.close();
    const reopened = await ResourceReservationStore.open(path, "test");
    expect(reopened.read()).toEqual(next); await reopened.close();
  });
  it("fails closed on malformed state and preserves it", async () => {
    const path = await directory(); await writeFile(join(path, "resource-ledger.json"), "{torn");
    await expect(ResourceReservationStore.open(path, "test")).rejects.toThrow();
    expect(await readFile(join(path, "resource-ledger.json"), "utf8")).toBe("{torn");
  });
});
