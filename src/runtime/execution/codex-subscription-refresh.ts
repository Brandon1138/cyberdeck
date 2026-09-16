import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import type { CodexRefreshRpcPort } from "./subscription-refresh-ports.js";

export const CODEX_REFRESH_PROTOCOL_VERSION = "0.154.0";
/** Versioned, installed-protocol evidence: GetAccountParams.refreshToken requests the normal
 * managed-auth refresh flow; external chatgptAuthTokens explicitly ignores it. No turn starts. */
export async function refreshCodexAccount(session: CodexRefreshRpcPort, expectedHome: string): Promise<void> {
  try {
    if (!isAbsolute(expectedHome)) throw new Error();
    const initialized = z.object({ userAgent: z.string(), codexHome: z.string() }).parse(await session.request("initialize", {
      clientInfo: { name: "cyberdeck-auth-refresh", title: "Cyberdeck subscription refresh", version: "1" },
      capabilities: { experimentalApi: false, requestAttestation: false },
    }));
    if (!/(?:^|[^0-9])0\.154\.0(?:[^0-9]|$)/.test(initialized.userAgent)
      || await realpath(initialized.codexHome) !== await realpath(expectedHome)) throw new Error();
    session.notify("initialized");
    const account = z.object({ account: z.object({ type: z.literal("chatgpt") }), requiresOpenaiAuth: z.boolean() });
    // Refuse API/no-account modes before issuing the mutating refresh request.
    account.parse(await session.request("account/read", { refreshToken: false }));
    account.parse(await session.request("account/read", { refreshToken: true }));
  } catch { throw new Error("CONTAINER_SUBSCRIPTION_REFRESH_FAILED"); }
}

/** The admitted transport must use only this host-owned command profile and environment allowlist.
 * These settings already bind the repository's guest subscription launch to file-backed ChatGPT
 * auth; here CODEX_HOME names the original host auth.json directory, never a copied refresh token. */
export function codexRefreshCommand(codexHome: string, environment: Readonly<NodeJS.ProcessEnv>) {
  if (!isAbsolute(codexHome)) throw new Error("CONTAINER_SUBSCRIPTION_REFRESH_SOURCE_INVALID");
  return { executable: "codex" as const, args: ["app-server", "--stdio", "--strict-config", "-c", 'forced_login_method="chatgpt"',
    "-c", 'cli_auth_credentials_store="file"'], cwd: codexHome,
  env: { ...(environment.PATH ? { PATH: environment.PATH } : {}), ...(environment.HOME ? { HOME: environment.HOME } : {}),
    ...(environment.TMPDIR ? { TMPDIR: environment.TMPDIR } : {}), CODEX_HOME: codexHome } };
}
