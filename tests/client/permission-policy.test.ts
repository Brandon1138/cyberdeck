import { describe, expect, it } from "vitest";
import { resolveProviderPermission } from "../../src/client/permission-policy.js";

describe("provider permission policy resolution", () => {
  it("describes Codex approval policies by effect, not by Codex's inverted native names", () => {
    expect(resolveProviderPermission("codex", "permissioned", "workspace-write"))
      .toEqual({
        ok: true,
        value: {
          provider: "codex",
          policy: "permissioned",
          nativeMode: "asks you to approve",
          launchArguments: ["-a", "on-request"],
          application: { kind: "approval-mode", value: "prompt" },
        },
      });
    expect(resolveProviderPermission("codex", "automatic", "workspace-write"))
      .toEqual({
        ok: true,
        value: {
          provider: "codex",
          policy: "automatic",
          nativeMode: "never asks · sandboxed",
          launchArguments: ["-a", "never"],
          application: { kind: "approval-mode", value: "auto" },
        },
      });
  });

  it("resolves Claude normal and auto modes without hiding sandbox-specific native mode", () => {
    expect(resolveProviderPermission("claude", "permissioned", "read-only"))
      .toMatchObject({
        ok: true,
        value: {
          nativeMode: "normal permissioned mode",
          launchArguments: ["--permission-mode", "plan"],
        },
      });
    expect(resolveProviderPermission("claude", "permissioned", "workspace-write"))
      .toMatchObject({
        ok: true,
        value: {
          launchArguments: ["--permission-mode", "manual"],
        },
      });
    expect(resolveProviderPermission("claude", "automatic", "workspace-write"))
      .toMatchObject({
        ok: true,
        value: {
          nativeMode: "auto mode",
          launchArguments: ["--permission-mode", "auto"],
        },
      });
  });

  it("resolves Composer normal and /run-everything as distinct native applications", () => {
    expect(resolveProviderPermission("cursor", "permissioned", "read-only"))
      .toMatchObject({
        ok: true,
        value: {
          nativeMode: "normal",
          launchArguments: ["--mode", "plan"],
          application: { kind: "approval-mode", value: "prompt" },
        },
      });
    expect(resolveProviderPermission("cursor", "automatic", "workspace-write"))
      .toMatchObject({
        ok: true,
        value: {
          nativeMode: "/run-everything",
          launchArguments: [],
          application: {
            kind: "post-launch-command",
            command: "/run-everything",
          },
        },
      });
  });

  it("returns explicit failures instead of downgrading unsupported policies", () => {
    expect(resolveProviderPermission("antigravity", "automatic", "workspace-write"))
      .toEqual({
        ok: false,
        code: "PROVIDER_PERMISSION_POLICY_UNSUPPORTED",
        message: "Antigravity does not support automatic permission policy",
      });
    expect(resolveProviderPermission("future-provider", "permissioned", "read-only"))
      .toEqual({
        ok: false,
        code: "PROVIDER_PERMISSION_POLICY_UNSUPPORTED",
        message: "Provider future-provider has no permission policy mapping",
      });
  });
});
