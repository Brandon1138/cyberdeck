import { describe, expect, it } from "vitest";
import {
  ORCHESTRATOR_GRANT_CAPABILITIES,
  OrchestratorBindingSchema,
  orchestratorController,
  peerOrchestratorKey,
  primaryOrchestratorKey,
  type OrchestratorBinding,
} from "../../src/domain/orchestrator.js";
import { ControllerIdentitySchema } from "../../src/domain/worker-coordination.js";

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
  it("reads a pre-MIK-98 primary record with no kind field", () => {
    const { kind: _dropped, ...legacyPrimary } = record();

    expect(OrchestratorBindingSchema.parse(legacyPrimary).kind).toBe("primary");
  });

  it("still classifies a pre-MIK-98 peer from its exact session-id suffix", () => {
    const { kind: _dropped, ...legacyPeer } = record({
      key: PEER_KEY,
      sessionId: PEER_SESSION,
    });

    expect(OrchestratorBindingSchema.parse(legacyPeer).kind).toBe("peer");
  });

  it("does not mistake marker text in a legacy primary's cwd for a peer suffix", () => {
    const { kind: _dropped, ...legacyPrimary } = record({
      key: "workspace:/tmp/repo:peer:archive",
    });

    expect(OrchestratorBindingSchema.parse(legacyPrimary).kind).toBe("primary");
  });

  it("treats an explicit persisted kind as authoritative", () => {
    const explicitPrimary = OrchestratorBindingSchema.parse(record({
      key: PEER_KEY,
      kind: "primary",
    }));

    expect(explicitPrimary.kind).toBe("primary");
    expect(orchestratorController(explicitPrimary).familyId).toBe(`orchestrator:${PEER_KEY}`);
  });

  it("refuses an explicit peer whose key lacks its structural session suffix", () => {
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

  it("bounds long workspace peer identities while preserving deterministic round-trips", () => {
    const cwd = `/${"long-workspace-segment/".repeat(12)}repository`;
    const primaryKey = `workspace:${cwd}`;
    const peerKey = peerOrchestratorKey(primaryKey, PEER_SESSION);
    const longPeer = OrchestratorBindingSchema.parse(record({
      key: peerKey,
      kind: "peer",
      sessionId: PEER_SESSION,
      cwd,
      scope: { kind: "workspace", cwd },
      grant: {
        subjectSessionId: PEER_SESSION,
        capabilities: [...ORCHESTRATOR_GRANT_CAPABILITIES],
        scope: { kind: "workspace", cwd },
      },
    })) as OrchestratorBinding;

    expect(`orchestrator:${peerKey}`.length).toBeGreaterThan(256);
    const first = orchestratorController(longPeer);
    const second = orchestratorController(longPeer);
    expect(first).toEqual(second);
    expect(first.controllerId.length).toBeLessThanOrEqual(256);
    expect(first.familyId.length).toBeLessThanOrEqual(256);
    expect(first.scope.scopeId.length).toBeLessThanOrEqual(256);
    expect(ControllerIdentitySchema.parse(first)).toEqual(first);
  });

  it("keeps existing short controller ids byte-for-byte unchanged", () => {
    expect(orchestratorController(primary).controllerId).toBe("orchestrator:fleet");
    expect(orchestratorController(peer).controllerId).toBe(`orchestrator:${PEER_KEY}`);
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
    expect(primaryOrchestratorKey("workspace:/tmp/repo:peer:archive"))
      .toBe("workspace:/tmp/repo:peer:archive");
    expect(peerOrchestratorKey("workspace:/repo/one", PEER_SESSION))
      .toBe(`workspace:/repo/one:peer:${PEER_SESSION}`);
    const markerPathPeer = peerOrchestratorKey("workspace:/tmp/repo:peer:archive", PEER_SESSION);
    expect(primaryOrchestratorKey(markerPathPeer)).toBe("workspace:/tmp/repo:peer:archive");
  });
});
