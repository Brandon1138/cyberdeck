import { describe, expect, it, vi } from "vitest";
import { describeBlockedModal } from "../../src/domain/modal-descriptor.js";
import type { BrokerEvent } from "../../src/domain/events.js";
import type { OrchestratorBinding } from "../../src/domain/orchestrator.js";
import type { SessionRecord } from "../../src/domain/session.js";
import { ModalAnswerPolicy } from "../../src/orchestration/modal-answer-policy.js";
import { answerOrchestratorModal } from "../../src/orchestration/orchestrator-modal-service.js";
import { CLAUDE_TRUST, CODEX_HOOK_REVIEW } from "../fixtures/provider-startup-dialogs.js";

const ACTOR = "11111111-1111-4111-8111-111111111111";
const TARGET = "22222222-2222-4222-8222-222222222222";
const at = "2026-10-13T09:00:00.000Z";
const record: SessionRecord = { id: TARGET, provider: "claude", kind: "orchestrator", cwd: "/repo", detached: true,
  sandbox: "workspace-write", approvalMode: "auto", executionState: "active", attachmentState: "detached",
  pid: 123, exitCode: null, childIds: [], createdAt: at, updatedAt: at };
const binding: OrchestratorBinding = { key: `fleet:peer:${ACTOR}`, kind: "peer", sessionId: ACTOR,
  provider: "codex", cwd: "/repo", sandbox: "workspace-write", scope: { kind: "fleet" },
  grant: { subjectSessionId: ACTOR, capabilities: ["thread.enqueue"], scope: { kind: "fleet" } }, createdAt: at, updatedAt: at };

function harness(allowed = true, provider = "claude", text = CLAUDE_TRUST) {
  let modal = describeBlockedModal(provider, text);
  const records = new Map([[ACTOR, { ...record, id: ACTOR }], [TARGET, { ...record }]]);
  const targetBinding = { ...binding, key: `fleet:peer:${TARGET}`, sessionId: TARGET };
  const findBySessionId = vi.fn(async (id: string) => id === ACTOR ? binding : targetBinding);
  const press = vi.fn(async (_id: string, fingerprint: string, answer: string) =>
    fingerprint === modal.fingerprint ? { status: "pressed" as const, descriptor: modal, answer: modal.answers.find(({ id }) => id === answer)! }
      : { status: "fingerprint-mismatch" as const, descriptor: modal });
  const append = vi.fn(async (_event: BrokerEvent) => undefined);
  const policy = new ModalAnswerPolicy({ grants: { allowsRoot: async () => allowed },
    probe: { gitCommonDirectory: async () => "/repo/.git", primaryWorktree: async () => "/repo" }, canonicalize: async (path) => path });
  const deps = { registry: { get: (id: string) => records.get(id)!, answerWorkerModal: press,
    workerTruth: () => ({ state: "blocked-modal" as const, modal, completedTurns: 0, canonicalTurns: 0,
      pendingInstructions: 0, composerOccupied: false, modalOpen: true, terminal: false, detail: "Startup prompt" }) } as never,
    bindings: { findBySessionId }, policy, audit: { append } };
  const input = { actorSessionId: ACTOR, targetSessionId: TARGET, fingerprint: modal.fingerprint, answer: "trust", reason: "Approved repository startup" };
  return { deps, input, press, append, records, findBySessionId, replace: () => {
    modal = describeBlockedModal("claude", CLAUDE_TRUST.replace("/Users/op/repos/api/worktrees/fix-races", "/a/different/folder"));
  } };
}

describe("orchestrator startup modal answers", () => {
  it.each([true, false])("uses the shared hook policy for a bound peer, granted=%s", async (granted) => {
    const h = harness(granted, "codex", CODEX_HOOK_REVIEW);
    expect(await answerOrchestratorModal({ ...h.input, answer: "continue-without-hooks" }, h.deps))
      .toMatchObject({ code: granted ? "PRESSED" : "MODAL_POLICY_DENIED" });
    expect(h.press).toHaveBeenCalledTimes(granted ? 1 : 0);
    h.press.mockClear();
    expect(await answerOrchestratorModal({ ...h.input, answer: "trust-all" }, h.deps)).toMatchObject({ code: "MODAL_ANSWER_UNSUPPORTED" });
    expect(h.press).not.toHaveBeenCalled();
  });
  it("lets a bound peer use its existing input grant and the common repository policy without a worker lease", async () => {
    const h = harness();
    expect(await answerOrchestratorModal(h.input, h.deps)).toMatchObject({ code: "PRESSED", status: "pressed" });
    expect(h.press).toHaveBeenCalledWith(TARGET, h.input.fingerprint, "trust");
    expect(h.append.mock.calls.map(([event]) => event.type)).toEqual(["orchestrator.modal_answer.requested", "orchestrator.modal_answer.result"]);
    expect(h.append.mock.calls[0]![0].data).toMatchObject({ actorSessionId: ACTOR, targetSessionId: TARGET, answer: "trust" });
  });
  it("denies an ungranted repository before any press", async () => {
    const h = harness(false);
    expect(await answerOrchestratorModal(h.input, h.deps)).toMatchObject({ code: "MODAL_POLICY_DENIED" });
    expect(h.press).not.toHaveBeenCalled();
  });
  it("rejects arbitrary key text and stale fingerprints", async () => {
    const h = harness();
    expect(await answerOrchestratorModal({ ...h.input, answer: "1\nrun a command" }, h.deps)).toMatchObject({ code: "MODAL_ANSWER_UNSUPPORTED" });
    h.replace();
    expect(await answerOrchestratorModal(h.input, h.deps)).toMatchObject({ code: "MODAL_MISMATCH" });
    expect(h.press).not.toHaveBeenCalled();
  });
  it("rechecks the exact prompt after policy and audit await boundaries", async () => {
    const h = harness(); h.append.mockImplementationOnce(async () => { h.replace(); });
    expect(await answerOrchestratorModal(h.input, h.deps)).toMatchObject({ code: "MODAL_MISMATCH", status: "fingerprint-mismatch" });
  });
  it("denies an inactive actor and worker target", async () => {
    const h = harness(); h.records.get(ACTOR)!.executionState = "cancelled";
    expect(await answerOrchestratorModal(h.input, h.deps)).toMatchObject({ code: "DENIED" });
    h.records.get(ACTOR)!.executionState = "active"; h.records.get(TARGET)!.kind = "worker";
    expect(await answerOrchestratorModal(h.input, h.deps)).toMatchObject({ code: "DENIED" });
    expect(h.press).not.toHaveBeenCalled();
  });
  it("fails before pressing if the durable request audit fails", async () => {
    const h = harness(); h.append.mockRejectedValueOnce(new Error("disk full"));
    await expect(answerOrchestratorModal(h.input, h.deps)).rejects.toThrow("disk full");
    expect(h.press).not.toHaveBeenCalled();
  });
  it("reports the actual press if only the result audit fails", async () => {
    const h = harness(); h.append.mockImplementationOnce(async () => undefined).mockRejectedValueOnce(new Error("disk full"));
    expect(await answerOrchestratorModal(h.input, h.deps)).toMatchObject({ code: "PRESSED", warnings: [expect.stringContaining("could not be journaled")] });
    expect(h.press).toHaveBeenCalledOnce();
  });
});
