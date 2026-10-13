import { startupDialogPosition } from "./startup-dialog-activity.js";
import type { ProviderId } from "./session.js";
import { InputScreen, type RenderedTerminalScreen } from "./terminal-screen.js";

export const OSC_TITLE = /\u001b\]0;([^\u0007\u001b]*)(?:\u0007|\u001b\\)/gu;
const OSC_SEQUENCE = /\u001b\](?:[^\u0007\u001b]|\u001b(?!\\))*(?:\u0007|\u001b\\)/gu;
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
 * One-shot replay projection and incremental ReplayDigest ingestion use the same rendered screen
 * and raw write coordinates. Historical stream accessors remain for compatibility and diagnostics;
 * they cannot establish current activity without a reliable screen projection.
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
  /** A reliable rendered screen; absent/unsupported projections cannot establish activity. */
  currentScreen?(): RenderedTerminalScreen | undefined;
  /** Raw coordinates, shared with currentScreen().writtenAt(). */
  titlePosition?(): number;
  waitingNotificationPosition?(): number;
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
  if (!["claude", "codex", "cursor", "antigravity"].includes(provider)) return "unknown";
  const screen = markers.currentScreen?.();
  if (screen === undefined) return "unknown";

  // Positions come from the writes still visible on screen, not from append-only history. In-place
  // redraws can update a footer above an older prompt, so row order is not chronological order.
  const blocked = blockedPromptIndexInTail(provider, screen.text);
  const blockedEnd = screen.text.indexOf("\n", blocked);
  const blockedAt = blocked < 0 ? -1 : screen.writtenAt(blocked, blockedEnd < 0 ? screen.text.length : blockedEnd);
  let workingAt = -1;
  let waitingAt = -1;
  for (const match of screen.text.matchAll(/[^\n]+/gu)) {
    const line = match[0].replace(DIALOG_BORDER, "").trim();
    const at = screen.writtenAt(match.index, match.index + match[0].length);
    if (isWorkingLine(provider, line)) workingAt = Math.max(workingAt, at);
    if (isWaitingLine(provider, line)) waitingAt = Math.max(waitingAt, at);
  }
  // A working UI can retain and repaint its composer so an operator can queue a follow-up. That
  // prompt is not an idle transition while a working control remains on this screen.
  if (workingAt < 0) waitingAt = Math.max(waitingAt, currentComposerPosition(provider, screen));
  if (blockedAt > Math.max(workingAt, waitingAt)) return "needs-input";

  // Notifications are provider-owned but not rendered. They must lose to later visible work or a
  // clear, and OSC clipboard/prose payloads are never notification evidence.
  const notificationAt = provider === "cursor" ? markers.waitingNotificationPosition?.() ?? -1 : -1;
  if (notificationAt > screen.clearedAt) waitingAt = Math.max(waitingAt, notificationAt);

  // A static title says nothing about readiness. A spinner can supply activity only while newer
  // than the current UI and its last clear; an old spinner cannot overrule an idle composer.
  const title = markers.lastTitle();
  const titleAt = markers.titlePosition?.() ?? -1;
  if ((provider === "claude" || provider === "codex")
      && title !== undefined && BRAILLE_SPINNER.test(title) && titleAt > screen.clearedAt) {
    workingAt = Math.max(workingAt, titleAt);
  }
  if (blockedAt > Math.max(workingAt, waitingAt)) return "needs-input";
  if (workingAt >= 0 || waitingAt >= 0) return waitingAt > workingAt ? "awaiting-input" : "working";
  return "unknown";
}

function isWorkingLine(provider: ProviderId, line: string): boolean {
  if (provider === "cursor") {
    return /^(?:[\u2800-\u28ff]\s*)?Composing(?:\s+[\d.,]+[km]?\s+tokens?)?(?:\s+(?:ctrl\+c to stop|[·(].*))?$/iu.test(line)
      || /^ctrl\+c to stop(?:\s*[·)].*)?$/iu.test(line);
  }
  if (provider === "antigravity") {
    return /^[\u2800-\u28ff]\s+(?:Thinking|Working|Composing|Generating|Running|Searching|Reading)\b/iu.test(line);
  }
  if (provider === "codex" && /^•\s+(?:Working|Thinking|Compacting|Reconnecting|Running|Searching)\b[^\n]*\besc to interrupt\b/iu.test(line)) return true;
  return /^(?:[\u2800-\u28ff✻✽✶✢✳]\s*)?Working(?:…|\.{3})?(?:\s+[(*·].*)?$/iu.test(line)
    || /^esc to interrupt(?:\s*[·)].*)?$/iu.test(line)
    || /^[\u2800-\u28ff✻✽✶✢✳]\s+[^\n]*\besc to interrupt\b/iu.test(line);
}

function isWaitingLine(provider: ProviderId, line: string): boolean {
  if (provider === "cursor") return /^(?:Add a follow-up|No matches|\/(?:run-everything|model \[filter\])(?:\s+.*)?)$/iu.test(line);
  if (provider === "antigravity") return /^\? for shortcuts\b/iu.test(line) || /^> Plan mode:/iu.test(line);
  return false;
}

/** A bottom composer is idle evidence even when it holds an operator draft, never task success. */
function currentComposerPosition(provider: ProviderId, screen: RenderedTerminalScreen): number {
  const rows = [...screen.text.matchAll(/[^\n]+/gu)];
  let footer = false;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const match = rows[index]!;
    const line = match[0].trim();
    const prompt = provider === "codex" ? /^›(?:\s|$)/u
      : provider === "claude" ? /^❯(?:\s|$)/u
      : provider === "cursor" ? /^[→›❯](?:\s|$)/u : /^>(?:\s|$)/u;
    const boxed = /^[│┃┆┊║▌▏▕]\s*(?:›|❯|>)\s*.*[│┃┆┊║▌▏▕]$/u.test(line);
    if (boxed || prompt.test(line)) {
      // A numbered/yes-no picker also uses the prompt glyph. Its choices are not a composer.
      const content = line.replace(/^[│┃┆┊║▌▏▕]?\s*[→›❯>]\s*/u, "");
      if (/^(?:\d+[.)]\s|Yes\b|No,?\s|Upgrade your plan)/iu.test(content)) return -1;
      return boxed || footer || provider === "cursor"
        ? screen.writtenAt(match.index, match.index + match[0].length) : -1;
    }
    if (/^[─━═╭╮╰╯┌┐└┘]+$/u.test(line)) continue;
    if (/^\? for shortcuts\b/iu.test(line)
        || (provider === "codex" && /^(?:\d+% context left|tab to queue|← for agents|(?:gpt-[\w.-]+|o[134](?:-[\w.-]+)?)\s+(?:minimal|low|medium|high|xhigh|default)\s+·)/iu.test(line))
        || (provider === "claude" && /^(?:[⏵⏸]+\s*)?(?:bypass permissions on|accept edits on|plan mode on|auto mode on)\b.*shift\+tab|^tab to queue message$/iu.test(line))) { footer = true; continue; }
    return -1;
  }
  return -1;
}

/** One-shot interpretation uses the same bounded screen as incremental broker ingestion. */
export function replayMarkerSource(replay: string): TerminalMarkerSource {
  const input = new InputScreen();
  input.append(replay);
  let plain: string | undefined;
  const stripped = (): string => (plain ??= stripTerminalControl(replay));
  let titleAt = -1;
  for (const match of replay.matchAll(OSC_TITLE)) titleAt = match.index;
  let notificationAt = -1;
  for (const match of replay.matchAll(CURSOR_WAIT_NOTIFICATION)) notificationAt = match.index;
  return {
    lastIndexOf: (marker) => stripped().lastIndexOf(marker),
    lastRawIndexOf: (marker) => replay.lastIndexOf(marker),
    lastBrailleIndex: () => lastBrailleIndex(stripped()),
    lastTitle: () => lastTerminalTitle(replay),
    blockedPromptIndex: (provider) => {
      const plainText = stripped();
      const start = Math.max(0, plainText.length - BLOCKED_PROMPT_TAIL_CHARS);
      const at = blockedPromptIndexInTail(provider, plainText.slice(start));
      return at < 0 ? -1 : start + at;
    },
    currentScreen: () => input.snapshot(),
    titlePosition: () => titleAt,
    waitingNotificationPosition: () => notificationAt,
  };
}

/** Cursor's native OSC notification, excluding unrelated OSC payloads. */
export const CURSOR_WAIT_NOTIFICATION = /\u001b\]777;notify;Cursor;Cursor is waiting for you(?:\u0007|\u001b\\)/gu;

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
    lastRegexIndex(tail, /^\s*Do you trust the contents of this project\?(?:\s*> Yes, I trust this folder)?\s*$/gimu),
    dialogAffordanceIndexInTail(tail),
  );
  const providerPrompt = provider === "codex"
    ? Math.max(
        lastRegexIndex(
          tail,
          /^\s*Would you like to (?:run the following command|apply the following changes)\?[\s\S]{0,2400}?^\s*›\s*\d+\. Yes, proceed/gimu,
        ),
        lastRegexIndex(tail, /^\s*Codex needs (?:your )?(?:approval|permission)[\s\S]{0,1600}?^\s*(?:›|\d+\.)\s*(?:Allow|Yes)/gimu),
        startupDialogPosition(tail),
      )
    : provider === "claude"
      ? Math.max(
          lastRegexIndex(tail, /^\s*Claude needs your permission[^\n]*[\s\S]{0,2400}?^\s*(?:❯|\d+\.)\s*(?:\d+\. )?(?:Yes|Allow)/gimu),
          lastRegexIndex(tail, /^\s*Quick\s*safety\s*check:\s*Is\s*this\s*a\s*project\s*you\s*created\s*or\s*one\s*you\s*trust\?\s*$/gimu),
          lastRegexIndex(tail, /^\s*Do you want to proceed\?[\s\S]{0,1600}?^\s*❯\s*(?:\d+\. )?Yes\b/gimu),
        )
      : -1;
  return Math.max(common, providerPrompt);
}

function lastRegexIndex(value: string, pattern: RegExp): number {
  let index = -1;
  for (const match of value.matchAll(pattern)) {
    // A line-anchored modal can include blank rows/padding before its question. Evidence belongs
    // to the rendered question, not an unwritten row ED2 left above the preserved cursor.
    index = match.index + Math.max(0, match[0].search(/\S/u));
  }
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
    if (!isDialogAffordanceLine(match[0])) continue;
    const context = tail.slice(Math.max(0, match.index - 2400), match.index);
    // Provider-owned structure: boxed controls, selected choices, checkboxes or a trust gate.
    // A short assistant instruction on its own still is prose, even if it resembles a footer.
    if (/[│┃║].*[│┃║]|^[ \t]*[❯›→]\s+(?:\d+[.)]\s|Yes\b|No\b)|\[ \]|^.*trust\?\s*$/imu.test(context)
        || /[│┃║]/u.test(match[0])) index = match.index;
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
    || /^(?:›|❯|>)\s*$/u.test(content)
    || /^\? for shortcuts\b/iu.test(content)
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
