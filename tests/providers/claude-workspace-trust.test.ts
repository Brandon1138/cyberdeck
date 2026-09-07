import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ClaudeTrustConfigError,
  ClaudeWorkspaceTrust,
} from "../../src/providers/claude/workspace-trust.js";

describe("ClaudeWorkspaceTrust", () => {
  it("sets only hasTrustDialogAccepted for the exact canonical cwd, preserving everything else", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyberdeck-claude-trust-"));
    const settingsPath = join(root, ".claude.json");
    await writeFile(settingsPath, JSON.stringify({
      numStartups: 42,
      theme: "dark",
      projects: {
        "/existing": { hasTrustDialogAccepted: true, allowedTools: ["Bash"], history: [1, 2] },
      },
    }));
    const trust = new ClaudeWorkspaceTrust({
      settingsPath,
      canonicalize: async (path) => `/canonical${path}`,
    });

    await Promise.all([trust.trust("/repo/one"), trust.trust("/repo/two"), trust.trust("/repo/one")]);

    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({
      numStartups: 42,
      theme: "dark",
      projects: {
        "/existing": { hasTrustDialogAccepted: true, allowedTools: ["Bash"], history: [1, 2] },
        "/canonical/repo/one": { hasTrustDialogAccepted: true },
        "/canonical/repo/two": { hasTrustDialogAccepted: true },
      },
    });
  });

  it("keeps a project entry's other keys when trusting a known project", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyberdeck-claude-trust-keys-"));
    const settingsPath = join(root, ".claude.json");
    await writeFile(settingsPath, JSON.stringify({
      projects: { "/repo": { allowedTools: ["Bash"], hasTrustDialogAccepted: false } },
    }));
    const trust = new ClaudeWorkspaceTrust({ settingsPath, canonicalize: async (path) => path });

    await trust.trust("/repo");

    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({
      projects: { "/repo": { allowedTools: ["Bash"], hasTrustDialogAccepted: true } },
    });
  });

  it("creates the settings file when none exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyberdeck-claude-trust-fresh-"));
    const settingsPath = join(root, ".claude.json");
    const trust = new ClaudeWorkspaceTrust({ settingsPath, canonicalize: async (path) => path });

    await trust.trust("/repo");

    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({
      projects: { "/repo": { hasTrustDialogAccepted: true } },
    });
  });

  it("fails closed on malformed provider settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyberdeck-claude-trust-invalid-"));
    const settingsPath = join(root, ".claude.json");
    await writeFile(settingsPath, "{not-json");
    const trust = new ClaudeWorkspaceTrust({ settingsPath, canonicalize: async (path) => path });

    await expect(trust.trust("/repo")).rejects.toBeInstanceOf(ClaudeTrustConfigError);
    expect(await readFile(settingsPath, "utf8")).toBe("{not-json");
  });
});
