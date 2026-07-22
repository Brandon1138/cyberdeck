import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkerPreferenceStore } from "../../src/persistence/worker-preference-store.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("WorkerPreferenceStore", () => {
  it("defaults off and persists the latest box preference across store instances", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cyberdeck-worker-preferences-"));
    directories.push(directory);

    await expect(new WorkerPreferenceStore(directory).get()).resolves.toEqual({ caveman: false });
    await new WorkerPreferenceStore(directory).set({ caveman: true });
    await expect(new WorkerPreferenceStore(directory).get()).resolves.toEqual({ caveman: true });
    await new WorkerPreferenceStore(directory).set({ caveman: false });
    await expect(new WorkerPreferenceStore(directory).get()).resolves.toEqual({ caveman: false });
  });
});
