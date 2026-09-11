import { mkdtemp, writeFile, readFile, rm, symlink, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { resolveContainerCredential } from "../../../src/runtime/execution/subscription-credentials.js";
import { BrokerRuntimeConfigSchema } from "../../../src/config.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const now = 1_800_000_000_000;
const jwt = (expires = now + 7200000) => `header.${Buffer.from(JSON.stringify({ exp: expires / 1000 })).toString("base64url")}.signature`;
async function source(body: string) {
  const root = await mkdtemp(join(tmpdir(), "subscription-auth-")); roots.push(root);
  const file = join(root, "auth"); await writeFile(file, body, { mode: 0o600 }); return file;
}
it("exports external ChatGPT access tokens without host refresh authority or API billing", async () => {
  const body = JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null,
    tokens: { id_token: jwt(), access_token: jwt(), refresh_token: "NEVER_EXPORT_REFRESH", account_id: "account" }, unrelated: "NEVER_EXPORT" });
  const authFile = await source(body);
  const result = await resolveContainerCredential("codex", { kind: "codex-subscription", authFile }, 60000, { now: () => now });
  expect(result).toMatchObject({ kind: "codex-subscription", auth: { auth_mode: "chatgptAuthTokens", OPENAI_API_KEY: null,
    tokens: { refresh_token: "", account_id: "account" } } });
  expect(JSON.stringify(result)).not.toContain("NEVER_EXPORT");
  expect(await readFile(authFile, "utf8")).toBe(body);
  // A later preparation reads refreshed host state, never a stale worker copy.
  await writeFile(authFile, body.replaceAll(jwt(), jwt(now + 14400000)));
  expect(await resolveContainerCredential("codex", { kind: "codex-subscription", authFile }, 60000, { now: () => now }))
    .toMatchObject({ expiresAt: now + 14400000 });
});
it("rejects expiring and API-authenticated Codex sources without exposing their values", async () => {
  for (const body of [JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "SECRET" }),
    JSON.stringify({ auth_mode: "chatgpt", tokens: { id_token: jwt(), access_token: jwt(now + 30000), account_id: "a" } }), "SECRET-invalid-json"]) {
    const authFile = await source(body);
    const result = resolveContainerCredential("codex", { kind: "codex-subscription", authFile }, 60000, { now: () => now });
    await expect(result).rejects.toThrow(/^CONTAINER_/);
    await expect(result).rejects.not.toThrow("SECRET");
  }
});
it("reads only the named Claude Keychain entry and excludes refresh/account metadata", async () => {
  let selected = "";
  const result = await resolveContainerCredential("claude", { kind: "claude-subscription", keychainService: "selected-service" }, 60000,
    { now: () => now, readKeychain: async (service) => { selected = service; return JSON.stringify({ claudeAiOauth: {
      accessToken: "ACCESS", refreshToken: "NEVER_EXPORT", expiresAt: now + 7200000, subscriptionType: "max", scopes: ["user:inference"],
    } }); } });
  expect(selected).toBe("selected-service");
  expect(result).toEqual({ provider: "claude", kind: "claude-subscription", oauthToken: "ACCESS", expiresAt: now + 7200000 });
});
it("accepts a Claude setup-token file, refuses API keys and mismatched providers", async () => {
  const tokenFile = await source("sk-ant-oat01-subscription-fixture");
  expect(await resolveContainerCredential("claude", { kind: "claude-subscription", tokenFile }, 60000)).toMatchObject({ oauthToken: "sk-ant-oat01-subscription-fixture" });
  await expect(resolveContainerCredential("codex", { kind: "claude-subscription", tokenFile }, 60000)).rejects.toThrow("CONTAINER_AUTH_PROVIDER_MISMATCH");
  await writeFile(tokenFile, "sk-ant-api-fixture");
  await expect(resolveContainerCredential("claude", { kind: "claude-subscription", tokenFile }, 60000)).rejects.toThrow("CONTAINER_SUBSCRIPTION_CREDENTIAL_INVALID");
});
it("refuses shared files and symlinks", async () => {
  const tokenFile = await source("sk-ant-oat01-fixture");
  await symlink(tokenFile, `${tokenFile}.link`);
  await expect(resolveContainerCredential("claude", { kind: "claude-subscription", tokenFile: `${tokenFile}.link` }, 0)).rejects.toThrow(/^CONTAINER_/);
  await chmod(tokenFile, 0o644);
  await expect(resolveContainerCredential("claude", { kind: "claude-subscription", tokenFile }, 0)).rejects.toThrow("CONTAINER_CREDENTIAL_FILE_NOT_PRIVATE");
});
it("rejects ambiguous auth configuration and provider mismatch", () => {
  const containerRuntime = { endpoint: "unix:///tmp/docker.sock", image: `sha256:${"a".repeat(64)}`,
    authentication: { claude: { kind: "claude-subscription", keychainService: "selected" } } };
  expect(BrokerRuntimeConfigSchema.safeParse({ containerRuntime }).success).toBe(true);
  expect(BrokerRuntimeConfigSchema.safeParse({ containerRuntime: { ...containerRuntime, credentialFiles: { claude: "/tmp/api" } } }).success).toBe(false);
  expect(BrokerRuntimeConfigSchema.safeParse({ containerRuntime: { ...containerRuntime, authentication: { codex: containerRuntime.authentication.claude } } }).success).toBe(false);
});
