import {
  modalAnswerKeySequence,
  type ModalAnswerAttempt,
  type WorkerModalDescriptor,
} from "../../domain/modal-descriptor.js";

/**
 * Press one enumerated answer against the live descriptor rather than the caller's copy.
 * The fingerprint pins the answer to the current dialog; key bytes come only from the domain's
 * static table. There is no path from caller text to the PTY.
 */
export function answerWorkerModal(
  provider: string,
  descriptor: WorkerModalDescriptor | undefined,
  request: { fingerprint: string; answer: string },
  effects: { write: (keys: Buffer) => void; resetStallObservation: () => void },
): ModalAnswerAttempt {
  if (descriptor === undefined) return { status: "no-modal" };
  if (descriptor.kind === "unknown" || descriptor.answers.length === 0) {
    return { status: "unrecognized", descriptor };
  }
  if (descriptor.fingerprint !== request.fingerprint) {
    return { status: "fingerprint-mismatch", descriptor };
  }
  const answer = descriptor.answers.find((option) => option.id === request.answer);
  const keys = answer === undefined
    ? undefined
    : modalAnswerKeySequence(provider, descriptor.kind, answer.id);
  if (answer === undefined || keys === undefined) {
    return { status: "unsupported-answer", descriptor };
  }
  effects.write(keys);
  // The press may start a turn (plan-confirm) or merely clear a gate (trust). Either way the
  // stall clock restarts from the keypress, exactly as it does for a submitted instruction.
  effects.resetStallObservation();
  return { status: "pressed", descriptor, answer };
}
