import type { StartSessionRequest } from "./session.js";
import { DEFAULT_MAX_CONCURRENT_WORKERS } from "../limits.js";

export type StartPolicyCode =
  | "MAX_CONCURRENT_WORKERS"
  | "MAX_DELEGATION_DEPTH";

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

export type ClaudeLaunchSafetyCode = "CLAUDE_LAUNCH_REQUIRES_EXPLICIT_MODEL";

export type LaunchSafetyDecision =
  | { safe: true }
  | { safe: false; code: ClaudeLaunchSafetyCode };

/**
 * Live-launch safety gate, distinct from the neutral stored start policy in `evaluateStart`.
 *
 * A Claude launch with an omitted model may resolve to the provider-native default, which the
 * operator did not explicitly select. At the real process boundary Cyberdeck therefore requires
 * an explicit model string. An explicitly named Fable model is safe on an operator launch path;
 * autonomous Fable delegation is governed separately by the orchestrator's `worker.start.fable`
 * capability.
 */
export function evaluateClaudeLaunchSafety(
  provider: string,
  model: string | undefined,
): LaunchSafetyDecision {
  if (provider !== "claude") return { safe: true };
  if (model === undefined) {
    return { safe: false, code: "CLAUDE_LAUNCH_REQUIRES_EXPLICIT_MODEL" };
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
    ? DEFAULT_MAX_CONCURRENT_WORKERS
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

  return { allowed: true };
}
