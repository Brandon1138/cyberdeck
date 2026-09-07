import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CodexWorkspaceTrust } from "../../src/providers/codex/workspace-trust.js";

describe("CodexWorkspaceTrust", () => {
  it("appends a trusted project table without touching any existing line", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyberdeck-codex-trust-"));
    const configPath = join(root, "config.toml");
    const existing = [
      "model = \"gpt-5.2-codex\"",
      "",
      "[projects.\"/existing\"]",
      "trust_level = \"trusted\"",
      "",
    ].join("\n");
    await writeFile(configPath, existing);
    const trust = new CodexWorkspaceTrust({
      configPath,
      canonicalize: async (path) => `/canonical${path}`,
    });

    await Promise.all([trust.trust("/repo/one"), trust.trust("/repo/two"), trust.trust("/repo/one")]);

    const written = await readFile(configPath, "utf8");
    expect(written.startsWith(existing)).toBe(true);
    expect(written).toContain("[projects.\"/canonical/repo/one\"]\ntrust_level = \"trusted\"");
    expect(written).toContain("[projects.\"/canonical/repo/two\"]\ntrust_level = \"trusted\"");
    expect(written.match(/\/canonical\/repo\/one/gu)).toHaveLength(1);
  });

  it("never overrides an operator's existing entry, whatever its trust level", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyberdeck-codex-trust-existing-"));
    const configPath = join(root, "config.toml");
    const existing = "[projects.\"/repo\"]\ntrust_level = \"untrusted\"\n";
    await writeFile(configPath, existing);
    const trust = new CodexWorkspaceTrust({ configPath, canonicalize: async (path) => path });

    await trust.trust("/repo");

    expect(await readFile(configPath, "utf8")).toBe(existing);
  });

  it("recognizes the literal-string header spelling too", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyberdeck-codex-trust-literal-"));
    const configPath = join(root, "config.toml");
    const existing = "[projects.'/repo']\ntrust_level = \"trusted\"\n";
    await writeFile(configPath, existing);
    const trust = new CodexWorkspaceTrust({ configPath, canonicalize: async (path) => path });

    await trust.trust("/repo");

    expect(await readFile(configPath, "utf8")).toBe(existing);
  });

  it("creates the config when none exists and separates appended tables from a partial last line", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyberdeck-codex-trust-fresh-"));
    const configPath = join(root, "config.toml");
    const trust = new CodexWorkspaceTrust({ configPath, canonicalize: async (path) => path });

    await trust.trust("/repo");
    expect(await readFile(configPath, "utf8")).toContain("[projects.\"/repo\"]\ntrust_level = \"trusted\"");

    await writeFile(configPath, "model = \"gpt-5.2-codex\""); // no trailing newline
    await trust.trust("/other");
    const written = await readFile(configPath, "utf8");
    expect(written).toContain("model = \"gpt-5.2-codex\"\n");
    expect(written).toContain("[projects.\"/other\"]\ntrust_level = \"trusted\"");
  });

  it("escapes quotes and backslashes into valid TOML basic strings", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyberdeck-codex-trust-escape-"));
    const configPath = join(root, "config.toml");
    const trust = new CodexWorkspaceTrust({ configPath, canonicalize: async (path) => path });

    await trust.trust("/repo/with\"quote");

    expect(await readFile(configPath, "utf8")).toContain("[projects.\"/repo/with\\\"quote\"]");
  });
});
