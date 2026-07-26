import { z } from "zod";
import type { ApprovalMode, ProviderId, Sandbox } from "../domain/session.js";

export const ProviderPermissionPolicySchema = z.enum(["permissioned", "automatic"]);
export type ProviderPermissionPolicy = z.infer<typeof ProviderPermissionPolicySchema>;

export const CONFIGURABLE_PERMISSION_PROVIDERS = [
  "codex",
  "claude",
  "cursor",
  "antigravity",
] as const;

export type ConfigurablePermissionProvider =
  (typeof CONFIGURABLE_PERMISSION_PROVIDERS)[number];

export interface ProviderPermissionResolution {
  provider: ConfigurablePermissionProvider;
  policy: ProviderPermissionPolicy;
  nativeMode: string;
  launchArguments: readonly string[];
  application:
    | { kind: "approval-mode"; value: ApprovalMode }
    | { kind: "post-launch-command"; command: "/run-everything" };
}

export type ProviderPermissionResolutionResult =
  | { ok: true; value: ProviderPermissionResolution }
  | {
      ok: false;
      code: "PROVIDER_PERMISSION_POLICY_UNSUPPORTED";
      message: string;
    };

/**
 * Resolves one provider-neutral preference into explicit provider-native launch behavior.
 * Every supported mapping is named here; callers must surface failures rather than substituting.
 */
export function resolveProviderPermission(
  provider: ProviderId,
  policy: ProviderPermissionPolicy,
  sandbox: Sandbox,
): ProviderPermissionResolutionResult {
  if (provider === "codex") {
    const automatic = policy === "automatic";
    return {
      ok: true,
      value: {
        provider,
        policy,
        nativeMode: automatic ? "automatic" : "approve-for-me",
        launchArguments: ["-a", automatic ? "never" : "on-request"],
        application: { kind: "approval-mode", value: automatic ? "auto" : "prompt" },
      },
    };
  }

  if (provider === "claude") {
    const automatic = policy === "automatic";
    return {
      ok: true,
      value: {
        provider,
        policy,
        nativeMode: automatic ? "auto mode" : "normal permissioned mode",
        launchArguments: [
          "--permission-mode",
          automatic ? "auto" : sandbox === "read-only" ? "plan" : "manual",
        ],
        application: { kind: "approval-mode", value: automatic ? "auto" : "prompt" },
      },
    };
  }

  if (provider === "cursor") {
    if (policy === "automatic") {
      return {
        ok: true,
        value: {
          provider,
          policy,
          nativeMode: "/run-everything",
          launchArguments: [],
          application: { kind: "post-launch-command", command: "/run-everything" },
        },
      };
    }
    return {
      ok: true,
      value: {
        provider,
        policy,
        nativeMode: "normal",
        launchArguments: sandbox === "read-only" ? ["--mode", "plan"] : [],
        application: { kind: "approval-mode", value: "prompt" },
      },
    };
  }

  if (provider === "antigravity" && policy === "permissioned") {
    return {
      ok: true,
      value: {
        provider,
        policy,
        nativeMode: "normal approvals",
        launchArguments: [],
        application: { kind: "approval-mode", value: "prompt" },
      },
    };
  }

  return {
    ok: false,
    code: "PROVIDER_PERMISSION_POLICY_UNSUPPORTED",
    message: provider === "antigravity"
      ? "Antigravity does not support automatic permission policy"
      : `Provider ${provider} has no permission policy mapping`,
  };
}

export function permissionProviderLabel(provider: ProviderId): string {
  return provider === "cursor"
    ? "Composer"
    : provider === "antigravity"
      ? "Antigravity"
      : provider.length === 0
        ? provider
        : `${provider[0]!.toUpperCase()}${provider.slice(1)}`;
}
