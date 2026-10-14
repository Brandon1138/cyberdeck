import { describeBlockedModal } from "../../domain/modal-descriptor.js";
import { BLOCKED_PROMPT_TAIL_CHARS } from "../../domain/terminal-replay.js";
import { projectWorkerTruth, type ComposerObservation, type WorkerTruthInput } from "../../domain/worker-truth.js";
import type { WorkerInputReadiness } from "./worker-input-readiness.js";
import type { ReplayObservation } from "./worker-turn-ports.js";

export function projectWorkerTurnTruth(input: WorkerTruthInput & {
  terminalFinalizing: boolean;
  readiness: WorkerInputReadiness;
  nativeTurnSettled: boolean;
  deliveryHeld: boolean;
  frameText: string;
  scoutTransport?: string | undefined;
}) {
  const { terminalFinalizing, readiness, nativeTurnSettled, deliveryHeld, frameText, scoutTransport, ...truth } = input;
  if (terminalFinalizing) return projectWorkerTruth({
    executionState: "active", exitCode: null, activity: "working", composer: { modalOpen: false, occupied: false },
    completedTurns: truth.completedTurns, canonicalTurns: truth.canonicalTurns, pendingInstructions: truth.pendingInstructions,
  });
  return projectWorkerTruth({ ...truth,
    awaitingInputReady: scoutTransport !== "headless-stream-json" && readiness.pending && (!nativeTurnSettled || deliveryHeld),
    ...((!nativeTurnSettled || deliveryHeld) && readiness.stalledForSeconds !== undefined ? {
      startupStalledForSeconds: readiness.stalledForSeconds,
      startupEvidence: frameText.replace(/\s+/gu, " ").trim().slice(-240),
    } : {}),
  });
}

/** Answer from rendered rows: stripping cursor movement loses the boundaries that verify keys. */
export function observeWorkerModal(provider: string, composer: ComposerObservation,
  activity: WorkerTruthInput["activity"], replay: ReplayObservation, hasRuntime?: boolean) {
  if (hasRuntime === false || !composer.modalOpen && activity !== "needs-input") return undefined;
  return describeBlockedModal(provider, replay.modalFrameText?.() ?? replay.strippedTail(BLOCKED_PROMPT_TAIL_CHARS).text);
}
