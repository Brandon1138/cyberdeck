import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexOrchestratorHome } from "../../src/providers/codex/orchestrator-home.js";
import { CodexProviderAdapter } from "../../src/providers/codex.js";
import type { SessionRecord } from "../../src/domain/session.js";
import { parse } from "smol-toml";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const source = await mkdtemp(join(tmpdir(), "cyberdeck-orc-home-"));
  directories.push(source);
  await writeFile(join(source, "auth.json"), '{"test_login":"first"}', { mode: 0o600 });
  await writeFile(join(source, "config.toml"), 'model_provider = "headroom"\n');
  return { source, home: new CodexOrchestratorHome(source) };
}

describe("Codex orchestrator RC ownership", () => {
  it("shares login and conversations while separating configuration, installation, and daemon state", async () => {
    const { source, home } = await fixture();
    await writeFile(join(source, "installation_id"), "desktop-installation");
    await writeFile(join(source, "remote-control.json"), "desktop-enrollment");
    await Promise.all([home.prepare(), home.prepare()]);
    for (const name of ["auth.json", "sessions", "archived_sessions", "thread-writer-locks"]) {
      expect(await realpath(join(home.directory, name))).toBe(await realpath(join(source, name)));
    }
    expect((await stat(home.directory)).mode & 0o777).toBe(0o700);
    for (const name of ["installation_id", "remote-control.json", "app-server-daemon", "state_5.sqlite"]) {
      await expect(stat(join(home.directory, name))).rejects.toMatchObject({ code: "ENOENT" });
    }
    // Native file-backed auth refresh writes through the link, preserving one login source.
    await writeFile(join(home.directory, "auth.json"), '{"test_login":"refreshed"}');
    expect(await readFile(join(source, "auth.json"), "utf8")).toContain("refreshed");
    await writeFile(join(home.directory, "sessions", "new-conversation.jsonl"), "native conversation");
    expect(await readFile(join(source, "sessions", "new-conversation.jsonl"), "utf8"))
      .toBe("native conversation");
    expect(await readFile(join(source, "installation_id"), "utf8")).toBe("desktop-installation");
    expect(parse(await readFile(join(home.directory, "config.toml"), "utf8")).model_provider).toBe("openai");
    expect(parse(await readFile(join(source, "config.toml"), "utf8")).model_provider).toBe("headroom");
  });

  it("migrates the former config and hooks links without changing worker settings or custom hooks", async () => {
    const { source, home } = await fixture();
    const config = `model_provider = "headroom"\nopenai_base_url = "http://localhost:8787/v1"\nmodel = "gpt-6.1-sol"\n[plugins."headroom@headroom-marketplace"]\nenabled = true\n[plugins."other@marketplace"]\nenabled = true\n[mcp_servers.custom]\ncommand = "custom-server"\n`;
    const hooks = JSON.stringify({ hooks: { SessionStart: [{ matcher: "*", hooks: [
      { type: "command", command: "headroom init hook ensure" },
      { type: "command", command: "node caveman-workers-session-start.mjs" },
    ] }] } });
    await writeFile(join(source, "config.toml"), config);
    await writeFile(join(source, "hooks.json"), hooks);
    await mkdir(home.directory);
    await symlink(join(source, "config.toml"), join(home.directory, "config.toml"));
    await symlink(join(source, "hooks.json"), join(home.directory, "hooks.json"));
    await home.prepare();
    expect((await lstat(join(home.directory, "config.toml"))).isSymbolicLink()).toBe(false);
    const managed = parse(await readFile(join(home.directory, "config.toml"), "utf8"));
    expect(managed).toMatchObject({ model_provider: "openai", model: "gpt-6.1-sol",
      plugins: { "headroom@headroom-marketplace": { enabled: false }, "other@marketplace": { enabled: true } },
      mcp_servers: { custom: { command: "custom-server" } } });
    expect(managed.openai_base_url).toBeUndefined();
    expect(JSON.parse(await readFile(join(home.directory, "hooks.json"), "utf8")).hooks.SessionStart[0].hooks)
      .toEqual([{ type: "command", command: "node caveman-workers-session-start.mjs" }]);
    expect(await readFile(join(source, "config.toml"), "utf8")).toBe(config);
    expect(await readFile(join(source, "hooks.json"), "utf8")).toBe(hooks);
  });

  it("refreshes inherited preferences while retaining native trust saved in the dedicated home", async () => {
    const { source, home } = await fixture();
    await home.prepare();
    const config = join(home.directory, "config.toml");
    await writeFile(config, (await readFile(config, "utf8")) + '\n[projects."/dedicated"]\ntrust_level = "trusted"\n[hooks.state."dedicated-hook"]\ntrusted = true\n');
    await writeFile(join(source, "config.toml"), 'model_provider = "headroom"\nmodel = "new-model"\n[projects."/worker"]\ntrust_level = "trusted"\n');
    await home.prepare();
    expect(parse(await readFile(config, "utf8"))).toMatchObject({ model_provider: "openai", model: "new-model",
      projects: { "/dedicated": { trust_level: "trusted" }, "/worker": { trust_level: "trusted" } },
      hooks: { state: { "dedicated-hook": { trusted: true } } } });
  });

  it("refuses independent configuration and hooks files", async () => {
    const { home } = await fixture();
    await mkdir(home.directory);
    await writeFile(join(home.directory, "config.toml"), 'model_provider = "independent"\n');
    await expect(home.prepare()).rejects.toThrow("independent config.toml");
    expect(await readFile(join(home.directory, "config.toml"), "utf8")).toContain("independent");
    await rm(join(home.directory, "config.toml"));
    await writeFile(join(home.directory, "hooks.json"), '{"independent":true}');
    await expect(home.prepare()).rejects.toThrow("independent hooks.json");
    expect(await readFile(join(home.directory, "hooks.json"), "utf8")).toBe('{"independent":true}');
  });

  it("preserves and reports independent files instead of silently replacing a login", async () => {
    const { home } = await fixture();
    await home.prepare();
    const auth = join(home.directory, "auth.json");
    await rm(auth);
    await writeFile(auth, "independent-login");
    await expect(home.prepare()).rejects.toThrow("independent auth.json");
    expect(await readFile(auth, "utf8")).toBe("independent-login");
  });

  it("resumes an existing conversation through the linked home without copying its history", async () => {
    const { source, home } = await fixture();
    await home.prepare();
    const createdAt = "2026-10-05T10:00:00.000Z";
    const nativeId = "019f86e4-16e4-7c61-9ee7-76b8b83b1018";
    const day = join(source, "sessions", "2026", "10", "05");
    await mkdir(day, { recursive: true });
    await writeFile(join(day, `rollout-${nativeId}.jsonl`), JSON.stringify({
      type: "session_meta",
      payload: { id: nativeId, timestamp: createdAt, cwd: "/repo", originator: "codex-tui" },
    }) + "\n");
    const spec = new CodexProviderAdapter({
      sourceEnvironment: { CODEX_HOME: source }, orchestratorHome: home,
    }).buildResumeSpec({
      id: "existing-orchestrator", kind: "orchestrator", provider: "codex", cwd: "/repo",
      sandbox: "workspace-write", approvalMode: "auto", createdAt,
    } as SessionRecord);
    expect(spec.args.at(-1)).toBe(nativeId);
    expect(spec.env.CODEX_HOME).toBe(home.directory);
    expect(await readFile(join(spec.env.CODEX_HOME!, "sessions", "2026", "10", "05", `rollout-${nativeId}.jsonl`), "utf8"))
      .toContain(nativeId);
  });

  it("reports a missing file-backed login without copying credentials or starting a daemon", async () => {
    const { source, home } = await fixture();
    await rm(join(source, "auth.json"));
    await expect(home.prepare()).rejects.toThrow("existing file-backed login");
    await expect(stat(home.directory)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
