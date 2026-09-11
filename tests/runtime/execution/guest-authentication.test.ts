import { mkdtemp, readFile, rm, stat, writeFile, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

const modulePath = "../../../infra/worker/auth.mjs";
const { applyAuthentication } = await import(modulePath);
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it("clears billing environment and stages access-only Codex auth privately", async () => {
  const home = await mkdtemp(join(tmpdir(), "guest-auth-")); roots.push(home);
  const env: Record<string, string> = { OPENAI_API_KEY: "old", ANTHROPIC_API_KEY: "old", CODEX_ACCESS_TOKEN: "old" };
  const auth = { auth_mode: "chatgptAuthTokens", OPENAI_API_KEY: null, tokens: { refresh_token: "", access_token: "fixture" } };
  await applyAuthentication({ provider: "codex", kind: "codex-subscription", auth }, "codex", env, home);
  expect(env).toEqual({ CODEX_HOME: join(home, ".codex") });
  expect(JSON.parse(await readFile(join(home, ".codex/auth.json"), "utf8"))).toEqual(auth);
  expect((await stat(join(home, ".codex/auth.json"))).mode & 0o777).toBe(0o600);
  await expect(applyAuthentication({ provider: "codex", kind: "codex-subscription", auth: { ...auth, tokens: { refresh_token: "host-refresh" } } }, "codex", env, home))
    .rejects.toThrow("PROVIDER_CREDENTIAL_INVALID");
});
it("uses only subscription OAuth for Claude and rejects expired snapshots", async () => {
  const home = await mkdtemp(join(tmpdir(), "guest-auth-")); roots.push(home);
  await writeFile(join(home, ".claude.json"), JSON.stringify({ projects: { "/workspace": { hasTrustDialogAccepted: false } } }));
  const env = { ANTHROPIC_API_KEY: "old" };
  await applyAuthentication({ provider: "claude", kind: "claude-subscription", oauthToken: "fixture" }, "claude", env, home);
  expect(env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "fixture" });
  expect(JSON.parse(await readFile(join(home, ".claude.json"), "utf8"))).toEqual({ hasCompletedOnboarding: true, projects: { "/workspace": { hasTrustDialogAccepted: false } } });
  await expect(applyAuthentication({ provider: "claude", kind: "claude-subscription", oauthToken: "fixture", expiresAt: 1 }, "claude", env)).rejects.toThrow("CONTAINER_SUBSCRIPTION_LOGIN_EXPIRED");
});
it("refuses a guest auth symlink without overwriting its target", async () => {
  const home = await mkdtemp(join(tmpdir(), "guest-auth-")); roots.push(home);
  await mkdir(join(home, ".codex")); await writeFile(join(home, "target"), "preserve");
  await symlink(join(home, "target"), join(home, ".codex/auth.json"));
  await expect(applyAuthentication({ provider: "codex", kind: "codex-subscription", auth: {
    auth_mode: "chatgptAuthTokens", OPENAI_API_KEY: null, tokens: { refresh_token: "" },
  } }, "codex", {}, home)).rejects.toThrow();
  expect(await readFile(join(home, "target"), "utf8")).toBe("preserve");
});
