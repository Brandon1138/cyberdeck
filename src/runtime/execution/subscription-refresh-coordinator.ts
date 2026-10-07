import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { realpath } from "node:fs/promises";
import { z } from "zod";
import { ContainerAuthenticationSchema } from "../../domain/container-authentication.js";
import { ExecutionIdentitySchema } from "../../domain/worker-execution.js";
import { readPrivateCredential, resolveContainerCredential, type SubscriptionCredentialDeps } from "./subscription-credentials.js";
import type { AdmittedSubscriptionRefreshPort, SubscriptionPreflightPort, SubscriptionPreflightRequest,
  SubscriptionPreflightResult, SubscriptionPreflightStatus } from "./subscription-refresh-ports.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const managedAuth = z.object({ auth_mode: z.literal("chatgpt"), OPENAI_API_KEY: z.null().optional(),
  tokens: z.object({ refresh_token: z.string().min(1), account_id: z.string().min(1) }) });
type RefreshResult = Awaited<ReturnType<AdmittedSubscriptionRefreshPort["refreshCodex"]>>;
export class SubscriptionRefreshCoordinator implements SubscriptionPreflightPort {
  private readonly inFlight = new Map<string, Promise<RefreshResult>>();
  private readonly states = new Map<string, SubscriptionPreflightStatus>();
  private readonly failedVersions = new Map<string, string>();
  private readonly accounts = new Map<string, string>();
  constructor(private readonly options: SubscriptionCredentialDeps & { refresh?: AdmittedSubscriptionRefreshPort } = {}) {}
  /** Status is metadata only: no source path, account identity, credential or provider error text. */
  status(sourceId: string): SubscriptionPreflightStatus | undefined { return this.states.get(sourceId); }
  /** Explicit operator retry; ordinary queue polls never loop refresh against one failed source. */
  retry(sourceId: string): void { this.failedVersions.delete(sourceId); this.accounts.delete(sourceId); }
  private async source(request: SubscriptionPreflightRequest): Promise<{ sourceId: string; codexHome?: string; account?: string; version?: string }> {
    const auth = request.authentication;
    if (auth.kind !== "codex-subscription") return { sourceId: hash(JSON.stringify(auth)) };
    const home = await realpath(dirname(auth.authFile));
    const sourceId = hash(join(home, basename(auth.authFile)));
    if (basename(auth.authFile) !== "auth.json") return { sourceId };
    try {
      const body = await readPrivateCredential(auth.authFile), parsed = managedAuth.parse(JSON.parse(body));
      return { sourceId, codexHome: home, account: hash(parsed.tokens.account_id), version: hash(body) };
    } catch { return { sourceId }; }
  }
  async prepare(input: SubscriptionPreflightRequest): Promise<SubscriptionPreflightResult> {
    const request = { ...input, authentication: ContainerAuthenticationSchema.parse(input.authentication), identity: ExecutionIdentitySchema.parse(input.identity) };
    if (!Number.isSafeInteger(request.minimumLifetimeMs) || request.minimumLifetimeMs < 0 || !["launch", "wake"].includes(request.phase))
      throw new Error("CONTAINER_SUBSCRIPTION_PREFLIGHT_INVALID");
    if (request.signal?.aborted) return { state: "cancelled" };
    let source: Awaited<ReturnType<SubscriptionRefreshCoordinator["source"]>>;
    try { source = await this.source(request); } catch { return { state: "login-intervention", reason: "credential-unavailable" }; }
    const finish = (result: SubscriptionPreflightResult): SubscriptionPreflightResult => {
      const status: SubscriptionPreflightStatus = result.state === "ready" ? { state: "ready", expiresAt: result.expiresAt } : result;
      this.states.set(source.sourceId, status); return result;
    };
    if (source.account) {
      const account = this.accounts.get(source.sourceId);
      if (account && account !== source.account) return finish({ state: "login-intervention", reason: "account-changed" });
      this.accounts.set(source.sourceId, source.account);
    }
    const read = () => resolveContainerCredential(request.provider, request.authentication, request.minimumLifetimeMs, this.options);
    try {
      const credential = await read();
      if (request.signal?.aborted) return finish({ state: "cancelled" });
      if (request.authentication.kind !== "api-key" && typeof credential.expiresAt !== "number")
        return finish({ state: "login-intervention", reason: "expiry-unknown" });
      this.failedVersions.delete(source.sourceId);
      return finish({ state: "ready", expiresAt: typeof credential.expiresAt === "number" ? credential.expiresAt : null, credential });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "CONTAINER_SUBSCRIPTION_LOGIN_EXPIRED")
        return finish({ state: "login-intervention", reason: "credential-unavailable" });
    }
    if (request.authentication.kind === "claude-subscription") return finish({ state: "login-intervention", reason: "renewal-required" });
    if (!source.codexHome || !source.account || !this.options.refresh) return finish({ state: "login-intervention", reason: "refresh-unsupported" });
    if (source.version && this.failedVersions.get(source.sourceId) === source.version)
      return finish({ state: "login-intervention", reason: "refresh-failed" });
    let pending = this.inFlight.get(source.sourceId);
    if (!pending) {
      const codexHome = source.codexHome;
      pending = (async (): Promise<RefreshResult> => {
        // Recheck inside the source's single-flight operation; another completed refresh may
        // already have replaced the file between the caller's first read and this acquisition.
        try { await read(); return { state: "refreshed" }; } catch (error) {
          if (!(error instanceof Error) || error.message !== "CONTAINER_SUBSCRIPTION_LOGIN_EXPIRED") return { state: "intervention" };
        }
        return this.options.refresh!.refreshCodex({ identity: request.identity, sourceId: source.sourceId, codexHome, timeoutMs: 30000, maxOutputBytes: 65536 });
      })().catch((): RefreshResult => ({ state: "intervention" }));
      this.inFlight.set(source.sourceId, pending);
      void pending.finally(() => { if (this.inFlight.get(source.sourceId) === pending) this.inFlight.delete(source.sourceId); });
    }
    const refreshed = await pending;
    if (request.signal?.aborted) return finish({ state: "cancelled" });
    if (refreshed.state === "waiting-capacity") return finish({ state: "waiting-capacity", reason: "refresh-capacity" });
    if (refreshed.state !== "refreshed") {
      if (source.version) this.failedVersions.set(source.sourceId, source.version);
      return finish({ state: "login-intervention", reason: "refresh-failed" });
    }
    try {
      const credential = await read();
      const refreshedSource = await this.source(request);
      if (refreshedSource.account !== source.account) return finish({ state: "login-intervention", reason: "account-changed" });
      return finish({ state: "ready", expiresAt: credential.expiresAt as number, credential });
    } catch {
      const current = await this.source(request).catch(() => source);
      if (current.version) this.failedVersions.set(source.sourceId, current.version);
      return finish({ state: "login-intervention", reason: "refresh-lifetime-insufficient" });
    }
  }
}
