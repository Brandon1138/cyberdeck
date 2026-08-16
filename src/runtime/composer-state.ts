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
  // Codex and the rest have no verified hint of their own; they fall through to the boxed-composer
  // reading below. Adding a guess here would be worse than nothing: it would make `occupied` fire on
  // ordinary chrome and hold every instruction the broker was asked to deliver.
  codex: [],
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
    return { modalOpen, occupied: true, evidence: content.slice(0, 120) };
  }

  return { modalOpen, occupied: false };
}
