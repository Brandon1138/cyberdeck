import { stripTerminalControl } from "./terminal-replay.js";

/**
 * How much of the replay tail is examined. A fatal notice is always the last thing a provider
 * prints, and bounding the scan keeps this cheap enough to run on every output chunk.
 */
const TAIL_BYTES = 4_000;

/**
 * Unrecoverable provider faults. Every pattern here describes a condition the provider will not
 * retry out of: the request was rejected on its merits (4xx), the session context is gone, or the
 * agent loop itself reported a fatal stop. Transient 5xx and connection errors are deliberately
 * absent — providers retry those, and treating them as terminal would kill healthy sessions.
 */
const FATAL_PATTERNS: readonly { readonly pattern: RegExp; readonly reason: string }[] = [
  { pattern: /API Error:?\s*4\d{2}\b/iu, reason: "provider API rejected the request" },
  { pattern: /\binvalid_request_error\b/u, reason: "provider API rejected the request" },
  { pattern: /\bauthentication_error\b/u, reason: "provider authentication failed" },
  { pattern: /\bpermission_error\b/u, reason: "provider denied the request" },
  { pattern: /\b(?:stream|session) error:.*(?:fatal|unrecoverable)/iu, reason: "provider stream failed" },
  { pattern: /\bfatal(?: error)?: .*session/iu, reason: "provider session failed" },
];

/**
 * A provider that is still retrying has not failed yet. These markers appear alongside the error
 * text while the retry loop is alive, so their presence after the error vetoes the fatal verdict.
 */
const RETRY_MARKERS: readonly RegExp[] = [
  /\bretrying\b/iu,
  /\bretry(?:ing)? in \d/iu,
  /\battempt \d+ of \d+/iu,
];

export interface SessionFatalError {
  /** Operator-facing summary; short enough to sit in a transcript line. */
  readonly reason: string;
  /** The matched provider text, bounded so a terminal dump cannot land in the catalog. */
  readonly detail: string;
}

/**
 * Classify a PTY replay as carrying an unrecoverable session fault.
 *
 * This exists because the broker previously inferred liveness from the PTY being open. A worker
 * whose provider died on an API 4xx keeps its process — and therefore its PTY — so it reported as
 * `active` with a null exit code, indistinguishable from a healthy worker, held a worker slot, and
 * could even present as `needs-input` at a session that can never accept input again.
 */
export function detectSessionFatalError(replay: string): SessionFatalError | undefined {
  const plain = stripTerminalControl(replay);
  const tail = plain.slice(Math.max(0, plain.length - TAIL_BYTES));

  let best: { index: number; reason: string; detail: string } | undefined;
  for (const { pattern, reason } of FATAL_PATTERNS) {
    const match = matchLast(tail, pattern);
    if (match === undefined) continue;
    if (best === undefined || match.index > best.index) {
      best = { index: match.index, reason, detail: match.text };
    }
  }
  if (best === undefined) return undefined;

  const after = tail.slice(best.index);
  if (RETRY_MARKERS.some((marker) => marker.test(after))) return undefined;

  return { reason: best.reason, detail: best.detail };
}

function matchLast(value: string, pattern: RegExp): { index: number; text: string } | undefined {
  const global = new RegExp(pattern.source, `${pattern.flags.replace(/[gy]/gu, "")}g`);
  let last: { index: number; text: string } | undefined;
  for (const match of value.matchAll(global)) {
    last = { index: match.index, text: errorLine(value, match.index) };
  }
  return last;
}

function errorLine(value: string, index: number): string {
  const start = value.lastIndexOf("\n", index) + 1;
  const end = value.indexOf("\n", index);
  const line = value.slice(start, end < 0 ? value.length : end).replace(/\s+/gu, " ").trim();
  return line.length > 240 ? `${line.slice(0, 237)}...` : line;
}
