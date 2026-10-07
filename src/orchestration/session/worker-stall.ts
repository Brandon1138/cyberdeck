import type { WorkerStallReason } from "../../domain/worker-truth.js";
import { CURSOR_STALL_TOKEN_PROGRESS, CURSOR_WORKING_STALL_MULTIPLIER } from "../../limits.js";
import type { StallObservation, StallReading, WorkingStallObservation } from "./worker-turn-state.js";

/**
 * Both stall clocks for one worker generation.
 *
 * The idle clock ages while the PTY is byte-quiet — its version check resets on every chunk, which
 * is correct for a provider that stops printing when it hangs. The working clock exists because a
 * frozen Cursor session never goes byte-quiet: the TUI keeps repainting a status line whose token
 * counter barely moves, so only token *progress* can distinguish a live turn from a freeze.
 */
export interface StallObservations {
  idle?: StallObservation;
  working?: WorkingStallObservation;
}

export interface StallObservationInput {
  provider: string;
  activity: string;
  tokenCount: number | undefined;
  version: number;
  nowMs: number;
}

/** Fold the current replay reading into both clocks. Mutates `observations` in place. */
export function observeStall(observations: StallObservations, input: StallObservationInput): void {
  const { tokenCount, version, nowMs } = input;
  if (tokenCount === undefined) {
    delete observations.idle;
    delete observations.working;
    return;
  }
  const idle = observations.idle;
  if (idle === undefined || idle.version !== version || idle.tokenCount !== tokenCount) {
    observations.idle = { version, tokenCount, unchangedSinceMs: nowMs };
  }
  // Only Cursor gets the working-state clock: it is the one provider whose freeze keeps the PTY
  // chatty, and the one with no native transcript to contradict the screen. A Claude or Codex
  // turn that goes token-quiet while a long tool runs must never trip this.
  if (input.provider !== "cursor" || input.activity !== "working") {
    delete observations.working;
    return;
  }
  const working = observations.working;
  if (
    working === undefined
    || tokenCount < working.tokenCount
    || tokenCount - working.tokenCount >= CURSOR_STALL_TOKEN_PROGRESS
  ) {
    observations.working = { tokenCount, unchangedSinceMs: nowMs };
  }
}

export interface StallReadingInput {
  active: boolean;
  activity: string;
  workerStallSeconds: number;
  nowMs: number;
}

/** The stall verdict both clocks currently support, or undefined while the worker looks alive. */
export function readStall(
  observations: StallObservations,
  input: StallReadingInput,
): StallReading | undefined {
  if (!input.active) return undefined;
  const working = observations.working;
  if (working !== undefined && input.activity === "working") {
    const stalledForSeconds = Math.floor((input.nowMs - working.unchangedSinceMs) / 1_000);
    if (stalledForSeconds >= input.workerStallSeconds * CURSOR_WORKING_STALL_MULTIPLIER) {
      return {
        stalledForSeconds,
        tokenCount: working.tokenCount,
        reason: "token-counter-pinned-while-working",
      };
    }
  }
  const idle = observations.idle;
  if (idle === undefined || input.activity === "working" || input.activity === "needs-input") {
    return undefined;
  }
  const stalledForSeconds = Math.floor((input.nowMs - idle.unchangedSinceMs) / 1_000);
  if (stalledForSeconds < input.workerStallSeconds) return undefined;
  return {
    stalledForSeconds,
    tokenCount: idle.tokenCount,
    reason: "transcript-and-token-count-unchanged-while-idle",
  };
}

export type { WorkerStallReason };
