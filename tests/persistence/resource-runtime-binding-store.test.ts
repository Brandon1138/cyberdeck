import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ResourceReservationStore } from "../../src/persistence/resource-reservation-store.js";
import { ResourceRuntimeBindingStore } from "../../src/persistence/resource-runtime-binding-store.js";
import type { ResourceRuntimeBinding } from "../../src/domain/resource-runtime.js";

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), "runtime-bindings-test-")); directories.push(path);
  const owner = await ResourceReservationStore.open(path, "test");
  const store = await ResourceRuntimeBindingStore.open(path, () => owner.assertOwner());
  return { path, owner, store };
}
const binding: ResourceRuntimeBinding = { request: { requestId: "request", owner: { installationId: "test", workloadId: "worker",
  generation: 1, kind: "worker" }, demand: { memoryBytes: 1024, cpuWeight: 100, pidLimit: 10,
  profileId: "test", profileVersion: "1" }, priority: "interactive" }, phase: "launching", identities: [] };
describe("durable runtime bindings", () => {
  it("persists exact birth identities privately and cannot write after owner release", async () => {
    const f = await fixture();
    await f.store.put({ ...binding, phase: "bound", identities: [{ kind: "native", pid: 42, startTime: "libproc:123.000001" }] });
    expect((await stat(join(f.path, "resource-runtimes.json"))).mode & 0o777).toBe(0o600);
    await f.owner.close();
    await expect(f.store.put(binding)).rejects.toThrow("STORE_UNAVAILABLE");
    const owner = await ResourceReservationStore.open(f.path, "test");
    const restored = await ResourceRuntimeBindingStore.open(f.path, () => owner.assertOwner());
    expect(restored.get("request")?.identities[0]).toEqual({ kind: "native", pid: 42, startTime: "libproc:123.000001" });
    await owner.close();
  });
  it("rejects coarse PID timestamps and preserves corrupt state for recovery", async () => {
    const f = await fixture();
    expect(() => f.store.put({ ...binding, identities: [{ kind: "native", pid: 42, startTime: "Wed Sep 16 12:00:00" }] })).toThrow();
    await f.owner.close();
    await writeFile(join(f.path, "resource-runtimes.json"), "{torn");
    const owner = await ResourceReservationStore.open(f.path, "test");
    await expect(ResourceRuntimeBindingStore.open(f.path, () => owner.assertOwner())).rejects.toThrow();
    expect(await readFile(join(f.path, "resource-runtimes.json"), "utf8")).toBe("{torn");
    await owner.close();
  });
});
