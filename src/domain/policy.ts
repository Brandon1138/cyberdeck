import type { StartSessionRequest } from "./session.js";

export type StartPolicyCode =
  | "MAX_CONCURRENT_WORKERS"
  | "MAX_DELEGATION_DEPTH"
  | "FABLE_REQUIRES_EXPLICIT_HUMAN_START";

export type StartPolicyDecision =
  | { allowed: true }
  | {
    allowed: false;
    code: StartPolicyCode;
    activeWorkers?: number;
    maxConcurrentWorkers?: number;
  };

export interface SessionAncestryEntry {
  id: string;
  parentSessionId: string | undefined;
}

export interface StartPolicyContext {
  activeWorkerCount?: number;
  maxConcurrentWorkers?: number | null;
  maxDelegationDepth?: 1;
}

export function isFableModel(model: string | undefined): boolean {
  return model !== undefined && /(^|-)fable($|-)/i.test(model);
}

export type ClaudeLaunchSafetyCode = "CLAUDE_LAUNCH_REQUIRES_EXPLICIT_NON_FABLE_MODEL";

export type LaunchSafetyDecision =
  | { safe: true }
  | { safe: false; code: ClaudeLaunchSafetyCode };

/**
 * Live-launch safety gate, distinct from the neutral stored start policy in `evaluateStart`.
 *
 * A Claude launch with an omitted model may resolve to the native-default premium Fable model,
 * so at the boundary where a real Claude process is spawned an explicit ordinary non-Fable model
 * is required; both an omitted model and a Fable model are unsafe there. This governs live
 * launches only — `evaluateStart` deliberately keeps `model` optional in the neutral stored
 * contract. This function does not prevent native-default Fable on its own: it must be invoked at
 * the actual Claude launch boundary (a live process spawn) to have any effect.
 */
export function evaluateClaudeLaunchSafety(
  provider: string,
  model: string | undefined,
): LaunchSafetyDecision {
  if (provider !== "claude") return { safe: true };
  if (model === undefined || isFableModel(model)) {
    return { safe: false, code: "CLAUDE_LAUNCH_REQUIRES_EXPLICIT_NON_FABLE_MODEL" };
  }
  return { safe: true };
}

export function evaluateStart(
  request: StartSessionRequest,
  ancestry: readonly SessionAncestryEntry[],
  context: StartPolicyContext = {},
): StartPolicyDecision {
  const activeWorkerCount = context.activeWorkerCount ?? 0;
  const maxConcurrentWorkers = context.maxConcurrentWorkers === undefined
    ? 24
    : context.maxConcurrentWorkers;
  const maxDelegationDepth = context.maxDelegationDepth ?? 1;

  if (
    request.kind !== "orchestrator"
    && maxConcurrentWorkers !== null
    && activeWorkerCount >= maxConcurrentWorkers
  ) {
    return {
      allowed: false,
      code: "MAX_CONCURRENT_WORKERS",
      activeWorkers: activeWorkerCount,
      maxConcurrentWorkers,
    };
  }

  if (request.parentSessionId !== undefined && ancestry.length > maxDelegationDepth) {
    return { allowed: false, code: "MAX_DELEGATION_DEPTH" };
  }

  if (request.parentSessionId !== undefined && isFableModel(request.model)) {
    return { allowed: false, code: "FABLE_REQUIRES_EXPLICIT_HUMAN_START" };
  }

  return { allowed: true };
}
