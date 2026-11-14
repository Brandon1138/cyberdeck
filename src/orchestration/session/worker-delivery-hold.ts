import type { DeliveryHoldReason } from "../../domain/worker-truth.js";
import type { ProviderTerminalActivity } from "./worker-turn-ports.js";

/** Name the exact gate. Presentation's Idle label is never an admission decision. */
export function workerDeliveryHold(input: {
  active: boolean; modal: boolean; occupied: boolean; launch: boolean; rendered: boolean;
  commit?: { poisoned: boolean }; retiring: boolean; retirementFailed: boolean;
  deferred: number; captured: number; nativeRefused: boolean; nativeAvailable: boolean;
  activity: ProviderTerminalActivity; observedWorking: boolean; starting: boolean;
}): DeliveryHoldReason | undefined {
  if (!input.active) return "worker-terminal";
  if (input.modal) return "provider-modal";
  if (input.occupied) return "composer-occupied";
  if (input.commit?.poisoned) return "completion-commit-failed";
  if (input.retirementFailed) return "input-retirement-failed";
  if (input.commit !== undefined) return "completion-commit-pending";
  if (input.retiring) return "input-retirement-pending";
  if (input.launch) return "launch-pending";
  if (input.rendered) return "input-consumption-pending";
  // A deferred screen end owns an ordinal until its exact evidence is accounted for.
  if (input.deferred > input.captured) return "completion-evidence-pending";
  if (input.nativeRefused) return "native-evidence-unavailable";
  if (input.activity === "working" || input.observedWorking) return "provider-busy";
  if (input.nativeAvailable && input.activity === "unknown") return "native-evidence-unavailable";
  if (input.starting) return "provider-starting";
  return undefined;
}
