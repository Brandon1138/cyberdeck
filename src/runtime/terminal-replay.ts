import type { ProviderId } from "../domain/session.js";

export const OSC_TITLE = /\u001b\]0;([^\u0007\u001b]*)(?:\u0007|\u001b\\)/gu;
const OSC_SEQUENCE = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu;
const HORIZONTAL_CURSOR_SEQUENCE = /\u001b\[(?:\d+)?[CG]/gu;
const CSI_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/gu;
const OTHER_ESCAPE = /\u001b(?:[()][0-9A-Z]|[@-_])/gu;
const BRAILLE_SPINNER = /^[\u2800-\u28ff]/u;

/** How much stripped tail a blocked-prompt reading is drawn from. */
export const BLOCKED_PROMPT_TAIL_CHARS = 8_000;

export type ProviderTerminalActivity = "working" | "awaiting-input" | "needs-input" | "unknown";

/**
 * Every literal whose last occurrence can decide an activity verdict.
 *
 * Named in one place because a marker source that tracks occurrences incrementally has to know the
 * whole set up front — it sees each PTY chunk exactly once, so a literal added to the decision
 * below and not to this list would simply never be found.
 */
export const ACTIVITY_MARKERS = [
  "esc to interrupt",
  "Composing",
  "Working",
  "Cursor is waiting for you",
  "Add a follow-up",
  "Write tests for",
  "? for shortcuts",
  "> Plan mode:",
  "ctrl+c to stop",
  "No matches",
  "/run-everything",
  "/model [filter]",
] as const;

export type ActivityMarker = (typeof ACTIVITY_MARKERS)[number];

/**
 * Where an activity verdict reads its evidence.
 *
 * Two implementations exist and have to agree: {@link replayMarkerSource}, which strips a whole
 * replay on every call, and `ReplayDigest`, which strips each PTY chunk once and remembers where
 * the markers landed. Both answer in the same coordinate space — offsets into the stripped stream —
 * so the decision below never learns which one it is talking to. That seam is the point: a broker
 * ingesting seven concurrent workers cannot afford the first implementation, and a second copy of
 * the decision would drift from this one within a release.
 */
export interface TerminalMarkerSource {
  /** Offset of the last occurrence of `marker` in the stripped stream, or -1. */
  lastIndexOf(marker: ActivityMarker): number;
  /**
   * Offset of the last occurrence of `marker` in the raw stream, or -1.
   *
   * Cursor announces that it is waiting inside an OSC notification, which stripping removes — so
   * the one provider whose idle marker is not rendered text has to be read before stripping. Raw
   * and stripped offsets are different coordinate spaces and are never compared with each other.
   */
  lastRawIndexOf(marker: ActivityMarker): number;
  /** Offset of the last braille spinner glyph in the stripped stream, or -1. */
  lastBrailleIndex(): number;
  /** The last window title the provider set through OSC, or undefined. */
  lastTitle(): string | undefined;
  /** Offset of the last blocked-prompt match in the stripped stream, or -1. */
  blockedPromptIndex(provider: ProviderId): number;
}

/**
 * Derive the same compact provider activity used by both the cockpit and semantic worker waits.
 * Last-occurrence comparisons matter because PTY replay contains old working and idle frames.
 */
export function providerTerminalActivity(provider: ProviderId, replay: string): ProviderTerminalActivity {
  return markerTerminalActivity(provider, replayMarkerSource(replay));
}

/**
 * The one activity decision, over whichever marker source the caller can afford.
 */
export function markerTerminalActivity(
  provider: ProviderId,
  markers: TerminalMarkerSource,
): ProviderTerminalActivity {
  const blockedAt = markers.blockedPromptIndex(provider);

  if (provider === "cursor") {
    if (blockedAt >= 0) return "needs-input";
    const workingAt = Math.max(
      markers.lastRawIndexOf("Composing"),
      markers.lastRawIndexOf("ctrl+c to stop"),
    );
    const waitingAt = Math.max(
      markers.lastRawIndexOf("Cursor is waiting for you"),
      markers.lastRawIndexOf("Add a follow-up"),
      markers.lastRawIndexOf("No matches"),
      markers.lastRawIndexOf("/run-everything"),
      markers.lastRawIndexOf("/model [filter]"),
    );
    if (workingAt >= 0 || waitingAt >= 0) return waitingAt > workingAt ? "awaiting-input" : "working";
  }


  if (provider === "antigravity") {
    const workingAt = markers.lastBrailleIndex();
    const waitingAt = Math.max(
      markers.lastIndexOf("? for shortcuts"),
      markers.lastIndexOf("> Plan mode:"),
    );
    if (blockedAt > Math.max(workingAt, waitingAt)) return "needs-input";
    if (workingAt >= 0 || waitingAt >= 0) return waitingAt > workingAt ? "awaiting-input" : "working";
  }

  const workingAt = Math.max(
    markers.lastIndexOf("esc to interrupt"),
    markers.lastIndexOf("Composing"),
    markers.lastIndexOf("Working"),
  );
  const waitingAt = Math.max(
    markers.lastIndexOf("Cursor is waiting for you"),
    markers.lastIndexOf("Add a follow-up"),
    markers.lastIndexOf("Write tests for"),
  );
  if (blockedAt > Math.max(workingAt, waitingAt)) return "needs-input";

  const title = markers.lastTitle();
  if (title !== undefined) return BRAILLE_SPINNER.test(title) ? "working" : "awaiting-input";

  if (workingAt >= 0 || waitingAt >= 0) return waitingAt > workingAt ? "awaiting-input" : "working";
  return "unknown";
}

/**
 * A marker source backed by one whole replay string.
 *
 * Every reading costs a full strip of that replay, so this belongs to callers that hold a snapshot
 * and ask once — the cockpit renderer, a test. The stripped text is computed at most once per
 * source, because the decision above asks for several markers and each one used to pay for its own
 * pass over the replay.
 */
export function replayMarkerSource(replay: string): TerminalMarkerSource {
  let plain: string | undefined;
  const stripped = (): string => (plain ??= stripTerminalControl(replay));
  return {
    lastIndexOf: (marker) => stripped().lastIndexOf(marker),
    lastRawIndexOf: (marker) => replay.lastIndexOf(marker),
    lastBrailleIndex: () => lastBrailleIndex(stripped()),
    lastTitle: () => lastTerminalTitle(replay),
    blockedPromptIndex: (provider) => {
      const plainText = stripped();
      const tailStart = Math.max(0, plainText.length - BLOCKED_PROMPT_TAIL_CHARS);
      const index = blockedPromptIndexInTail(provider, plainText.slice(tailStart));
      return index < 0 ? -1 : tailStart + index;
    },
  };
}

/**
 * PTY replay reduced to plain text with its line structure intact. Blank lines are preserved
 * because downstream block classification treats them as boundaries.
 */
export function plainTerminalText(replay: string): string {
  return stripTerminalControl(replay.replace(HORIZONTAL_CURSOR_SEQUENCE, " "))
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

export function terminalLines(replay: string): string[] {
  return plainTerminalLines(plainTerminalText(replay));
}

/** {@link terminalLines} for a caller that already holds the normalized text. */
export function plainTerminalLines(plain: string): string[] {
  const lines: string[] = [];
  for (const raw of plain.split("\n")) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (line === "" || lines.at(-1) === line) continue;
    lines.push(line);
  }
  return lines;
}

export function stripTerminalControl(value: string): string {
  return value
    .replace(OSC_SEQUENCE, "")
    .replace(CSI_SEQUENCE, "")
    .replace(OTHER_ESCAPE, "")
    .replace(/[\u000f]/g, "");
}

/**
 * Explicit fallback for providers without native structured transcripts.
 * Return normalized terminal content with deterministic, head-preserving truncation.
 */
export function compactTerminalResult(replay: string, maxChars = 1_200): string {
  const bounded = Math.max(200, Math.min(maxChars, 4_000));
  return truncateResult(terminalFallbackResult(replay), bounded);
}

/**
 * {@link compactTerminalResult} for a caller that already holds the normalized current frame.
 *
 * The frame is the only part of the replay this ever read: `terminalFallbackResult` slices from the
 * last clear-screen before it does anything else. Taking that slice as an argument lets the broker
 * hand over the frame it already tracks instead of re-normalizing the whole replay to rediscover a
 * boundary it knew the position of.
 */
export function compactFrameResult(frame: string, maxChars = 1_200): string {
  const bounded = Math.max(200, Math.min(maxChars, 4_000));
  return truncateResult(frameFallbackResult(frame), bounded);
}

/** {@link terminalFallbackResult} for a caller that already holds the normalized current frame. */
export function frameFallbackResult(frame: string): string {
  const meaningful = plainTerminalLines(frame).filter((line) => !isTerminalChrome(line));
  const promptIndex = meaningful.findLastIndex(isUserPromptLine);
  return meaningful.slice(promptIndex + 1).join("\n") || "No useful provider output yet";
}

export function terminalFallbackResult(replay: string): string {
  const lastClear = replay.lastIndexOf("\u001b[2J");
  const frame = lastClear < 0 ? replay : replay.slice(lastClear);
  const meaningful = terminalLines(frame).filter((line) => !isTerminalChrome(line));
  const promptIndex = meaningful.findLastIndex(isUserPromptLine);
  return meaningful.slice(promptIndex + 1).join("\n") || "No useful provider output yet";
}

export function truncateResult(result: string, maxChars = 1_200): string {
  const bounded = Math.max(200, Math.min(maxChars, 4_000));
  if (result.length <= bounded) return result;
  const marker = `\n\n[elided; original length: ${result.length} characters]`;
  return `${result.slice(0, bounded - marker.length)}${marker}`;
}

/**
 * Longest text a token counter can span, so an incremental reader knows how much of the previous
 * segment to re-examine when a counter straddles two PTY chunks.
 */
export const TOKEN_COUNT_MAX_SPAN = 32;

/** Last provider token counter rendered in the replay, normalized to whole tokens. */
export function terminalTokenCount(replay: string): number | undefined {
  return plainTokenCount(plainTerminalText(replay));
}

/** {@link terminalTokenCount} for a caller that already holds the normalized text. */
export function plainTokenCount(plain: string): number | undefined {
  const pattern = /(\d[\d,]*(?:\.\d+)?)\s*([km]?)\s+tokens?\b/giu;
  let count: number | undefined;
  for (const match of plain.matchAll(pattern)) {
    const value = Number(match[1]?.replaceAll(",", ""));
    if (!Number.isFinite(value)) continue;
    const multiplier = match[2]?.toLowerCase() === "m"
      ? 1_000_000
      : match[2]?.toLowerCase() === "k"
        ? 1_000
        : 1;
    count = Math.round(value * multiplier);
  }
  return count;
}

export function lastTerminalTitle(replay: string): string | undefined {
  let last: string | undefined;
  for (const match of replay.matchAll(OSC_TITLE)) last = match[1];
  return last;
}

/**
 * Offset of the last blocked-prompt match within an already-bounded stripped tail.
 *
 * The window was always bounded — a modal is the last thing on the screen — but the bounding used
 * to happen after stripping the entire replay. Taking the tail as an argument lets a caller that
 * already keeps a rolling stripped tail hand it straight over, which is the difference between
 * per-chunk work proportional to the chunk and proportional to everything the worker has ever
 * printed.
 */
export function blockedPromptIndexInTail(provider: ProviderId, tail: string): number {
  const common = Math.max(
    lastRegexIndex(
      tail,
      /Do you trust the contents of this project\?|workspace-trust|needs authentication|permission prompt/giu,
    ),
    dialogAffordanceIndexInTail(tail),
  );
  const providerPrompt = provider === "codex"
    ? Math.max(
        lastRegexIndex(
          tail,
          /Would you like to (?:run the following command|apply the following changes)\?[\s\S]{0,2400}?Yes, proceed/giu,
        ),
        lastRegexIndex(tail, /Codex needs (?:your )?(?:approval|permission)[\s\S]{0,1600}?(?:Allow|Yes)/giu),
      )
    : provider === "claude"
      ? Math.max(
          lastRegexIndex(tail, /Claude needs your permission[\s\S]{0,2400}?(?:Do you want to proceed\?|Allow)/giu),
          lastRegexIndex(tail, /Do you want to proceed\?[\s\S]{0,1600}?(?:Yes|Esc to cancel)/giu),
        )
      : -1;
  return Math.max(common, providerPrompt);
}

function lastRegexIndex(value: string, pattern: RegExp): number {
  let index = -1;
  for (const match of value.matchAll(pattern)) index = match.index;
  return index;
}

/**
 * Box-drawing and padding a TUI wraps a dialog's own lines in.
 *
 * Stripped from both ends before a line is read, because the dialogs this has to see are drawn
 * inside a border and the border is the only thing between the affordance and the left margin.
 */
const DIALOG_BORDER = /^[\s│┃┆┊║▌▏▕╭╮╰╯┌┐└┘├┤┬┴┼─═━┈]+|[\s│┃┆┊║▌▏▕╭╮╰╯┌┐└┘├┤┬┴┼─═━┈]+$/gu;

/**
 * The `·`-style separator a provider puts between two affordances on one footer line.
 *
 * An interior box rule counts too. {@link DIALOG_BORDER} only strips the border off the ends, so a
 * footer that rules between its affordances would otherwise reach {@link KEY_AFFORDANCE} as one
 * segment with a `│` sitting in the middle of it — and that segment has to validate whole.
 */
const AFFORDANCE_SEPARATOR = /\s*[·•│┃║]\s*/u;

/** Keys a footer names. */
const AFFORDANCE_KEY =
  String.raw`(?:enter|return|esc(?:ape)?|tab|shift\+tab|space|ctrl\+\S+|[←→↑↓](?:\/[←→↑↓])?|arrows?)`;

/** The subset of {@link AFFORDANCE_KEY} that can appear in an affordance which *blocks*. */
const CONFIRM_KEY = String.raw`(?:enter|return|[←→↑↓](?:\/[←→↑↓])?|arrows?)`;

/**
 * What pressing the key does: at most three words, none of them carrying sentence punctuation, and
 * then the end of the segment.
 *
 * The bound is the whole defence against prose, and it has to be a *tail* anchor rather than a
 * prefix one. `Press Enter to continue installing dependencies, then rerun tests.` opens with a
 * perfectly good affordance and continues as a sentence; matching only its opening read a finished
 * response's follow-up instructions as a dialog, held them as `provider-modal`, and — because
 * `markerTerminalActivity` answers `needs-input` before it ever consults the provider's idle title —
 * projected a worker that was actively writing files as blocked. A footer hint is three words at the
 * outside (`confirm`, `go back`, `confirm (default)`); a sentence is longer than that or has a comma
 * in it, and either one is enough to tell them apart.
 */
const AFFORDANCE_ACTION = String.raw`[^\s.,;:!?]+(?:\s+[^\s.,;:!?]+){0,2}\.?`;

/**
 * One keypress affordance: a key, and what pressing it does, and nothing else.
 *
 * Every segment of a footer line has to be one of these for the line to be read as a footer at all.
 * That is what keeps an assistant sentence containing the words "enter to confirm" from being read
 * as a dialog: prose has other clauses in it, and they are not keypresses.
 */
const KEY_AFFORDANCE = new RegExp(
  String.raw`^(?:press\s+)?${AFFORDANCE_KEY}\s+to\s+${AFFORDANCE_ACTION}$`,
  "iu",
);

/**
 * The affordances that mean the surface is *waiting* on the operator, not merely offering a way out.
 *
 * `esc to interrupt` and `ctrl+c to stop` are printed by a provider that is working and would keep
 * working if nobody touched the keyboard; `enter to confirm` and `←/→ to change` are printed by one
 * that will do nothing at all until a key is pressed. Only the second kind is a blocked prompt.
 *
 * Anchored at both ends for the same reason {@link KEY_AFFORDANCE} is: `Press Enter to continue`
 * opens this pattern just as readily when the rest of the line is a sentence about installing
 * dependencies.
 */
const DIALOG_CONFIRM_AFFORDANCE = new RegExp(
  String.raw`^(?:press\s+)?${CONFIRM_KEY}\s+to\s+(?:confirm|continue|select|submit|accept|change|choose|cycle)\b(?:\s+[^\s.,;:!?]+){0,2}\.?$`,
  "iu",
);

/**
 * Offset of the last dialog footer in the tail, or -1.
 *
 * A provider dialog names the keypress that dismisses it, on its own line, under whatever it is
 * asking. That footer is the one part of a dialog whose shape does not change with what the dialog
 * says — which is the whole reason this exists. Claude's onboarding wizard and its session-limit
 * notice share no wording at all, and enumerating each dialog's prose is how both came to be
 * invisible: `truth.modalOpen` stayed false, the worker read `stalled`, and an instruction was
 * written into a surface that was never going to submit it. That was MIK-88.
 *
 * The session-limit dialog reaches here rather than the terminal `provider-limit` reading precisely
 * because it is boxed: `session-liveness` scans only the lines a provider prints flush left, so a
 * limit drawn inside a border is not the terminal notice it looks like. Boxed and answerable is a
 * modal; flush left and final is a termination. Both readings stay true by keeping that line.
 *
 * A false positive here holds an instruction that could have been delivered — recoverable, and
 * reported to the caller as `provider-modal`. A false negative is the incident.
 */
function dialogAffordanceIndexInTail(tail: string): number {
  let index = -1;
  // Matched rather than split so the offsets are exact: the tail keeps its carriage returns, and a
  // `\r\n` counted as one character would put every later marker comparison off by a line.
  for (const match of tail.matchAll(/[^\r\n]+/gu)) {
    if (isDialogAffordanceLine(match[0])) index = match.index;
  }
  return index;
}

function isDialogAffordanceLine(line: string): boolean {
  const content = line.replace(DIALOG_BORDER, "");
  if (content === "") return false;
  const segments = content.split(AFFORDANCE_SEPARATOR);
  if (!segments.every((segment) => KEY_AFFORDANCE.test(segment))) return false;
  return segments.some((segment) => DIALOG_CONFIRM_AFFORDANCE.test(segment));
}

export function lastBrailleIndex(value: string): number {
  let last = -1;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const code = value.charCodeAt(index);
    if (code >= 0x2800 && code <= 0x28ff) {
      last = index;
      break;
    }
  }
  return last;
}

function isTerminalChrome(line: string): boolean {
  const content = line
    .replace(/^[\s─━═╭╰│┌└┐┘▀▄]+/u, "")
    .replace(/[\s─━═╭╰│┌└┐┘▀▄]+$/u, "");
  return /^(CYBERDECK|Claude Code|OpenAI Codex|Tips for getting|Tip:\s*(?:Use|Try the Desktop app|Paste an image with Ctrl\+V)|What's new|Use \/skills|Try "|← for agents|Starting MCP|Running .* hook|No output yet)/i.test(content)
    || /^https:\/\/chatgpt\.com\/codex\?app-landing-page=true$/i.test(content)
    || /^(?:model|directory):\s+/i.test(content)
    || /^(?:tab to queue message|\d+% context left)$/i.test(content)
    || /^Working(?:…|\.\.\.)?$/i.test(content)
    || /esc to interrupt|ctrl\+g to edit|ctrl\+c to stop|permission mode|plan mode on|shift\+tab to cycle|Add a follow-up|Composing(?: \d+ tokens)?$/i.test(content)
    || /^(?:›\s*)?(?:Explain this codebase|Describe a task for a new session|Ask about this codebase)$/i.test(content)
    || /Cursor is waiting for you|Composer \d|Gemini .* · (?:low|medium|high)$/i.test(content)
    || /^(?:Worked|Cogitated|Reasoned) for \d/i.test(content)
    || content === "";
}

function isUserPromptLine(line: string): boolean {
  return /^(?:›|❯|>)\s+\S/u.test(line)
    && !/^>\s*Plan mode:/iu.test(line);
}
