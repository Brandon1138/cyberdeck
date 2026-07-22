import { describe, expect, it } from "vitest";
import type { StartSessionRequest } from "../../src/domain/session.js";
import { evaluateClaudeLaunchSafety, evaluateStart, isFableModel } from "../../src/domain/policy.js";

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

  it("enforces the worker limit with useful counts", () => {
    expect(evaluateStart(baseRequest, [], {
      activeWorkerCount: 24,
      maxConcurrentWorkers: 24,
    })).toEqual({
      allowed: false,
      code: "MAX_CONCURRENT_WORKERS",
      activeWorkers: 24,
      maxConcurrentWorkers: 24,
    });
  });

  it("does not count or block orchestrators and supports explicit unlimited workers", () => {
    expect(evaluateStart({ ...baseRequest, kind: "orchestrator" }, [], {
      activeWorkerCount: 24,
      maxConcurrentWorkers: 24,
    })).toEqual({ allowed: true });
    expect(evaluateStart(baseRequest, [], {
      activeWorkerCount: 100,
      maxConcurrentWorkers: null,
    })).toEqual({ allowed: true });
  });

  it.each(["scout", "writer", "cheap-task"])("ignores opaque role %s", (role) => {
    expect(evaluateStart({ ...baseRequest, role }, [])).toEqual({ allowed: true });
  });

  it("keeps model optional for delegated Claude in the neutral stored contract", () => {
    // The stored start policy stays neutral: an omitted model is not blocked here. Omission is
    // unsafe only at the live launch boundary, which evaluateClaudeLaunchSafety guards separately.
    expect(
      evaluateStart({ ...baseRequest, provider: "claude", parentSessionId: "parent" }, [parent]),
    ).toEqual({ allowed: true });
  });
});

describe("evaluateClaudeLaunchSafety", () => {
  it("refuses a Claude launch with an omitted model because the native default may be Fable", () => {
    expect(evaluateClaudeLaunchSafety("claude", undefined)).toEqual({
      safe: false,
      code: "CLAUDE_LAUNCH_REQUIRES_EXPLICIT_NON_FABLE_MODEL",
    });
  });

  it("refuses a Claude launch with an explicit Fable model", () => {
    expect(evaluateClaudeLaunchSafety("claude", "claude-fable-5")).toEqual({
      safe: false,
      code: "CLAUDE_LAUNCH_REQUIRES_EXPLICIT_NON_FABLE_MODEL",
    });
  });

  it("allows a Claude launch with an explicit ordinary model", () => {
    expect(evaluateClaudeLaunchSafety("claude", "opus")).toEqual({ safe: true });
  });

  it("does not constrain non-Claude providers", () => {
    expect(evaluateClaudeLaunchSafety("codex", undefined)).toEqual({ safe: true });
    expect(evaluateClaudeLaunchSafety("cursor", undefined)).toEqual({ safe: true });
  });
});
