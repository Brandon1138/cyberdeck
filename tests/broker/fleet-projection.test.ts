import { describe, expect, it } from "vitest";
import { fleetOrchestratorOwnership } from "../../src/broker/worker-coordination-view.js";
import { ORCHESTRATOR_GRANT_CAPABILITIES, type OrchestratorBinding } from "../../src/domain/orchestrator.js";

const CREATOR = "11111111-1111-4111-8111-111111111111";
const PEER = "22222222-2222-4222-8222-222222222222";
const now = "2026-10-08T12:00:00.000Z";
const primary: OrchestratorBinding = {
  key: "fleet", kind: "primary", sessionId: CREATOR, provider: "claude", model: "fable",
  cwd: "/repo", sandbox: "read-only", scope: { kind: "fleet" },
  grant: { subjectSessionId: CREATOR, capabilities: [...ORCHESTRATOR_GRANT_CAPABILITIES], scope: { kind: "fleet" } },
  createdAt: now, updatedAt: now,
};

function peer(createdBy?: OrchestratorBinding["createdBy"]): OrchestratorBinding {
  return {
    ...primary, key: `fleet:peer:${PEER}`, kind: "peer", sessionId: PEER,
    grant: { ...primary.grant, subjectSessionId: PEER },
    ...(createdBy === undefined ? {} : { createdBy }),
  };
}

describe("Fleet orchestrator ownership projection", () => {
  it("projects only the peer creator sessionId, without approval or mutation metadata", () => {
    const binding = peer({
      sessionId: CREATOR, mutationId: "private-mutation", depth: 1,
      approval: { kind: "per-create", quote: "yes, create a peer", channel: "terminal" },
    });
    expect(fleetOrchestratorOwnership([primary, binding])).toEqual([
      { sessionId: CREATOR, controllerId: "orchestrator:fleet" },
      { sessionId: PEER, controllerId: `orchestrator:fleet:peer:${PEER}`, createdBy: { sessionId: CREATOR } },
    ]);
  });

  it("projects legacy peer lineage without requiring approval or depth", () => {
    expect(fleetOrchestratorOwnership([peer({ sessionId: CREATOR })])[0])
      .toHaveProperty("createdBy", { sessionId: CREATOR });
  });

  it("omits creator markers for primaries and peers created by hand", () => {
    for (const entry of fleetOrchestratorOwnership([
      { ...primary, createdBy: { sessionId: CREATOR } }, peer(),
    ])) expect(entry).not.toHaveProperty("createdBy");
  });
});
