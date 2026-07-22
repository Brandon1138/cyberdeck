import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FleetPreferenceStore } from "../../src/persistence/fleet-preference-store.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("FleetPreferenceStore", () => {
  it("keeps the latest explicit model and effort for each project", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cyberdeck-fleet-preferences-"));
    directories.push(directory);
    const store = new FleetPreferenceStore(directory);

    await store.set("/repo/one", { provider: "codex", model: "gpt-5.6-luna", effort: "low" });
    await store.set("/repo/two", { provider: "claude", model: "opus", effort: "high" });
    await store.set("/repo/one", { provider: "codex", model: "gpt-5.6-sol", effort: "high" });

    await expect(store.list()).resolves.toEqual({
      "/repo/one": { provider: "codex", model: "gpt-5.6-sol", effort: "high" },
      "/repo/two": { provider: "claude", model: "opus", effort: "high" },
    });
  });
});
