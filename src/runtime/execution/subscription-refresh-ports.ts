import type { ContainerAuthentication } from "../../domain/container-authentication.js";
import type { ExecutionIdentity } from "../../domain/worker-execution.js";

export interface SubscriptionPreflightRequest {
  provider: string; authentication: ContainerAuthentication; minimumLifetimeMs: number;
  identity: ExecutionIdentity; phase: "launch" | "wake"; signal?: AbortSignal;
}
export type SubscriptionInterventionReason = "credential-unavailable" | "renewal-required" | "expiry-unknown"
  | "refresh-unsupported" | "refresh-failed" | "refresh-lifetime-insufficient" | "account-changed";
export type SubscriptionPreflightStatus =
  | { state: "ready"; expiresAt: number | null }
  | { state: "waiting-capacity"; reason: "refresh-capacity" }
  | { state: "login-intervention"; reason: SubscriptionInterventionReason }
  | { state: "cancelled" };
/** Credentials are host-private return data, never part of health/status or callback diagnostics. */
export type SubscriptionPreflightResult = Exclude<SubscriptionPreflightStatus, { state: "ready" }>
  | { state: "ready"; expiresAt: number | null; credential: Record<string, unknown> };
export interface SubscriptionPreflightPort { prepare(request: SubscriptionPreflightRequest): Promise<SubscriptionPreflightResult> }
export class SubscriptionPreflightError extends Error {
  constructor(readonly status: Exclude<SubscriptionPreflightStatus, { state: "ready" }>) {
    super(status.state === "waiting-capacity" ? "CONTAINER_SUBSCRIPTION_REFRESH_WAITING_CAPACITY"
      : status.state === "cancelled" ? "CONTAINER_SUBSCRIPTION_PREFLIGHT_CANCELLED" : "CONTAINER_SUBSCRIPTION_LOGIN_INTERVENTION");
    this.name = "SubscriptionPreflightError";
  }
}

/** Only the composition root may provide this port. It reserves the helper and confirms its
 * termination before releasing capacity; no helper process is spawned by the coordinator. */
export interface AdmittedSubscriptionRefreshPort {
  refreshCodex(input: { identity: ExecutionIdentity; sourceId: string; codexHome: string; timeoutMs: 30000; maxOutputBytes: 65536 }):
    Promise<{ state: "refreshed" } | { state: "waiting-capacity" } | { state: "intervention" }>;
}
/** Broker-owned admitted app-server session. Its transport must bound bytes/deadlines and discard
 * raw stderr/error payloads. The caller owns confirmed shutdown in success and failure paths. */
export interface CodexRefreshRpcPort {
  request(method: "initialize" | "account/read", params: Record<string, unknown>): Promise<unknown>;
  notify(method: "initialized"): void;
}
