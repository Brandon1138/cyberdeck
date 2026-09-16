import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SubscriptionRefreshCoordinator } from "../../../src/runtime/execution/subscription-refresh-coordinator.js";
import { codexRefreshCommand, refreshCodexAccount } from "../../../src/runtime/execution/codex-subscription-refresh.js";
import { BrokerContainerContexts } from "../../../src/runtime/execution/broker-container-contexts.js";
import type { CodexRefreshRpcPort, SubscriptionPreflightRequest } from "../../../src/runtime/execution/subscription-refresh-ports.js";
import type { WorkerGateway } from "../../../src/broker/worker-gateway.js";
import type { ExecutionLaunchInput } from "../../../src/orchestration/session/execution-ports.js";

const roots: string[] = [], now = 1_800_000_000_000;
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const jwt = (expires: number) => `header.${Buffer.from(JSON.stringify({ exp: expires / 1000 })).toString("base64url")}.signature`;
const body = (expires: number, account = "account", mode = "chatgpt") => JSON.stringify({ auth_mode: mode, OPENAI_API_KEY: null,
  tokens: { id_token: jwt(expires), access_token: jwt(expires), refresh_token: "HOST_REFRESH_SECRET", account_id: account } });
async function fixture(expires = now + 30000) {
  const root = await mkdtemp(join(tmpdir(), "subscription-refresh-")); roots.push(root);
  const authFile = join(root, "auth.json"); await writeFile(authFile, body(expires), { mode: 0o600 });
  const request: SubscriptionPreflightRequest = { provider: "codex", authentication: { kind: "codex-subscription", authFile }, minimumLifetimeMs: 60000,
    identity: { brokerId: randomUUID(), executionId: randomUUID(), workerId: randomUUID(), sessionId: randomUUID(), generation: 1 }, phase: "launch" };
  return { root, authFile, request };
}
it("deduplicates concurrent host refreshes and exports access-only snapshots", async () => {
  const f = await fixture(); let proceed!: () => void;
  const held = new Promise<void>(resolve => { proceed = resolve; });
  const refreshCodex = vi.fn(async () => { await held; await writeFile(f.authFile, body(now + 7200000)); return { state: "refreshed" as const }; });
  const coordinator = new SubscriptionRefreshCoordinator({ now: () => now, refresh: { refreshCodex } });
  const first = coordinator.prepare(f.request), second = coordinator.prepare({ ...f.request, identity: { ...f.request.identity, executionId: randomUUID() } });
  await vi.waitFor(() => expect(refreshCodex).toHaveBeenCalledTimes(1)); proceed();
  const results = await Promise.all([first, second]);
  expect(results.every(result => result.state === "ready")).toBe(true);
  expect(JSON.stringify(results)).not.toContain("HOST_REFRESH_SECRET");
  expect(JSON.stringify(results)).toContain('"refresh_token":""');
  expect(await readFile(f.authFile, "utf8")).toContain("HOST_REFRESH_SECRET");
  expect(refreshCodex).toHaveBeenCalledWith(expect.objectContaining({ codexHome: await realpath(f.root), timeoutMs: 30000, maxOutputBytes: 65536 }));
  await coordinator.prepare(f.request); expect(refreshCodex).toHaveBeenCalledTimes(1);
});
it("fresh subscription sources do not invoke any refresh helper", async () => {
  const f = await fixture(now + 7200000), refreshCodex = vi.fn(async () => ({ state: "refreshed" as const }));
  expect(await new SubscriptionRefreshCoordinator({ now: () => now, refresh: { refreshCodex } }).prepare(f.request)).toMatchObject({ state: "ready" });
  expect(refreshCodex).not.toHaveBeenCalled();
});
it("capacity wait leaves the queued launch and workspace untouched", async () => {
  const f = await fixture(), issue = vi.fn();
  const coordinator = new SubscriptionRefreshCoordinator({ now: () => now, refresh: { refreshCodex: async () => ({ state: "waiting-capacity" }) } });
  const contexts = new BrokerContainerContexts(f.root, {}, { issue } as unknown as WorkerGateway, 12345, undefined,
    { codex: f.request.authentication }, 1, coordinator);
  const input = { record: { provider: "codex", cwd: f.root }, identity: f.request.identity } as ExecutionLaunchInput;
  await expect(contexts.prepare(input)).rejects.toMatchObject({ message: "CONTAINER_SUBSCRIPTION_REFRESH_WAITING_CAPACITY", status: { state: "waiting-capacity" } });
  expect(issue).not.toHaveBeenCalled(); expect(input.record.cwd).toBe(f.root); expect(await readdir(f.root)).toEqual(["auth.json"]);
});
it("expiry during parking is rechecked on wake and failed refresh exposes no secret diagnostics", async () => {
  const f = await fixture(now + 180000), refreshCodex = vi.fn(async () => { throw new Error("SECRET stderr contains HOST_REFRESH_SECRET"); });
  let time = now;
  const coordinator = new SubscriptionRefreshCoordinator({ now: () => time, refresh: { refreshCodex } });
  expect(await coordinator.prepare(f.request)).toMatchObject({ state: "ready" });
  time += 120000;
  const result = await coordinator.prepare({ ...f.request, phase: "wake", identity: { ...f.request.identity, generation: 2 } });
  expect(result).toEqual({ state: "login-intervention", reason: "refresh-failed" });
  expect(JSON.stringify(result)).not.toContain("SECRET"); expect(refreshCodex).toHaveBeenCalledTimes(1);
  expect(await coordinator.prepare(f.request)).toEqual(result); expect(refreshCodex).toHaveBeenCalledTimes(1);
});
it.each(["external", "wrong-file"])("does not refresh unsupported %s auth sources", async mode => {
  const f = await fixture(), refreshCodex = vi.fn(async () => ({ state: "refreshed" as const }));
  if (mode === "external") await writeFile(f.authFile, body(now + 30000, "account", "chatgptAuthTokens"));
  else { const other = join(f.root, "snapshot"); await writeFile(other, body(now + 30000), { mode: 0o600 }); f.request.authentication = { kind: "codex-subscription", authFile: other }; }
  expect(await new SubscriptionRefreshCoordinator({ now: () => now, refresh: { refreshCodex } }).prepare(f.request))
    .toEqual({ state: "login-intervention", reason: "refresh-unsupported" });
  expect(refreshCodex).not.toHaveBeenCalled();
});
it.each(["stale", "other-account"])("refuses %s credentials after the host reports refresh success", async mode => {
  const f = await fixture();
  const coordinator = new SubscriptionRefreshCoordinator({ now: () => now, refresh: { refreshCodex: async () => {
    if (mode === "other-account") await writeFile(f.authFile, body(now + 7200000, "OTHER_ACCOUNT_SECRET"));
    return { state: "refreshed" };
  } } });
  expect(await coordinator.prepare(f.request)).toEqual({ state: "login-intervention", reason: mode === "stale" ? "refresh-lifetime-insufficient" : "account-changed" });
  if (mode === "other-account") expect(await coordinator.prepare(f.request)).toEqual({ state: "login-intervention", reason: "account-changed" });
});
it("Claude expired Keychain login requires renewal and opaque setup tokens have unknown expiry", async () => {
  const f = await fixture(), refreshCodex = vi.fn(async () => ({ state: "refreshed" as const }));
  const coordinator = new SubscriptionRefreshCoordinator({ now: () => now, refresh: { refreshCodex }, readKeychain: async () => JSON.stringify({
    claudeAiOauth: { accessToken: "ACCESS_SECRET", refreshToken: "REFRESH_SECRET", expiresAt: now - 1, subscriptionType: "max", scopes: ["user:inference"] },
  }) });
  expect(await coordinator.prepare({ ...f.request, provider: "claude", authentication: { kind: "claude-subscription", keychainService: "selected" } }))
    .toEqual({ state: "login-intervention", reason: "renewal-required" });
  await writeFile(f.authFile, "sk-ant-oat01-opaque");
  expect(await coordinator.prepare({ ...f.request, provider: "claude", authentication: { kind: "claude-subscription", tokenFile: f.authFile } }))
    .toEqual({ state: "login-intervention", reason: "expiry-unknown" });
  expect(refreshCodex).not.toHaveBeenCalled();
});
it("uses only pinned account RPCs and checks the host home before refresh", async () => {
  const f = await fixture();
  const session: CodexRefreshRpcPort = { request: vi.fn(async method => method === "initialize"
    ? { userAgent: "codex/0.154.0", codexHome: f.root }
    : { account: { type: "chatgpt", email: "PRIVATE_EMAIL", planType: "pro" }, requiresOpenaiAuth: true }), notify: vi.fn() };
  await refreshCodexAccount(session, f.root);
  expect(vi.mocked(session.request).mock.calls.map(([method, params]) => [method, params.refreshToken])).toEqual([
    ["initialize", undefined], ["account/read", false], ["account/read", true],
  ]);
  expect(session.notify).toHaveBeenCalledWith("initialized");
  const command = codexRefreshCommand(f.root, { PATH: "/usr/bin", HOME: "/host", OPENAI_API_KEY: "NEVER", ANTHROPIC_API_KEY: "NEVER" } as NodeJS.ProcessEnv);
  expect(command.env).toEqual({ PATH: "/usr/bin", HOME: "/host", CODEX_HOME: f.root });
  expect(command.args).toContain('forced_login_method="chatgpt"'); expect(JSON.stringify(command)).not.toContain("NEVER");
});
it.each(["version", "home", "api", "secret-error"])("refuses %s app-server responses without forwarding account data", async mode => {
  const f = await fixture();
  const session: CodexRefreshRpcPort = { request: vi.fn(async method => {
    if (mode === "secret-error") throw new Error("PRIVATE_EMAIL SECRET_TOKEN");
    if (method === "initialize") return { userAgent: mode === "version" ? "codex/0.153.0" : "codex/0.154.0", codexHome: mode === "home" ? "/no-such-host-home" : f.root };
    return { account: { type: "apiKey" }, requiresOpenaiAuth: true };
  }), notify: vi.fn() };
  await expect(refreshCodexAccount(session, f.root)).rejects.toThrow(/^CONTAINER_SUBSCRIPTION_REFRESH_FAILED$/);
  expect(vi.mocked(session.request).mock.calls.some(([, params]) => params.refreshToken === true)).toBe(false);
});
