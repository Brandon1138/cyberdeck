import { describe, expect, it } from "vitest";
import { ResolvedLaunchRecordSchema } from "../../src/domain/session.js";
import { resolvedLaunchRecord } from "../../src/providers/launch-record.js";
import type { ProviderLaunchSpec } from "../../src/providers/provider.js";

const SENTINEL_SECRETS = {
  ANTHROPIC_API_KEY: "sk-ant-SENTINEL-0001",
  OPENAI_API_KEY: "sk-SENTINEL-0002",
  GITHUB_TOKEN: "ghp_SENTINEL0003",
  AWS_SECRET_ACCESS_KEY: "SENTINEL/0004",
  NPM_TOKEN: "npm_SENTINEL0005",
};

function spec(overrides: Partial<ProviderLaunchSpec> = {}): ProviderLaunchSpec {
  return {
    executable: "claude",
    args: ["--session-id", "11111111-1111-4111-8111-111111111111"],
    cwd: "/tmp/repo",
    env: {
      ...SENTINEL_SECRETS,
      PATH: "/usr/bin",
      CYBERDECK_PROCESS_ROLE: "orchestrator",
      CYBERDECK_WORKER_MODE: "normal",
      DISABLE_UPDATES: "1",
      ENABLE_TOOL_SEARCH: "false",
    },
    ...overrides,
  };
}

describe("resolvedLaunchRecord", () => {
  it("never emits an inherited environment value or key", () => {
    const record = resolvedLaunchRecord(spec(), "launch");
    const serialized = JSON.stringify(record);

    for (const [key, value] of Object.entries(SENTINEL_SECRETS)) {
      expect(serialized).not.toContain(value);
      expect(serialized).not.toContain(key);
    }
    expect(serialized).not.toContain("SENTINEL");
    expect(serialized).not.toContain("/usr/bin");
    expect(record.cyberdeckEnv).toEqual({
      CYBERDECK_PROCESS_ROLE: "orchestrator",
      CYBERDECK_WORKER_MODE: "normal",
      DISABLE_UPDATES: "1",
      ENABLE_TOOL_SEARCH: "false",
    });
    expect(record.inheritedEnvCount).toBe(6);
  });

  it("keeps the executable, argv, and cwd the broker actually spawned", () => {
    const record = resolvedLaunchRecord(spec(), "resume", "2026-07-25T12:00:00.000Z");

    expect(record).toMatchObject({
      mode: "resume",
      resolvedAt: "2026-07-25T12:00:00.000Z",
      executable: "claude",
      args: ["--session-id", "11111111-1111-4111-8111-111111111111"],
      cwd: "/tmp/repo",
      truncated: false,
    });
  });

  it("bounds a hostile argv so a catalog entry stays schema-safe", () => {
    const record = resolvedLaunchRecord(
      spec({ args: Array.from({ length: 400 }, () => "x".repeat(9_000)) }),
      "launch",
    );

    expect(record.truncated).toBe(true);
    expect(record.args).toHaveLength(256);
    expect(record.args[0]).toHaveLength(4_096);
    expect(() => ResolvedLaunchRecordSchema.parse(record)).not.toThrow();
  });

  it("omits undefined environment entries rather than counting them", () => {
    const record = resolvedLaunchRecord(
      spec({ env: { KEEP: "value", DROPPED: undefined, CYBERDECK_PROCESS_ROLE: "worker" } }),
      "launch",
    );

    expect(record.inheritedEnvCount).toBe(1);
    expect(record.cyberdeckEnv).toEqual({ CYBERDECK_PROCESS_ROLE: "worker" });
  });

  it("records unknown and granted entries only as a count", () => {
    const grantValue = ["synthetic", "operator", "grant"].join("-");
    const record = resolvedLaunchRecord(spec({
      env: {
        SSH_AUTH_SOCK: grantValue,
        UNKNOWN_INTEGRATION_STATE: "synthetic-state",
      },
    }), "launch");
    const serialized = JSON.stringify(record);

    expect(record.inheritedEnvCount).toBe(2);
    expect(record.cyberdeckEnv).toEqual({});
    expect(serialized).not.toContain("SSH_AUTH_SOCK");
    expect(serialized).not.toContain(grantValue);
    expect(serialized).not.toContain("UNKNOWN_INTEGRATION_STATE");
    expect(serialized).not.toContain("synthetic-state");
  });
});
