import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ScoutEgressGrantStore } from "../../src/persistence/scout-egress-grant-store.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })));
});

async function harness() {
  const state = await mkdtemp(join(tmpdir(), "cyberdeck-scout-egress-"));
  directories.push(state);
  const options = {
    canonicalize: async (path: string) => path,
    now: () => "2026-07-29T10:00:00.000Z",
    idFactory: () => "11111111-1111-4111-8111-111111111111",
  };
  return { state, options, store: new ScoutEgressGrantStore(state, options) };
}

describe("ScoutEgressGrantStore", () => {
  it("persists an operator-owned exact-root grant across store instances", async () => {
    const { state, options, store } = await harness();
    await expect(store.set("/repo/one", true)).resolves.toMatchObject({
      root: "/repo/one",
      provider: "cursor",
      profile: "scout",
      access: "read-only",
      authority: "operator",
    });

    const restarted = new ScoutEgressGrantStore(state, options);
    await expect(restarted.allows("/repo/one")).resolves.toBe(true);
    await expect(restarted.allows("/repo/one/packages/app")).resolves.toBe(false);
    await expect(restarted.status("/repo/one")).resolves.toMatchObject({
      root: "/repo/one",
      enabled: true,
    });
  });

  it("revokes by append-only event without erasing grant history", async () => {
    const { store } = await harness();
    await store.set("/repo/one", true);
    await store.set("/repo/one", false);

    await expect(store.allows("/repo/one")).resolves.toBe(false);
    const ledger = await readFile(store.path, "utf8");
    expect(ledger).toContain("scout-egress.granted");
    expect(ledger).toContain("scout-egress.revoked");
  });

  it("serializes concurrent grant and revocation decisions", async () => {
    const { store } = await harness();
    await Promise.all([
      store.set("/repo/one", true),
      store.set("/repo/two", true),
    ]);
    expect((await store.list()).map(({ root }) => root)).toEqual([
      "/repo/one",
      "/repo/two",
    ]);
  });
});
