import { describe, expect, it } from "vitest";
import type { StartSessionRequest } from "../../src/domain/session.js";
import { evaluateStart, isFableModel } from "../../src/domain/policy.js";

const baseRequest: StartSessionRequest = {
  provider: "claude",
  cwd: "/tmp/repo",
  detached: true,
  sandbox: "read-only",
};

describe("isFableModel", () => {
  it.each(["fable", "claude-fable-5", "CLAUDE-FABLE-5"])("matches %s", (model) => {
    expect(isFableModel(model)).toBe(true);
  });

  it.each(["opus", "sonnet", undefined])("does not match %s", (model) => {
    expect(isFableModel(model)).toBe(false);
  });
});

describe("evaluateStart", () => {
  const parent = { id: "parent", parentSessionId: undefined };
  const child = { id: "child", parentSessionId: "parent" };

  it("allows top-level and delegated Opus", () => {
    expect(evaluateStart({ ...baseRequest, model: "opus" }, [])).toEqual({ allowed: true });
    expect(
      evaluateStart({ ...baseRequest, model: "opus", parentSessionId: "parent" }, [parent]),
    ).toEqual({ allowed: true });
  });

  it("allows an explicitly started top-level Fable session", () => {
    expect(evaluateStart({ ...baseRequest, model: "fable" }, [])).toEqual({ allowed: true });
  });

  it("rejects delegated Fable", () => {
    expect(
      evaluateStart({ ...baseRequest, model: "fable", parentSessionId: "parent" }, [parent]),
    ).toEqual({ allowed: false, code: "FABLE_REQUIRES_EXPLICIT_HUMAN_START" });
  });

  it("rejects delegation beyond one level", () => {
    expect(
      evaluateStart(
        { ...baseRequest, provider: "codex", parentSessionId: "child" },
        [parent, child],
      ),
    ).toEqual({ allowed: false, code: "MAX_DELEGATION_DEPTH" });
  });

  it("enforces the concurrent-session limit", () => {
    expect(evaluateStart(baseRequest, [], { activeSessionCount: 4 })).toEqual({
      allowed: false,
      code: "MAX_CONCURRENT_SESSIONS",
    });
  });

  it.each(["scout", "writer", "cheap-task"])("ignores opaque role %s", (role) => {
    expect(evaluateStart({ ...baseRequest, role }, [])).toEqual({ allowed: true });
  });
});
