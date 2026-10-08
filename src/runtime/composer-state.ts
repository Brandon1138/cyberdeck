import type { ProviderId } from "../domain/session.js";
import type { ComposerObservation } from "../domain/worker-truth.js";
import { plainTerminalText, providerTerminalActivity } from "./terminal-replay.js";

/**
 * Whether the provider's input surface is holding something.
 *
 * This exists because of one incident: an instruction was written at a worker's PTY while the worker
 * sat at an MCP approval modal, the caller was told `delivered`, and the operator later found the
 * entire instruction in the composer with `tab to queue message` under it. Nothing in the broker
 * could see that, because nothing in the broker looked at the composer.
 *
 * The broker does not rely on this to *avoid* the bug — it refuses to write at an unsafe boundary in
 * the first place, and never claims submission it has not observed. What this adds is visibility:
 * text can reach a composer without the broker putting it there (the operator typed it, a previous
 * Cyberdeck wrote it before shutting down), and an orchestrator staring at a silent worker deserves
 * to be told that its UI is blocked rather than that it is working.
 *
 * Detection is best-effort and deliberately conservative. A false `occupied` holds an instruction
 * that could have been delivered — recoverable, and reported. A false empty is what the incident
 * was.
 */

/** Only the last rendered screen matters; earlier frames are scrollback, not current state. */
function currentFrame(replay: string): string {
  const lastClear = replay.lastIndexOf("\u001b[2J");
  return lastClear < 0 ? replay : replay.slice(lastClear);
}

/**
 * Hints a provider prints only when its composer is holding text it has not consumed.
 *
 * Claude Code renders `tab to queue message` beneath the composer box exactly when there is unsent
 * content in it — the string the operator screenshotted in the incident. It is matched on its own
 * rendered line so an assistant paragraph quoting the phrase is not evidence about the UI.
 */
const UNSENT_BUFFER_HINTS: Readonly<Record<string, readonly RegExp[]>> = {
  claude: [/^tab to queue message$/iu, /^\d+ queued messages?$/iu],
  // Codex prints the same hint at the left of its footer line, only while the composer holds a
  // draft (`tui/src/bottom_pane/footer.rs`, `FooterMode::ComposerHasDraft`). The right side of that
  // line carries the context meter, so the hint is anchored to the line start rather than matched
  // whole. Cursor and Antigravity have no verified hint of their own; they fall through to the
  // composer readings below. Adding a guess here would be worse than nothing: it would make
  // `occupied` fire on ordinary chrome and hold every instruction the broker was asked to deliver.
  codex: [/^tab to queue(?: message)?\b/iu],
  cursor: [],
  antigravity: [],
};

/**
 * A composer prompt drawn *inside* the input box.
 *
 * Every provider TUI draws its composer as a bordered box and echoes submitted prompts flush against
 * the conversation with no border. The border character is therefore what separates "text you have
 * not sent" from "text you already sent", and is the only reason this can be read at all.
 */
const BOXED_COMPOSER_LINE = /^[│┃┆┊║▌▏▕]\s*(?:›|❯|>)\s+(\S.*?)\s*[│┃┆┊║▌▏▕]?$/u;

/**
 * Codex's composer, which has no box at all.
 *
 * Since 0.1xx Codex draws its input line as a bare `› ` prompt, and it draws every *submitted*
 * prompt in the history with the very same glyph (`tui/src/history_cell/messages.rs`). The glyph
 * therefore says nothing on its own; position does. The composer is the bottom-most thing on the
 * screen above the footer, so the reading below walks up from the footer and accepts a `›` line only
 * when nothing but the composer's own wrapped continuation lines sit between them. A `›` line with
 * an assistant answer under it is history and is never read as unsent text.
 */
const BARE_COMPOSER_LINE = /^›\s+(\S.*)$/u;

/** Footer chrome Codex draws under its composer: hints, the context meter, the status line. */
const CODEX_FOOTER_LINE =
  /(?:% context left|\btokens? used\b|\d+[KkMm]? used\b|tab to queue|\? for shortcuts|\bfor agents\b|again to quit|to edit previous message|reverse-i-search|Plan mode|IDE context|⚠|·)/iu;

/** How many wrapped continuation lines of one composer draft the bare reading walks through. */
const BARE_COMPOSER_MAX_CONTINUATIONS = 12;

/**
 * Placeholder text a provider paints into an *empty* composer.
 *
 * These render in exactly the position real content would, so without this list every idle worker
 * reads as holding an unsent buffer and no instruction is ever delivered.
 */
const COMPOSER_PLACEHOLDERS: readonly RegExp[] = [
  /^Try ["“]/iu,
  /^(?:Explain this codebase|Describe a task for a new session|Ask about this codebase)$/iu,
  /^(?:Ask|Message|Tell) (?:Codex|Claude|Cursor|Gemini)\b/iu,
  /^Plan mode:/iu,
  /^\/\S+ for /iu,
];

/**
 * How far back a composer reading looks.
 *
 * A composer sits at the bottom of the screen, and every hint this reads is rendered against it. A
 * provider that never clears the screen has no frame boundary, so without this bound the scan grew
 * with everything the worker had ever printed — and an occurrence found thousands of lines up was
 * scrollback being mistaken for the live input surface either way.
 */
const COMPOSER_SCAN_LINES = 200;

export function terminalComposerState(
  provider: ProviderId,
  replay: string,
  /** Pass the activity verdict when the caller already has it; the scan is not cheap on a big replay. */
  options: { modalOpen?: boolean } = {},
): ComposerObservation {
  const modalOpen = options.modalOpen
    ?? providerTerminalActivity(provider, replay) === "needs-input";
  return frameComposerState(provider, plainTerminalText(currentFrame(replay)), { modalOpen });
}

/**
 * {@link terminalComposerState} for a caller that already holds the normalized current frame.
 *
 * `modalOpen` is required here rather than derived: a caller holding a frame has already decided
 * what the provider is doing, and re-deriving it would mean stripping a replay this path never
 * receives.
 */
export function frameComposerState(
  provider: ProviderId,
  frame: string,
  options: { modalOpen: boolean },
): ComposerObservation {
  const { modalOpen } = options;
  const lines = frame.split("\n");
  // Both passes read upward from the bottom of the frame and stop at the scan window. This runs on
  // every observed frame, so it walks the lines rather than building a trimmed copy of them first.
  const first = Math.max(0, lines.length - COMPOSER_SCAN_LINES);

  // The composer's own line is read before any hint beside it: a hint proves something is unsent,
  // the line says what, and the engine needs the what before it will press Enter on it.
  if (provider === "codex") {
    const bare = bareComposerContent(lines, first);
    if (bare !== undefined) {
      if (COMPOSER_PLACEHOLDERS.some((placeholder) => placeholder.test(bare))) {
        return { modalOpen, occupied: false };
      }
      const content = bare.slice(0, 120);
      return { modalOpen, occupied: true, evidence: content, content };
    }
  }

  for (const hint of UNSENT_BUFFER_HINTS[provider] ?? []) {
    for (let index = lines.length - 1; index >= first; index -= 1) {
      const line = lines[index]!.trim();
      if (line !== "" && hint.test(line)) return { modalOpen, occupied: true, evidence: line };
    }
  }

  // Read the *last* boxed prompt line: a composer is at the bottom of the screen, and an earlier
  // match is more likely to be a quoted block than the live input surface.
  for (let index = lines.length - 1; index >= first; index -= 1) {
    const content = BOXED_COMPOSER_LINE.exec(lines[index]!.trim())?.[1];
    if (content === undefined) continue;
    if (COMPOSER_PLACEHOLDERS.some((placeholder) => placeholder.test(content))) break;
    const bounded = content.slice(0, 120);
    return { modalOpen, occupied: true, evidence: bounded, content: bounded };
  }

  return { modalOpen, occupied: false };
}

/**
 * The text on Codex's bare `›` input line, or undefined when the bottom of the frame is not a
 * composer at all (a picker, a dialog, an older boxed layout).
 *
 * Walks up from the bottom: blank lines and footer chrome are skipped, indented lines are taken as
 * the draft's own wrapped continuations, and the first flush-left line decides. Only a `›` line
 * there is the composer; anything else means the composer is not where it would have to be.
 */
function bareComposerContent(lines: readonly string[], first: number): string | undefined {
  let continuations = 0;
  for (let index = lines.length - 1; index >= first; index -= 1) {
    const raw = lines[index]!;
    const line = raw.trim();
    if (line === "" || CODEX_FOOTER_LINE.test(line)) continue;
    const bare = BARE_COMPOSER_LINE.exec(line);
    if (bare !== undefined && bare !== null) return bare[1]!;
    if (/^\s/u.test(raw) && continuations < BARE_COMPOSER_MAX_CONTINUATIONS) {
      continuations += 1;
      continue;
    }
    return undefined;
  }
  return undefined;
}
