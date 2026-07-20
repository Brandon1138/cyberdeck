import type { StartSessionRequest } from "./session.js";

export type StartPolicyCode =
  | "MAX_CONCURRENT_SESSIONS"
  | "MAX_DELEGATION_DEPTH"
  | "FABLE_REQUIRES_EXPLICIT_HUMAN_START";

export type StartPolicyDecision =
  | { allowed: true }
  | { allowed: false; code: StartPolicyCode };

export interface SessionAncestryEntry {
  id: string;
  parentSessionId: string | undefined;
}

export interface StartPolicyContext {
  activeSessionCount?: number;
  maxConcurrentSessions?: number;
  maxDelegationDepth?: 1;
}

export function isFableModel(model: string | undefined): boolean {
  return model !== undefined && /(^|-)fable($|-)/i.test(model);
}

export function evaluateStart(
  request: StartSessionRequest,
  ancestry: readonly SessionAncestryEntry[],
  context: StartPolicyContext = {},
): StartPolicyDecision {
  const activeSessionCount = context.activeSessionCount ?? 0;
  const maxConcurrentSessions = context.maxConcurrentSessions ?? 4;
  const maxDelegationDepth = context.maxDelegationDepth ?? 1;

  if (activeSessionCount >= maxConcurrentSessions) {
    return { allowed: false, code: "MAX_CONCURRENT_SESSIONS" };
  }

  if (request.parentSessionId !== undefined && ancestry.length > maxDelegationDepth) {
    return { allowed: false, code: "MAX_DELEGATION_DEPTH" };
  }

  if (request.parentSessionId !== undefined && isFableModel(request.model)) {
    return { allowed: false, code: "FABLE_REQUIRES_EXPLICIT_HUMAN_START" };
  }

  return { allowed: true };
}
