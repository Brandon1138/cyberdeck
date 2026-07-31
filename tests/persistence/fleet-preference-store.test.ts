import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

  it("keeps the latest fold for each folder key, including the Orcs roster sentinel", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cyberdeck-fleet-preferences-"));
    directories.push(directory);
    const store = new FleetPreferenceStore(directory);

    await store.setFolderDisposition("/repo/one", { collapsed: true, expanded: false });
    await store.setFolderDisposition("/@orcs", { collapsed: true, expanded: false });
    await store.setFolderDisposition("/repo/one", { collapsed: false, expanded: true });

    await expect(store.listFolderDispositions()).resolves.toEqual({
      "/repo/one": { collapsed: false, expanded: true },
      "/@orcs": { collapsed: true, expanded: false },
    });
  });

  it("reads folds and launch profiles out of the same file without either shadowing the other", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cyberdeck-fleet-preferences-"));
    directories.push(directory);
    const store = new FleetPreferenceStore(directory);

    await store.set("/repo/one", { provider: "codex", model: "gpt-5.6-luna" });
    await store.setFolderDisposition("/repo/one", { collapsed: true, expanded: false });

    await expect(store.list()).resolves.toEqual({
      "/repo/one": { provider: "codex", model: "gpt-5.6-luna" },
    });
    await expect(store.listFolderDispositions()).resolves.toEqual({
      "/repo/one": { collapsed: true, expanded: false },
    });
  });

  it("defaults automatic nvim layout on and keeps its latest explicit opt-out", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cyberdeck-fleet-preferences-"));
    directories.push(directory);
    const store = new FleetPreferenceStore(directory);

    await expect(store.nvimLayoutEnabled()).resolves.toBe(true);
    await store.setNvimLayout(true);
    await store.set("/repo/one", { provider: "codex", model: "gpt-5.6-sol" });
    await store.setNvimLayout(false);

    await expect(store.nvimLayoutEnabled()).resolves.toBe(false);
    await expect(store.list()).resolves.toEqual({
      "/repo/one": { provider: "codex", model: "gpt-5.6-sol" },
    });
  });

  it("reads a file written before folds existed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cyberdeck-fleet-preferences-"));
    directories.push(directory);
    const store = new FleetPreferenceStore(directory);
    await mkdir(join(directory, "ui"), { recursive: true });
    await writeFile(
      store.path,
      `${
        JSON.stringify({
          recordType: "fleet.launch-profile",
          eventId: "11111111-1111-4111-8111-111111111111",
          persistedAt: "2026-01-01T00:00:00.000Z",
          cwd: "/repo/legacy",
          profile: { provider: "claude", model: "sonnet" },
        })
      }\n`,
      "utf8",
    );

    await expect(store.list()).resolves.toEqual({
      "/repo/legacy": { provider: "claude", model: "sonnet" },
    });
    await expect(store.listFolderDispositions()).resolves.toEqual({});
    await expect(store.nvimLayoutEnabled()).resolves.toBe(true);
  });

  it("keeps the latest registration for each project root", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cyberdeck-fleet-preferences-"));
    directories.push(directory);
    const store = new FleetPreferenceStore(directory);

    await store.setProject("/code/soma", true);
    await store.setProject("/code/ammo", true);
    await store.setProject("/code/soma", false);
    await store.setProject("/code/soma", true);

    await expect(store.listProjects()).resolves.toEqual(["/code/ammo", "/code/soma"]);
  });

  it("remembers a removed root as an explicit absence rather than forgetting it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cyberdeck-fleet-preferences-"));
    directories.push(directory);
    const store = new FleetPreferenceStore(directory);

    await store.setProject("/code/soma", true);
    await store.setProject("/code/soma", false);

    await expect(store.listProjects()).resolves.toEqual([]);
    // The difference that matters to seeding: removed is not the same as never seen.
    await expect(store.projectDispositions()).resolves.toEqual(new Map([["/code/soma", false]]));
  });

  it("records that the seeding pass has run, separately from what it found", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cyberdeck-fleet-preferences-"));
    directories.push(directory);
    const store = new FleetPreferenceStore(directory);

    await expect(store.projectMigrationCompleted()).resolves.toBe(false);
    await store.completeProjectMigration();

    await expect(store.projectMigrationCompleted()).resolves.toBe(true);
    await expect(store.listProjects()).resolves.toEqual([]);
  });

  it("reads projects out of a file that also holds every other preference kind", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cyberdeck-fleet-preferences-"));
    directories.push(directory);
    const store = new FleetPreferenceStore(directory);

    await store.set("/code/soma", { provider: "codex", model: "gpt-5.6-sol" });
    await store.setProject("/code/soma", true);
    await store.setFolderDisposition("/@orcs", { collapsed: true, expanded: false });
    await store.setNvimLayout(false);
    await store.completeProjectMigration();

    await expect(store.listProjects()).resolves.toEqual(["/code/soma"]);
    await expect(store.nvimLayoutEnabled()).resolves.toBe(false);
    await expect(store.listFolderDispositions()).resolves.toEqual({
      "/@orcs": { collapsed: true, expanded: false },
    });
  });

  it("refuses a file with a malformed line rather than silently dropping preferences", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cyberdeck-fleet-preferences-"));
    directories.push(directory);
    const store = new FleetPreferenceStore(directory);
    await store.setFolderDisposition("/repo/one", { collapsed: true, expanded: false });
    await appendFile(store.path, `${JSON.stringify({ recordType: "fleet.folder-collapse" })}\n`, "utf8");

    await expect(store.listFolderDispositions()).rejects.toThrow("Invalid Fleet preference at line 2");
  });
});
