import { describe, expect, it } from "vitest";
import { DelegationIntentSchema } from "../../src/domain/delegation.js";

const request = {
  provider: "codex",
  cwd: "/tmp/repo",
  sandbox: "read-only",
  instruction: "scout the failing test",
};

describe("DelegationIntentSchema", () => {
  it("carries an explicit bounded request plus parent and correlation identifiers", () => {
    const intent = DelegationIntentSchema.parse({
      delegationId: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      parentSessionId: crypto.randomUUID(),
      request,
      reason: "needs an isolated scout",
    });
    expect(intent.request.provider).toBe("codex");
    expect(intent.parentJobId).toBeUndefined();
    expect(intent.schemaVersion).toBe(1);
  });

  it("still requires an explicit provider inside the delegated request", () => {
    expect(() =>
      DelegationIntentSchema.parse({
        delegationId: crypto.randomUUID(),
        correlationId: crypto.randomUUID(),
        request: { cwd: "/tmp/repo", sandbox: "read-only", instruction: "x" },
      }),
    ).toThrow();
  });
});
