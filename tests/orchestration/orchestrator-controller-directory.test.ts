import { describe, expect, it } from "vitest";
import { orchestratorController, type OrchestratorBinding } from "../../src/domain/orchestrator.js";
import { OrchestratorControllerDirectory } from "../../src/orchestration/orchestrator-controller-directory.js";
import { OrchestratorPeerService } from "../../src/orchestration/orchestrator-peer-service.js";
import type { SessionRecord } from "../../src/domain/session.js";

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

describe("resident controller directory", () => {
  it("maps the current resident session to its stable identity", async () => {
    const resident: OrchestratorBinding = { ...binding(PRIMARY, "resident:strigoi", "primary"), kind: "resident", resident: { name: "strigoi", incarnation: 1 } };
    const directory = new OrchestratorControllerDirectory({ list: async () => [resident], findBySessionId: async (id) => id === PRIMARY ? resident : undefined });
    const expected = { controllerId: "orchestrator:resident:strigoi", familyId: "orchestrator:resident:strigoi", sessionId: PRIMARY, resident: true };
    await expect(directory.forSession(PRIMARY)).resolves.toEqual(expected);
    await expect(directory.forController("orchestrator:resident:strigoi")).resolves.toEqual(expected);
  });

  it("uses the resident grant and Fleet peer-create switch for admission", async () => {
    const resident: OrchestratorBinding = { ...binding(PRIMARY, "resident:strigoi", "primary"), kind: "resident", resident: { name: "strigoi", incarnation: 1 }, grant: { subjectSessionId: PRIMARY, capabilities: ["orchestrator.create", "thread.read"], scope: { kind: "fleet" } } };
    const fleet = { ...binding(PEER, "fleet", "primary"), grant: { subjectSessionId: PEER, capabilities: ["orchestrator.create"] as OrchestratorBinding["grant"]["capabilities"], scope: { kind: "fleet" as const } } };
    let actor = resident;
    const requests: unknown[] = [];
    const service = new OrchestratorPeerService({
      registry: { get: () => ({ id: PRIMARY, kind: "orchestrator", executionState: "active", exitCode: null }) as SessionRecord },
      bindings: { list: async () => [actor, fleet], findBySessionId: async () => actor, get: async (key) => key === "fleet" ? fleet : undefined },
      manager: { createPeer: async (input) => { requests.push(input); throw new Error("test launch"); } },
    });
    const request = { actorSessionId: PRIMARY, provider: "codex" as const, model: "model", cwd: "/repo", reason: "test", approval: { kind: "per-create" as const, quote: "yes", channel: "fleet" as const } };
    await expect(service.create(request)).resolves.toMatchObject({ outcome: "LAUNCH_FAILED" });
    expect(requests).toMatchObject([{ scope: "fleet", capabilities: ["orchestrator.create", "thread.read"] }]);
    fleet.grant.capabilities = [];
    await expect(service.create(request)).resolves.toMatchObject({ outcome: "DENIED", code: "SCOPE_PEER_CREATE_OFF" });
    fleet.grant.capabilities = ["orchestrator.create"];
    actor = { ...resident, grant: { ...resident.grant, capabilities: ["thread.read"] } };
    await expect(service.create(request)).resolves.toMatchObject({ outcome: "DENIED", code: "CAPABILITY_DENIED" });
    await expect(service.create({ ...request, approval: undefined })).resolves.toMatchObject({ outcome: "APPROVAL_REQUIRED" });
    expect(requests).toHaveLength(1);
  });
});
