import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FleetDetachStore } from "../../src/persistence/fleet-detach-store.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("FleetDetachStore", () => {
  it("keeps one explicit latest detach isolated by operator or orchestrator identity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cyberdeck-fleet-detaches-"));
    directories.push(directory);
    const store = new FleetDetachStore(directory);
    const first = "11111111-1111-4111-8111-111111111111";
    const second = "22222222-2222-4222-8222-222222222222";
    const unrelated = "33333333-3333-4333-8333-333333333333";

    await store.record("operator:one", first);
    await store.record("orchestrator:other", unrelated);
    await store.record("operator:one", second);

    await expect(store.latestSessionId("operator:one")).resolves.toBe(second);
    await expect(store.latestSessionId("orchestrator:other")).resolves.toBe(unrelated);
    await expect(store.latestSessionId("operator:missing")).resolves.toBeUndefined();
  });

  it("clears only the observed stale target and survives a newer detach race", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cyberdeck-fleet-detaches-"));
    directories.push(directory);
    const store = new FleetDetachStore(directory);
    const stale = "11111111-1111-4111-8111-111111111111";
    const current = "22222222-2222-4222-8222-222222222222";

    await store.record("operator:one", stale);
    await store.clear("operator:one", stale);
    await expect(store.latestSessionId("operator:one")).resolves.toBeUndefined();

    await store.record("operator:one", stale);
    await store.record("operator:one", current);
    await store.clear("operator:one", stale);
    await expect(store.latestSessionId("operator:one")).resolves.toBe(current);
  });
});
