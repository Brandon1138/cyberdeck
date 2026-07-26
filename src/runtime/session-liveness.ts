import { stripTerminalControl } from "./terminal-replay.js";

/**
 * How much of the replay tail is examined. A fatal notice is always the last thing a provider
 * prints, and bounding the scan keeps this cheap enough to run on every output chunk.
 */
const TAIL_BYTES = 4_000;

/**
 * Conversation chrome, in the first column.
 *
 * Every provider TUI marks the lines it does not own: the prompt echo carries `>`/`›`, an assistant
 * turn carries a bullet, a tool result carries `⎿`, the composer and its pasted contents sit inside
 * a box drawn with `│`/`╭`, and every wrapped continuation is indented. The provider's own fatal
 * notice is the one thing printed flush left with no marker at all, so a line matching this is not
 * evidence about the session and is never scanned.
 */
const CONVERSATION_CHROME =
  /^[\s>›❯⏺●○∙•·◆◇⎿⏵⎯│┃┆┊║▌▏▕╭╮╰╯┌┐└┘├┤┬┴┼─═━┈#*+\-|/\\]/u;

/**
 * Unrecoverable provider faults, matched against a provider-owned line in its entirety.
 *
 * Every pattern here describes a condition the provider will not retry out of: the request was
 * rejected on its merits (4xx), the session context is gone, or the agent loop itself reported a
 * fatal stop. Transient 5xx and connection errors are deliberately absent — providers retry those,
 * and treating them as terminal would kill healthy sessions. Each pattern is anchored to the start
 * of the line: an error signal quoted mid-sentence is prose, not a fault.
 */
const FATAL_PATTERNS: readonly { readonly pattern: RegExp; readonly reason: string }[] = [
  {
    pattern: /^API Error:?\s*4\d{2}\b.*\bauthentication_error\b/iu,
    reason: "provider authentication failed",
  },
  {
    pattern: /^API Error:?\s*4\d{2}\b.*\bpermission_error\b/iu,
    reason: "provider denied the request",
  },
  {
    pattern: /^API Error:?\s*4\d{2}\b.*\binvalid_request_error\b/iu,
    reason: "provider API rejected the request",
  },
  {
    pattern: /^API Error:?\s*4\d{2}\b/iu,
    reason: "provider API rejected the request",
  },
  {
    pattern: /^(?:stream|session) error:.*(?:fatal|unrecoverable)/iu,
    reason: "provider stream failed",
  },
  {
    pattern: /^fatal(?: error)?: .*session/iu,
    reason: "provider session failed",
  },
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
 *
 * The verdict is drawn only from lines the provider itself owns. Scanning the rendered screen as
 * one blob killed healthy sessions instead: a prompt, a pasted log, or an assistant paragraph that
 * merely contained `API Error: 400` read exactly like the fault it was describing.
 */
export function detectSessionFatalError(replay: string): SessionFatalError | undefined {
  const plain = stripTerminalControl(replay);
  const truncated = plain.length > TAIL_BYTES;
  const tail = truncated ? plain.slice(plain.length - TAIL_BYTES) : plain;

  let best: { index: number; reason: string; detail: string } | undefined;
  for (const { line, index } of providerOwnedLines(tail, truncated)) {
    for (const { pattern, reason } of FATAL_PATTERNS) {
      if (!pattern.test(line)) continue;
      if (best === undefined || index > best.index) {
        best = { index, reason, detail: boundedDetail(line) };
      }
      break;
    }
  }
  if (best === undefined) return undefined;

  const after = tail.slice(best.index);
  if (RETRY_MARKERS.some((marker) => marker.test(after))) return undefined;

  return { reason: best.reason, detail: best.detail };
}

/**
 * Walk the replay a line at a time, keeping only the lines the provider prints as its own.
 *
 * When the slice actually cut into the replay its first line is dropped, because a fragment whose
 * left edge was severed cannot be told apart from a line that genuinely began at column 0.
 */
function* providerOwnedLines(
  tail: string,
  dropFirstLine: boolean,
): Generator<{ line: string; index: number }> {
  let index = 0;
  let first = true;
  for (const line of tail.split("\n")) {
    const start = index;
    index += line.length + 1;
    const severed = first && dropFirstLine;
    first = false;
    if (severed || line.length === 0 || CONVERSATION_CHROME.test(line)) continue;
    yield { line, index: start };
  }
}

function boundedDetail(line: string): string {
  const collapsed = line.replace(/\s+/gu, " ").trim();
  return collapsed.length > 240 ? `${collapsed.slice(0, 237)}...` : collapsed;
}
