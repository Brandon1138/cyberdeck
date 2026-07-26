import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ProviderPermissionPreferenceStore,
} from "../../src/persistence/provider-permission-preference-store.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })),
  );
});

describe("ProviderPermissionPreferenceStore", () => {
  it("persists latest provider-specific policy across store instances", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cyberdeck-provider-permissions-"));
    directories.push(directory);
    const store = new ProviderPermissionPreferenceStore(directory);

    await expect(store.list()).resolves.toEqual({});
    await store.set("codex", "automatic");
    await store.set("claude", "permissioned");
    await store.set("codex", "permissioned");

    await expect(new ProviderPermissionPreferenceStore(directory).list())
      .resolves.toEqual({
        codex: "permissioned",
        claude: "permissioned",
      });
  });

  it("fails visibly on invalid persisted policy data", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cyberdeck-provider-permissions-"));
    directories.push(directory);
    const store = new ProviderPermissionPreferenceStore(directory);
    await mkdir(dirname(store.path), { recursive: true });
    await appendFile(
      store.path,
      `${JSON.stringify({
        recordType: "provider.permission-policy",
        eventId: "11111111-1111-4111-8111-111111111111",
        persistedAt: "2026-07-25T12:00:00.000Z",
        provider: "codex",
        policy: "silently-dangerous",
      })}\n`,
      "utf8",
    );

    await expect(store.list()).rejects.toThrow(
      "Invalid provider permission preference at line 1",
    );
  });
});
