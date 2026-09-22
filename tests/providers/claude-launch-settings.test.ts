import { describe, expect, it } from "vitest";
import {
  CLAUDE_FIRST_PARTY_BASE_URL,
  claudeLaunchSettings,
} from "../../src/providers/claude/launch-settings.js";

const HOOK = {
  nodePath: "/usr/bin/node",
  cliPath: "/opt/cyberdeck/cli.js",
  sessionId: "session-1",
  stateDirectory: "/state/dir",
};

describe("claudeLaunchSettings", () => {
  it("pins an orchestrator to the first-party endpoint even with no transcript hook", () => {
    // The pin does not depend on the broker being able to receive rebinds: Remote Control is
    // gated on the endpoint alone, and the cwd's own settings can name a proxy.
    const settings = JSON.parse(claudeLaunchSettings({ orchestrator: true })!) as {
      env: Record<string, string>;
      hooks?: unknown;
    };
    expect(settings.env).toEqual({ ANTHROPIC_BASE_URL: CLAUDE_FIRST_PARTY_BASE_URL });
    expect(settings.hooks).toBeUndefined();
    expect(new URL(CLAUDE_FIRST_PARTY_BASE_URL).host).toBe("api.anthropic.com");
  });

  it("carries the transcript hook and the pin in one file", () => {
    const settings = JSON.parse(
      claudeLaunchSettings({ orchestrator: true, transcriptHook: HOOK })!,
    ) as { env: Record<string, string>; hooks: { SessionStart: unknown[] } };
    expect(settings.env.ANTHROPIC_BASE_URL).toBe(CLAUDE_FIRST_PARTY_BASE_URL);
    expect(settings.hooks.SessionStart).toHaveLength(1);
  });

  it("never pins a worker or top-level session", () => {
    // Everything that is not an orchestrator keeps the operator's routing, proxy included.
    const settings = JSON.parse(
      claudeLaunchSettings({ orchestrator: false, transcriptHook: HOOK })!,
    ) as { env?: unknown; hooks: unknown };
    expect(settings.env).toBeUndefined();
    expect(settings.hooks).toBeDefined();
  });

  it("is absent when there is nothing to declare", () => {
    expect(claudeLaunchSettings({ orchestrator: false })).toBeUndefined();
  });
});
