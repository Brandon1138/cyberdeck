import { describe, expect, it } from "vitest";
import { ORCHESTRATOR_GRANT_CAPABILITIES, OrchestratorBindingSchema, orchestratorController } from "../../src/domain/orchestrator.js";
import { STRIGOI_KEY, STRIGOI_LIMITS, StrigoiStateSchema, isStrigoiBinding } from "../../src/domain/strigoi.js";

const sessionId = "11111111-1111-4111-8111-111111111111";
const resident = {
  key: "resident:strigoi", kind: "resident", resident: { name: "strigoi", incarnation: 1 },
  sessionId, provider: "codex", cwd: "/repo", sandbox: "read-only", scope: { kind: "fleet" },
  grant: { subjectSessionId: sessionId, capabilities: [...ORCHESTRATOR_GRANT_CAPABILITIES], scope: { kind: "fleet" } },
  createdAt: "2026-11-14T10:00:00.000Z", updatedAt: "2026-11-14T10:00:00.000Z",
};
const state = {
  schemaVersion: 1, revision: 1, desired: "enabled", selection: { provider: "codex", model: "model", cwd: "/repo" },
  activeBinding: resident, incarnation: 1, activeGeneration: 1, retainedSessionIds: [sessionId], updatedAt: "2026-11-14T10:00:00.000Z",
};

describe("Strigoi identity and durable state", () => {
  it("uses a stable controller and family across sessions", () => {
    expect(STRIGOI_KEY).toBe("resident:strigoi");
    const first = OrchestratorBindingSchema.parse(resident);
    const nextId = "22222222-2222-4222-8222-222222222222";
    const next = OrchestratorBindingSchema.parse({ ...resident, sessionId: nextId, grant: { ...resident.grant, subjectSessionId: nextId }, resident: { name: "strigoi", incarnation: 2 } });
    expect(isStrigoiBinding(first)).toBe(true);
    expect(orchestratorController(first).controllerId).toBe("orchestrator:resident:strigoi");
    expect(orchestratorController(first).familyId).toBe("orchestrator:resident:strigoi");
    expect(orchestratorController(next)).toEqual(orchestratorController(first));
  });
  it("rejects malformed resident bindings", () => {
    for (const invalid of [{ key: "fleet" }, { scope: { kind: "workspace", cwd: "/repo" } }, { resident: undefined }, { resident: { name: "strigoi", incarnation: 0 } }]) {
      expect(OrchestratorBindingSchema.safeParse({ ...resident, ...invalid }).success).toBe(false);
    }
  });
  it.each(["primary", undefined])("reserves the resident key against kind %s", (kind) => {
    expect(OrchestratorBindingSchema.safeParse({ ...resident, kind, resident: undefined }).success).toBe(false);
  });
  it("requires state and transition to share a current incarnation", () => {
    const successorId = "22222222-2222-4222-8222-222222222222";
    const transition = { id: "t", expectedIncarnation: 1, reason: "renew", phase: "launching", attempts: 0,
      predecessor: { sessionId, incarnation: 1, generation: 1 }, successor: { sessionId: successorId, incarnation: 2, generation: 1 } };
    const unrelated = { ...transition, expectedIncarnation: 99, predecessor: { ...transition.predecessor, incarnation: 99 }, successor: { ...transition.successor, incarnation: 100 } };
    expect(StrigoiStateSchema.safeParse({ ...state, transition: unrelated }).success).toBe(false);
    expect(StrigoiStateSchema.safeParse({ ...state, activeBinding: undefined, transition: unrelated }).success).toBe(false);
    expect(StrigoiStateSchema.safeParse({ ...state, transition }).success).toBe(true);
    const activeBinding = { ...resident, sessionId: successorId, grant: { ...resident.grant, subjectSessionId: successorId }, resident: { name: "strigoi", incarnation: 2 } };
    expect(StrigoiStateSchema.safeParse({ ...state, incarnation: 2, activeBinding, transition }).success).toBe(true);
    expect(StrigoiStateSchema.safeParse({ ...state, incarnation: 2, activeBinding: { ...activeBinding, sessionId, grant: { ...activeBinding.grant, subjectSessionId: sessionId } }, transition }).success).toBe(false);
  });
  it("validates state identity, selection, transitions and packet hashes", () => {
    expect(StrigoiStateSchema.safeParse(state).success).toBe(true);
    const packet = { artifactId: "p", coverageId: "c", sha256: "a".repeat(64) };
    const transition = { id: "t", expectedIncarnation: 1, reason: "renew", phase: "launching", attempts: 0,
      predecessor: { sessionId, incarnation: 1, generation: 1 }, successor: { sessionId: "22222222-2222-4222-8222-222222222222", incarnation: 2, generation: 2 }, packet };
    expect(StrigoiStateSchema.safeParse({ ...state, transition, latestPacket: packet }).success).toBe(true);
    for (const invalid of [
      { selection: undefined }, { incarnation: 2 }, { activeGeneration: undefined }, { activeGeneration: 0 }, { activeBinding: { ...resident, key: "fleet" } },
      { latestPacket: { ...packet, sha256: "bad" } },
      { transition: { ...transition, successor: { ...transition.successor, incarnation: 1 } } },
      { transition: { ...transition, predecessor: { ...transition.predecessor, generation: 0 } } },
      { transition: { ...transition, predecessor: { ...transition.predecessor, generation: 2 } } },
      { transition: { ...transition, predecessor: { ...transition.predecessor, sessionId: transition.successor.sessionId } } },
    ]) expect(StrigoiStateSchema.safeParse({ ...state, ...invalid }).success).toBe(false);
  });
  it("exports transport limits", () => {
    expect(Object.values(STRIGOI_LIMITS)).toEqual(expect.arrayContaining([32768, 262144, 64]));
  });
});
