import type { ProviderLimitTermination } from "../domain/worker-truth.js";
import { stripTerminalControl } from "./terminal-replay.js";

/**
 * How much of the replay tail is examined. A fatal notice is always the last thing a provider
 * prints, and bounding the scan keeps this cheap enough to run on every output chunk.
 */
export const TAIL_BYTES = 4_000;

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

/**
 * Limits the provider imposes on itself, which are terminal but are not faults.
 *
 * A worker that hits its five-hour cap, or is handed a prompt longer than the model's context, stops
 * for a reason the operator can act on — wait for the reset, or split the work. Both used to reach
 * nobody: the notice went into the provider's own transcript, `executionState` stayed `active`
 * because the process was still there, and the wait kept waiting. They are matched before the
 * generic 4xx patterns below precisely so `provider API rejected the request` never swallows the one
 * detail that says what to do next.
 */
const PROVIDER_LIMIT_PATTERNS: readonly {
  readonly pattern: RegExp;
  readonly kind: ProviderLimitTermination["kind"];
  readonly reason: string;
}[] = [
  {
    pattern: /\bprompt is too long\b/iu,
    kind: "prompt-too-long",
    reason: "provider refused the prompt as too long for its context window",
  },
  {
    pattern: /\binput length and `?max_tokens`? exceed context limit\b/iu,
    kind: "prompt-too-long",
    reason: "provider refused the prompt as too long for its context window",
  },
  {
    pattern: /\bcontext (?:window|length) exceeded\b/iu,
    kind: "prompt-too-long",
    reason: "provider refused the prompt as too long for its context window",
  },
  {
    pattern: /\bexceeds? the (?:maximum )?context (?:window|length)\b/iu,
    kind: "prompt-too-long",
    reason: "provider refused the prompt as too long for its context window",
  },
  {
    pattern: /\busage limit reached\b/iu,
    kind: "session-limit",
    reason: "provider usage limit reached",
  },
  {
    pattern: /\byou(?:'|’)?ve (?:reached|hit) your (?:usage|weekly|session) limit\b/iu,
    kind: "session-limit",
    reason: "provider usage limit reached",
  },
  {
    pattern: /\b\d+-hour limit reached\b/iu,
    kind: "session-limit",
    reason: "provider usage limit reached",
  },
  {
    pattern: /\b(?:usage )?limit (?:will )?reset(?:s)? at\b/iu,
    kind: "session-limit",
    reason: "provider usage limit reached",
  },
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
  return detectSessionFatalErrorInTail(strippedTail(replay));
}

/**
 * {@link detectSessionFatalError} over a stripped tail the caller already holds.
 *
 * The scan was always bounded to the last {@link TAIL_BYTES} characters, but the bounding used to
 * happen after stripping the whole replay — so a scan that reads 4 000 characters cost a pass over
 * 128 KiB on every output chunk. A caller keeping a rolling stripped tail hands it over instead.
 * `truncated` must say whether that tail's head was cut, because a line whose left edge was severed
 * cannot be told apart from one that genuinely began at column 0.
 */
export function detectSessionFatalErrorInTail(
  { text: tail, truncated }: { text: string; truncated: boolean },
): SessionFatalError | undefined {
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
 * Classify a PTY replay as carrying a provider-imposed limit that ended the session.
 *
 * Read from the same provider-owned lines as `detectSessionFatalError`, for the same reason: an
 * assistant paragraph explaining that a prompt was too long is prose about the problem, not the
 * provider hitting it. A retry marker after the notice still vetoes the verdict — a provider that is
 * about to try again has not stopped.
 */
export function detectProviderLimitTermination(replay: string): ProviderLimitTermination | undefined {
  return detectProviderLimitTerminationInTail(strippedTail(replay));
}

/** {@link detectProviderLimitTermination} over a stripped tail the caller already holds. */
export function detectProviderLimitTerminationInTail(
  { text: tail, truncated }: { text: string; truncated: boolean },
): ProviderLimitTermination | undefined {
  let best: { index: number; kind: ProviderLimitTermination["kind"]; reason: string; detail: string }
    | undefined;
  for (const { line, index } of providerOwnedLines(tail, truncated)) {
    for (const { pattern, kind, reason } of PROVIDER_LIMIT_PATTERNS) {
      if (!pattern.test(line)) continue;
      if (best === undefined || index > best.index) {
        best = { index, kind, reason, detail: boundedDetail(line) };
      }
      break;
    }
  }
  const found = best;
  if (found === undefined) return undefined;
  if (RETRY_MARKERS.some((marker) => marker.test(tail.slice(found.index)))) return undefined;
  return { kind: found.kind, reason: found.reason, detail: found.detail };
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

function strippedTail(replay: string): { text: string; truncated: boolean } {
  const plain = stripTerminalControl(replay);
  const truncated = plain.length > TAIL_BYTES;
  return { text: truncated ? plain.slice(plain.length - TAIL_BYTES) : plain, truncated };
}

function boundedDetail(line: string): string {
  const collapsed = line.replace(/\s+/gu, " ").trim();
  return collapsed.length > 240 ? `${collapsed.slice(0, 237)}...` : collapsed;
}
