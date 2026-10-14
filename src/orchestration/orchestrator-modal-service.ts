import { randomUUID } from "node:crypto";
import { z } from "zod";
import { grantAllows } from "../domain/capability.js";
import type { BrokerEvent } from "../domain/events.js";
import type { ModalAnswerPolicy } from "./modal-answer-policy.js";
import type { OrchestratorBindingReader, SessionLookupPort, SessionProcessControlPort, WorkerTruthQueryPort } from "./session/session-ports.js";

export const AnswerOrchestratorModalParamsSchema = z.object({
  actorSessionId: z.uuid(), targetSessionId: z.uuid(),
  fingerprint: z.string().min(8).max(64), answer: z.string().min(1).max(64),
  reason: z.string().trim().min(1).max(500),
});

/** A peer is a bound orchestrator, not a worker lease subject. Reuse its existing input grant. */
export async function answerOrchestratorModal(
  input: z.input<typeof AnswerOrchestratorModalParamsSchema>,
  deps: {
    registry: SessionLookupPort & SessionProcessControlPort & Pick<WorkerTruthQueryPort, "workerTruth">;
    bindings: OrchestratorBindingReader;
    policy?: Pick<ModalAnswerPolicy, "evaluate">;
    audit?: { append(event: BrokerEvent): Promise<void> };
  },
) {
  const request = AnswerOrchestratorModalParamsSchema.parse(input);
  const base = { targetSessionId: request.targetSessionId };
  const binding = await deps.bindings.findBySessionId(request.actorSessionId);
  let actor, target;
  try { actor = deps.registry.get(request.actorSessionId); target = deps.registry.get(request.targetSessionId); }
  catch { return { ...base, code: "DENIED", detail: "Actor or target session is missing" }; }
  if (binding === undefined || actor.kind !== "orchestrator" || actor.executionState !== "active" || actor.exitCode !== null) {
    return { ...base, code: "DENIED", detail: "Actor is not an active bound orchestrator" };
  }
  if (target.kind !== "orchestrator" || await deps.bindings.findBySessionId(target.id) === undefined
    || !grantAllows(binding.grant, "thread.enqueue", target)) {
    return { ...base, code: "DENIED", detail: "Target is outside this orchestrator's input grant" };
  }
  if (target.executionState !== "active" || target.exitCode !== null) return { ...base, code: "MODAL_NOT_PRESENT", detail: "Target is terminal" };
  const truth = deps.registry.workerTruth(target.id);
  const modal = truth.modal;
  if (truth.state !== "blocked-modal" || modal === undefined) return { ...base, code: "MODAL_NOT_PRESENT" };
  if (modal.kind === "unknown" || modal.answers.length === 0) return { ...base, code: "MODAL_UNRECOGNIZED", modal };
  if (modal.fingerprint !== request.fingerprint) return { ...base, code: "MODAL_MISMATCH", modal };
  if (!modal.answers.some(({ id }) => id === request.answer)) return { ...base, code: "MODAL_ANSWER_UNSUPPORTED", modal };
  const policyInput = { cwd: target.cwd, kind: modal.kind, sessionId: target.id,
    answer: request.answer, fingerprint: modal.fingerprint, evidence: modal.evidence };
  const decision = await deps.policy?.evaluate(policyInput);
  if (decision?.allowed !== true) return { ...base, code: "MODAL_POLICY_DENIED", modal,
    detail: decision?.reason ?? "This broker has no modal answer policy configured" };
  if (deps.audit === undefined) return { ...base, code: "DENIED", detail: "Modal answer audit is unavailable" };
  const auditData = { actorSessionId: actor.id, targetSessionId: target.id, fingerprint: request.fingerprint,
    answer: request.answer, kind: modal.kind, reason: request.reason };
  await deps.audit.append({ id: randomUUID(), type: "orchestrator.modal_answer.requested", sessionId: target.id,
    occurredAt: new Date().toISOString(), data: auditData });
  // The runtime rechecks the fingerprint immediately before selecting its static key sequence.
  const attempt = await deps.registry.answerWorkerModal(target.id, request.fingerprint, request.answer);
  const warnings: string[] = [];
  await deps.audit.append({ id: randomUUID(), type: "orchestrator.modal_answer.result", sessionId: target.id,
    occurredAt: new Date().toISOString(), data: { ...auditData, status: attempt.status } }).catch(() => {
    warnings.push("The modal answer result could not be journaled; inspect the current prompt before retrying");
  });
  const code = { pressed: "PRESSED", "no-modal": "MODAL_NOT_PRESENT", unrecognized: "MODAL_UNRECOGNIZED",
    "fingerprint-mismatch": "MODAL_MISMATCH", "unsupported-answer": "MODAL_ANSWER_UNSUPPORTED" }[attempt.status];
  return { ...base, code, ...attempt, ...(warnings.length === 0 ? {} : { warnings }) };
}
