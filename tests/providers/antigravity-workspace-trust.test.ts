import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AntigravityTrustConfigError,
  AntigravityWorkspaceTrust,
} from "../../src/providers/antigravity/workspace-trust.js";

describe("AntigravityWorkspaceTrust", () => {
  it("preserves provider settings and appends only exact canonical workspaces", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyberdeck-agy-trust-"));
    const settingsPath = join(root, "settings.json");
    await writeFile(settingsPath, JSON.stringify({
      colorScheme: "tokyo night",
      enableTelemetry: false,
      trustedWorkspaces: ["/existing"],
    }));
    const trust = new AntigravityWorkspaceTrust({
      settingsPath,
      canonicalize: async (path) => `/canonical${path}`,
    });

    await Promise.all([trust.trust("/repo/one"), trust.trust("/repo/two"), trust.trust("/repo/one")]);

    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({
      colorScheme: "tokyo night",
      enableTelemetry: false,
      trustedWorkspaces: ["/existing", "/canonical/repo/one", "/canonical/repo/two"],
    });
  });

  it("fails closed on malformed provider settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyberdeck-agy-trust-invalid-"));
    const settingsPath = join(root, "settings.json");
    await writeFile(settingsPath, "{not-json");
    const trust = new AntigravityWorkspaceTrust({
      settingsPath,
      canonicalize: async (path) => path,
    });

    await expect(trust.trust("/repo/one")).rejects.toBeInstanceOf(AntigravityTrustConfigError);
  });
});
