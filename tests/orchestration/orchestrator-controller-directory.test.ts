import { describe, expect, it } from "vitest";
import { orchestratorController, type OrchestratorBinding } from "../../src/domain/orchestrator.js";
import { OrchestratorControllerDirectory } from "../../src/orchestration/orchestrator-controller-directory.js";

const PRIMARY = "11111111-1111-4111-8111-111111111111";
const PEER = "22222222-2222-4222-8222-222222222222";

function binding(sessionId: string, key: string, kind: "primary" | "peer"): OrchestratorBinding {
  return {
    key,
    kind,
    sessionId,
    provider: "claude",
    cwd: "/repo",
    sandbox: "workspace-write",
    scope: { kind: "fleet" },
    grant: { subjectSessionId: sessionId, capabilities: ["thread.read"], scope: { kind: "fleet" } },
    createdAt: "2026-10-07T10:00:00.000Z",
    updatedAt: "2026-10-07T10:00:00.000Z",
  };
}

describe("OrchestratorControllerDirectory", () => {
  const primary = binding(PRIMARY, "fleet", "primary");
  const peer = binding(PEER, `fleet:peer:${PEER}`, "peer");
  const directory = new OrchestratorControllerDirectory({
    list: async () => [primary, peer],
    findBySessionId: async (sessionId) => [primary, peer].find((entry) => entry.sessionId === sessionId),
  });

  it("maps a session to the controller the domain derives for its binding, and back", async () => {
    const expected = orchestratorController(peer);
    await expect(directory.forSession(PEER)).resolves.toEqual({
      controllerId: expected.controllerId,
      familyId: expected.familyId,
      sessionId: PEER,
    });
    await expect(directory.forController(expected.controllerId)).resolves.toMatchObject({ sessionId: PEER });
    await expect(directory.forController(orchestratorController(primary).controllerId))
      .resolves.toMatchObject({ sessionId: PRIMARY });
  });

  it("answers nothing for sessions and controllers it has no binding for", async () => {
    await expect(directory.forSession("33333333-3333-4333-8333-333333333333")).resolves.toBeUndefined();
    await expect(directory.forController("orchestrator:nowhere")).resolves.toBeUndefined();
  });

  it("lists primary and peer liveness owners using the total domain derivation", async () => {
    await expect(directory.listControllers()).resolves.toEqual([
      { controller: orchestratorController(primary), sessionId: PRIMARY },
      { controller: orchestratorController(peer), sessionId: PEER },
    ]);
  });
});
