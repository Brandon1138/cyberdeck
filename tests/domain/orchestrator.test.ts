import { describe, expect, it } from "vitest";
import {
  ORCHESTRATOR_GRANT_CAPABILITIES,
  OrchestratorBindingSchema,
  orchestratorController,
  peerOrchestratorKey,
  primaryOrchestratorKey,
  type OrchestratorBinding,
} from "../../src/domain/orchestrator.js";

const PRIMARY_SESSION = "11111111-1111-4111-8111-111111111111";
const PEER_SESSION = "22222222-2222-4222-8222-222222222222";
const PEER_KEY = peerOrchestratorKey("fleet", PEER_SESSION);

function record(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    key: "fleet",
    kind: "primary",
    sessionId: PRIMARY_SESSION,
    provider: "codex",
    cwd: "/repo",
    sandbox: "read-only",
    scope: { kind: "fleet" },
    grant: {
      subjectSessionId: PRIMARY_SESSION,
      capabilities: [...ORCHESTRATOR_GRANT_CAPABILITIES],
      scope: { kind: "fleet" },
    },
    createdAt: "2026-08-18T10:00:00.000Z",
    updatedAt: "2026-08-18T10:00:00.000Z",
    ...overrides,
  };
}

describe("OrchestratorBindingSchema", () => {
  /**
   * Bindings are an append-only log, so every record written before MIK-98 named its peer-ness
   * only in the key. Those records keep parsing, and read back as exactly what they always were.
   */
  it("reads a pre-MIK-98 record with no kind field, from its key", () => {
    const { kind: _dropped, ...legacyPrimary } = record();
    const { kind: _also, ...legacyPeer } = record({ key: PEER_KEY, sessionId: PEER_SESSION });

    expect(OrchestratorBindingSchema.parse(legacyPrimary).kind).toBe("primary");
    expect(OrchestratorBindingSchema.parse(legacyPeer).kind).toBe("peer");
  });

  it("keeps an explicit kind on a record that carries one", () => {
    const parsed = OrchestratorBindingSchema.parse(record({ key: PEER_KEY, kind: "peer" }));
    expect(parsed.kind).toBe("peer");
  });

  it("refuses a record whose kind contradicts its key", () => {
    expect(() => OrchestratorBindingSchema.parse(record({ key: PEER_KEY, kind: "primary" }))).toThrow();
    expect(() => OrchestratorBindingSchema.parse(record({ key: "fleet", kind: "peer" }))).toThrow();
  });
});

describe("orchestratorController", () => {
  const primary = OrchestratorBindingSchema.parse(record()) as OrchestratorBinding;
  const peer = OrchestratorBindingSchema.parse(
    record({ key: PEER_KEY, kind: "peer", sessionId: PEER_SESSION }),
  ) as OrchestratorBinding;

  it("names a primary by its scope key, as its own family", () => {
    expect(orchestratorController(primary)).toEqual({
      controllerId: "orchestrator:fleet",
      familyId: "orchestrator:fleet",
      scope: { kind: "fleet", scopeId: "fleet" },
    });
  });

  /**
   * MIK-98. A peer is a controller in its own right — its own id, so two peers of one scope cannot
   * take each other's leases — inside the family its scope's primary heads, so its workers belong
   * to an orchestrator family rather than to a conversation that ends.
   */
  it("gives a peer its own id inside its scope's family", () => {
    expect(orchestratorController(peer)).toEqual({
      controllerId: `orchestrator:${PEER_KEY}`,
      familyId: "orchestrator:fleet",
      scope: { kind: "fleet", scopeId: PEER_KEY },
    });
  });

  it("carries a workspace binding's own cwd, not one worker's", () => {
    const workspace = OrchestratorBindingSchema.parse(record({
      key: "workspace:/repo/one",
      scope: { kind: "workspace", cwd: "/repo/one" },
      grant: {
        subjectSessionId: PRIMARY_SESSION,
        capabilities: [...ORCHESTRATOR_GRANT_CAPABILITIES],
        scope: { kind: "workspace", cwd: "/repo/one" },
      },
    })) as OrchestratorBinding;

    expect(orchestratorController(workspace).scope).toEqual({
      kind: "worktree",
      scopeId: "workspace:/repo/one",
      worktreePath: "/repo/one",
    });
  });

  /**
   * The invariant the MIK-71 incident broke: a binding allowed to enqueue to a worker must be one
   * the lease substrate will honor as that worker's controller. One grant list, one total
   * derivation, so no binding can hold a capability its identity cannot back.
   */
  it("is total, so every granted binding has a lease identity", () => {
    for (const binding of [primary, peer]) {
      expect(binding.grant.capabilities).toEqual([...ORCHESTRATOR_GRANT_CAPABILITIES]);
      expect(binding.grant.capabilities).toContain("thread.enqueue");
      expect(orchestratorController(binding).controllerId).toBe(`orchestrator:${binding.key}`);
    }
  });
});

describe("peer keys", () => {
  it("round-trips a peer key back to the scope it was bound alongside", () => {
    expect(primaryOrchestratorKey(PEER_KEY)).toBe("fleet");
    expect(primaryOrchestratorKey("workspace:/repo/one")).toBe("workspace:/repo/one");
    expect(peerOrchestratorKey("workspace:/repo/one", PEER_SESSION))
      .toBe(`workspace:/repo/one:peer:${PEER_SESSION}`);
  });
});
