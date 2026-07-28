import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensurePrivateDirectory } from "../../src/persistence/private-files.js";
import { CustodyColorStore } from "../../src/persistence/custody-color-store.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function store(): Promise<CustodyColorStore> {
  const directory = await mkdtemp(join(tmpdir(), "cyberdeck-custody-colors-"));
  directories.push(directory);
  return new CustodyColorStore(directory);
}

describe("CustodyColorStore", () => {
  it("reads an empty table before anything is written", async () => {
    await expect((await store()).read()).resolves.toEqual([]);
  });

  it("replays the latest whole table", async () => {
    const colors = await store();

    await colors.write([
      { slot: 0, controllerId: "orchestrator:fleet", assignedAt: "2026-07-28T09:00:00.000Z" },
    ]);
    await colors.write([
      { slot: 0, controllerId: "orchestrator:fleet", assignedAt: "2026-07-28T09:00:00.000Z", releasedAt: "2026-07-28T10:00:00.000Z" },
      { slot: 1, controllerId: "orchestrator:workspace:/repo", assignedAt: "2026-07-28T10:00:00.000Z" },
    ]);

    await expect(colors.read()).resolves.toEqual([
      { slot: 0, controllerId: "orchestrator:fleet", assignedAt: "2026-07-28T09:00:00.000Z", releasedAt: "2026-07-28T10:00:00.000Z" },
      { slot: 1, controllerId: "orchestrator:workspace:/repo", assignedAt: "2026-07-28T10:00:00.000Z" },
    ]);
    const lines = (await readFile(colors.path, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
  });

  it("refuses a table that would hand one slot to two controllers", async () => {
    const colors = await store();

    await expect(colors.write([
      { slot: 0, controllerId: "orchestrator:a", assignedAt: "2026-07-28T09:00:00.000Z" },
      { slot: 0, controllerId: "orchestrator:b", assignedAt: "2026-07-28T09:00:00.000Z" },
    ])).rejects.toThrow();
  });

  it("names the line a corrupt record is on", async () => {
    const colors = await store();
    await colors.write([
      { slot: 0, controllerId: "orchestrator:fleet", assignedAt: "2026-07-28T09:00:00.000Z" },
    ]);
    await writeFile(colors.path, `${(await readFile(colors.path, "utf8"))}{"recordType":"custody.colors"}\n`, "utf8");

    await expect(colors.read()).rejects.toThrow(/line 2/);
  });

  it("keeps the ledger inside the state directory's private tree", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cyberdeck-custody-colors-"));
    directories.push(directory);
    await ensurePrivateDirectory(directory);
    const colors = new CustodyColorStore(directory);

    expect(colors.path).toBe(join(directory, "orchestration", "custody-colors.jsonl"));
    await colors.write([]);
    await expect(colors.read()).resolves.toEqual([]);
  });
});
