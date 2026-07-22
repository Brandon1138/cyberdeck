import { describe, expect, it } from "vitest";
import { StartSessionRequestSchema } from "../../src/domain/session.js";

describe("StartSessionRequestSchema", () => {
  it("requires an explicit provider and accepts any role label", () => {
    const parsed = StartSessionRequestSchema.parse({
      provider: "claude",
      cwd: "/tmp/repo",
      role: "scout",
      detached: true,
      sandbox: "read-only",
    });
    expect(parsed.provider).toBe("claude");
    expect(parsed.role).toBe("scout");
  });

  it.each(["cursor", "antigravity"])("accepts registered provider slug %s", (provider) => {
    expect(StartSessionRequestSchema.parse({
      provider,
      cwd: "/tmp/repo",
      detached: true,
      sandbox: "read-only",
    }).provider).toBe(provider);
  });

  it("does not require a model or role", () => {
    const parsed = StartSessionRequestSchema.parse({
      provider: "codex",
      cwd: "/tmp/repo",
      detached: false,
      sandbox: "read-only",
    });
    expect(parsed.model).toBeUndefined();
    expect(parsed.role).toBeUndefined();
    expect(parsed.effort).toBeUndefined();
  });

  it("accepts an explicit provider-native reasoning effort", () => {
    const parsed = StartSessionRequestSchema.parse({
      provider: "codex",
      cwd: "/tmp/repo",
      detached: true,
      sandbox: "read-only",
      effort: "xhigh",
    });

    expect(parsed.effort).toBe("xhigh");
    expect(() => StartSessionRequestSchema.parse({
      provider: "codex",
      cwd: "/tmp/repo",
      detached: true,
      sandbox: "read-only",
      effort: "automatic",
    })).toThrow();
  });

  it("persists the authority scope on orchestrator session projections", () => {
    const parsed = StartSessionRequestSchema.parse({
      provider: "codex",
      cwd: "/tmp/repo",
      detached: true,
      sandbox: "read-only",
      kind: "orchestrator",
      orchestratorScope: "fleet",
    });

    expect(parsed.orchestratorScope).toBe("fleet");
  });

  it("rejects a missing provider rather than routing implicitly", () => {
    expect(() => StartSessionRequestSchema.parse({ cwd: "/tmp/repo" })).toThrow();
  });
});
