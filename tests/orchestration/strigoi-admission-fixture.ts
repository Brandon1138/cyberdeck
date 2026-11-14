import { StrigoiAdmission } from "../../src/orchestration/strigoi-admission.js";
import type { StrigoiState } from "../../src/domain/strigoi.js";
import type { InstructionRecord } from "../../src/domain/instruction.js";
import type { SessionRecord } from "../../src/domain/session.js";

export const actor = "11111111-1111-4111-8111-111111111111";
export const target = "22222222-2222-4222-8222-222222222222";
export const successor = "33333333-3333-4333-8333-333333333333";
export const at = "2026-11-14T10:00:00.000Z";
export const identity = { sessionId: actor, incarnation: 1, generation: 1 };
export function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
export function fixture() {
  let state: StrigoiState = { schemaVersion: 1, revision: 1, desired: "enabled", incarnation: 1,
    activeGeneration: 1, retainedSessionIds: [actor], updatedAt: at,
    selection: { provider: "codex", model: "test", cwd: "/repo" },
    activeBinding: { key: "resident:strigoi", kind: "resident", sessionId: actor,
      resident: { name: "strigoi", incarnation: 1 }, provider: "codex", cwd: "/repo", sandbox: "read-only",
      scope: { kind: "fleet" }, grant: { subjectSessionId: actor, capabilities: ["thread.enqueue", "thread.read", "worker.start", "workflow.run", "orchestrator.create"], scope: { kind: "fleet" } },
      createdAt: at, updatedAt: at } };
  const repository = { read: async () => structuredClone(state), retentionPins: async () => new Set([actor, successor]) };
  const bindings = { findBySessionId: async (id: string) => state.activeBinding?.sessionId === id ? structuredClone(state.activeBinding) : undefined };
  const registry = { get: (id: string) => ({ id, generation: 1, cwd: "/repo", provider: "codex", detached: true, sandbox: "read-only", attachmentState: "detached", pid: 1, kind: id === actor ? "orchestrator" : "worker", executionState: "active", exitCode: null, childIds: [], createdAt: at, updatedAt: at } as SessionRecord) };
  const admission = new StrigoiAdmission(repository, bindings, registry);
  const record = { id: target, actorSessionId: actor, targetSessionId: target, messageId: target,
    message: "hello", status: "accepted", createdAt: at, updatedAt: at, hop: 0 } as InstructionRecord;
  return { admission, repository, bindings, registry, record, state: () => state, set: (next: StrigoiState) => { state = next; } };
}

