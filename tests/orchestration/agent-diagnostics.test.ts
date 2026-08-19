import { describe, expect, it } from "vitest";
import { inspectAgentDiagnosticState } from "../../src/orchestration/agent-diagnostics.js";

describe("agent diagnostics", () => {
  it("distinguishes an outdated broker from an unreachable broker", async () => {
    const outdated = await inspectAgentDiagnosticState({
      actorSessionId: "11111111-1111-4111-8111-111111111111",
      describeActor: async () => {
        throw Object.assign(new Error("Unknown method agent.actor.describe"), {
          code: "METHOD_NOT_FOUND",
        });
      },
    });
    const unreachable = await inspectAgentDiagnosticState({
      actorSessionId: "11111111-1111-4111-8111-111111111111",
      describeActor: async () => {
        throw new Error("connect ENOENT");
      },
    });

    expect(outdated).toEqual({
      actor: undefined,
      brokerError: "Unknown method agent.actor.describe",
      brokerStatus: "outdated",
    });
    expect(unreachable).toEqual({
      actor: undefined,
      brokerError: "connect ENOENT",
      brokerStatus: "unreachable",
    });
  });

  it("returns actor status without shaping controller output", async () => {
    await expect(inspectAgentDiagnosticState({
      actorSessionId: "11111111-1111-4111-8111-111111111111",
      describeActor: async (actorSessionId) => ({ actorSessionId, status: "bound" }),
    })).resolves.toEqual({
      actor: {
        actorSessionId: "11111111-1111-4111-8111-111111111111",
        status: "bound",
      },
      actorStatus: "bound",
      brokerStatus: "reachable",
    });
  });
});
