import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { open, constants } from "node:fs/promises";
import { z } from "zod";
import { authenticationMatchesProvider, type ContainerAuthentication } from "../../domain/container-authentication.js";

const run = promisify(execFile);
const token = z.string().min(1).max(32768);
const claudeLogin = z.object({ claudeAiOauth: z.object({ accessToken: token, expiresAt: z.number().positive(),
  subscriptionType: z.string().min(1), scopes: z.array(z.string()),
}) });
const codexLogin = z.object({ auth_mode: z.enum(["chatgpt", "chatgptAuthTokens"]),
  OPENAI_API_KEY: z.null().optional(), tokens: z.object({ id_token: token, access_token: token, account_id: token }),
});

/** Reject symlinks, non-files and shared secrets; never include credential text in errors. */
export async function readPrivateCredential(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 65536 || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw new Error("CONTAINER_CREDENTIAL_FILE_NOT_PRIVATE");
    return (await handle.readFile("utf8")).trim();
  } finally { await handle.close(); }
}

export interface SubscriptionCredentialDeps {
  now?: () => number;
  readKeychain?: (service: string) => Promise<string>;
}
/** Host login owns refresh. Guests receive access-only snapshots, never rotating refresh tokens. */
export async function resolveContainerCredential(provider: string, auth: ContainerAuthentication, minimumLifetimeMs: number,
  deps: SubscriptionCredentialDeps = {},
): Promise<Record<string, unknown>> {
  if (!authenticationMatchesProvider(provider, auth)) throw new Error("CONTAINER_AUTH_PROVIDER_MISMATCH");
  const now = (deps.now ?? Date.now)();
  const fresh = (expiresAt: number) => {
    if (!Number.isFinite(expiresAt) || expiresAt <= now + minimumLifetimeMs + 60_000) throw new Error("CONTAINER_SUBSCRIPTION_LOGIN_EXPIRED");
  };
  try {
    if (auth.kind === "api-key") return { provider, kind: auth.kind, apiKey: token.parse(await readPrivateCredential(auth.file)) };
    if (auth.kind === "claude-subscription") {
      let oauthToken: string;
      let expiresAt: number | undefined;
      if (auth.tokenFile) {
        oauthToken = token.parse(await readPrivateCredential(auth.tokenFile));
        if (!oauthToken.startsWith("sk-ant-oat")) throw new Error("CONTAINER_SUBSCRIPTION_CREDENTIAL_INVALID");
      } else {
        const readKeychain = deps.readKeychain ?? (async (service: string) => {
          if (process.platform !== "darwin") throw new Error("CONTAINER_KEYCHAIN_UNAVAILABLE");
          return (await run("/usr/bin/security", ["find-generic-password", "-s", service, "-w"], { timeout: 5000, maxBuffer: 65536 })).stdout;
        });
        const login = claudeLogin.parse(JSON.parse(await readKeychain(auth.keychainService!))).claudeAiOauth;
        if (!login.scopes.includes("user:inference")) throw new Error("CONTAINER_SUBSCRIPTION_CREDENTIAL_INVALID");
        oauthToken = login.accessToken; expiresAt = login.expiresAt; fresh(expiresAt);
      }
      return { provider, kind: auth.kind, oauthToken, ...(expiresAt ? { expiresAt } : {}) };
    }
    const login = codexLogin.parse(JSON.parse(await readPrivateCredential(auth.authFile)));
    const claims = JSON.parse(Buffer.from(login.tokens.access_token.split(".")[1]!, "base64url").toString());
    const expiresAt = z.number().positive().parse(claims.exp) * 1000;
    fresh(expiresAt);
    return { provider, kind: auth.kind, expiresAt, auth: { auth_mode: "chatgptAuthTokens", OPENAI_API_KEY: null,
      tokens: { ...login.tokens, refresh_token: "" }, last_refresh: new Date(now).toISOString() } };
  } catch (error) {
    if (error instanceof Error && /^CONTAINER_[A-Z_]+$/.test(error.message)) throw error;
    throw new Error("CONTAINER_SUBSCRIPTION_CREDENTIAL_UNAVAILABLE");
  }
}
