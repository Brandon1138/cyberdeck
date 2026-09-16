import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, stat, symlink, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acquireResourceOwnerLock } from "../../src/runtime/resources/resource-owner-lock.js";
import { ResourceReservationStore } from "../../src/persistence/resource-reservation-store.js";

describe.skipIf(process.platform !== "darwin")("kernel resource owner lock", () => {
  let directory: string, executable: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "resource-owner-lock-test-")); executable = join(directory, "owner-lock");
    await promisify(execFile)("/usr/bin/xcrun", ["clang", "-Wall", "-Wextra", "-Werror",
      resolve("infra/resources/resource-owner-lock.c"), "-o", executable]);
  });
  afterAll(async () => { await rm(directory, { recursive: true, force: true }); });
  it("excludes concurrent owners and preserves its inode across normal release", async () => {
    const path = join(directory, "lock");
    const first = await acquireResourceOwnerLock(executable, path), inode = (await stat(path)).ino;
    try {
      first.assertHeld(); await expect(acquireResourceOwnerLock(executable, path)).rejects.toThrow("OWNER_UNAVAILABLE");
    } finally { await first.release(); }
    expect(() => first.assertHeld()).toThrow("OWNER_LOST");
    const second = await acquireResourceOwnerLock(executable, path);
    expect((await stat(path)).ino).toBe(inode); await second.release();
  });
  it("kernel releases a killed owner without deleting the lock file", async () => {
    const path = join(directory, "crash-lock");
    const child = spawn(executable, [path], { stdio: "pipe" });
    expect(String((await once(child.stdout, "data"))[0])).toBe("cyberdeck-resource-owner-v1\n");
    const inode = (await stat(path)).ino;
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    const next = await acquireResourceOwnerLock(executable, path);
    expect((await stat(path)).ino).toBe(inode); await next.release();
  });
  it("rejects symlinks and legacy owner metadata without touching either", async () => {
    const target = join(directory, "foreign"), path = join(directory, "link");
    await writeFile(target, "legacy owner evidence"); await symlink(target, path);
    await expect(acquireResourceOwnerLock(executable, path)).rejects.toThrow("OWNER_UNAVAILABLE");
    await expect(acquireResourceOwnerLock(executable, target)).rejects.toThrow("OWNER_UNAVAILABLE");
    expect(await readFile(target, "utf8")).toBe("legacy owner evidence");
  });
  it("shares the persistent owner lock with the durable ledger and refuses mixed protocols", async () => {
    const path = join(directory, "ledger");
    const options = { acquireOwner: (lockPath: string) => acquireResourceOwnerLock(executable, lockPath) };
    const store = await ResourceReservationStore.open(path, "test", options);
    const next = store.read(); next.revision++; await store.save(next, 0);
    await expect(ResourceReservationStore.open(path, "test", options)).rejects.toThrow("OWNER_UNAVAILABLE");
    await expect(ResourceReservationStore.open(path, "test")).rejects.toThrow("OWNER_MODE_CONFLICT");
    await store.close();
    const restored = await ResourceReservationStore.open(path, "test", options);
    expect(restored.read()).toEqual(next); await restored.close();
  });
});
