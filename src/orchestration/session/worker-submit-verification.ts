import type { ComposerObservation } from "../../domain/worker-truth.js";
import type { RenderedInstruction } from "./worker-turn-state.js";

/**
 * How long after rendering an instruction the engine looks for it still sitting in the composer.
 * Longer than any provider's paste-burst suppression (Codex: 120 ms) and than a TUI repaint, short
 * enough that a swallowed Enter costs a second or two rather than a stalled worker.
 */
export const SUBMIT_VERIFY_MS = 1_500;
/** Enter is pressed again at most this many times for one instruction; after that it is reported. */
export const SUBMIT_VERIFY_MAX_PRESSES = 2;
/** Verification re-checks a busy screen or an open dialog at most this many times before giving up. */
export const SUBMIT_VERIFY_MAX_CHECKS = 8;
/** The composer and the rendered message are compared over at most this many normalized characters. */
export const SUBMIT_VERIFY_HEAD_CHARS = 48;

const PASTE_PLACEHOLDER = /^\[pasted (?:content|text)\b/iu;

/** Collapse whitespace and keep the head, the way a composer line is compared with a message. */
export function normalizedHead(text: string): string {
  return text.replace(/\s+/gu, " ").trim().slice(0, SUBMIT_VERIFY_HEAD_CHARS);
}

/**
 * Whether what the composer shows is the rendered message. Either head is a prefix of the other,
 * because a narrow terminal wraps the composer after fewer characters than the comparison keeps;
 * or the provider replaced a large paste with its placeholder, which only a large message earns.
 */
export function composerHoldsMessage(content: string, entry: RenderedInstruction): boolean {
  const head = entry.messageHead ?? "";
  if (head.length === 0 || content.length === 0) return false;
  if (PASTE_PLACEHOLDER.test(content)) return (entry.messageLength ?? 0) > 200;
  return content.startsWith(head) || head.startsWith(content);
}

/** What the engine lends the verifier: its truth, its keyboard, and its transcript. */
export interface SubmitVerificationHost {
  /** The lifecycle fence; a timer armed in an older epoch never fires. */
  epoch(): number;
  /** False once the process is gone or finalizing — nothing to press into. */
  active(): boolean;
  /** Rendered entries that have not completed, oldest first. */
  pending(): readonly RenderedInstruction[];
  /** A fresh reading of the screen, including the composer. */
  observe(): { activity: string; composer: ComposerObservation };
  /** Press the provider's bare Enter for this entry and record that it was pressed. */
  press(entry: RenderedInstruction, key: Buffer): void;
  /** Report an entry still unsent after every allowed press. */
  exhausted(entry: RenderedInstruction, composer: ComposerObservation): void;
}

/**
 * Look, a moment after writing, for the instruction still sitting unsent in the composer.
 *
 * This exists because a provider can take the text and drop the Enter: Codex's paste-burst
 * heuristic turned the trailing Enter of a fast write into a newline, the text sat under `› `,
 * the screen read as idle, and the broker recorded a scraped "turn" for an instruction the model
 * never saw. Framing the write as a paste removes the known cause; this removes the class.
 *
 * It presses only the provider's bare Enter, only when the composer's own content matches the head
 * of a message the engine wrote, only while nothing is running and no dialog is up, and only a
 * bounded number of times. A draft the operator typed is never submitted on their behalf, and a
 * hint-only reading ("tab to queue message" with no readable content) is never enough.
 */
export class SubmitVerifier {
  private timer?: ReturnType<typeof setTimeout>;
  private checks = 0;

  constructor(private readonly host: SubmitVerificationHost) {}

  /** Start (or restart) verification for the instruction just rendered. */
  arm(): void {
    this.release();
    this.schedule();
  }

  /** Drop any armed check; the next process generation starts clean. */
  release(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    delete this.timer;
    this.checks = 0;
  }

  private schedule(): void {
    const epoch = this.host.epoch();
    const timer = setTimeout(() => {
      if (this.host.epoch() !== epoch || this.timer !== timer) return;
      delete this.timer;
      this.verify();
    }, SUBMIT_VERIFY_MS);
    this.timer = timer;
  }

  private verify(): void {
    if (!this.host.active()) return;
    const pending = this.host.pending().filter((entry) => entry.messageHead !== undefined);
    if (pending.length === 0) return;
    this.checks += 1;
    const { activity, composer } = this.host.observe();
    // A dialog owns the keyboard, so Enter here would answer it rather than submit anything; and a
    // running turn may be this very instruction. Either way, look again once the screen settles,
    // a bounded number of times, rather than leaving the instruction unverified forever.
    if (composer.modalOpen || activity === "needs-input" || activity === "working") {
      if (this.checks < SUBMIT_VERIFY_MAX_CHECKS) this.schedule();
      return;
    }
    if (!composer.occupied || composer.content === undefined) return;
    // The composer shows the oldest unsent text first, so only the oldest pending entry can match.
    const entry = pending[0]!;
    if (!composerHoldsMessage(normalizedHead(composer.content), entry)) return;
    if ((entry.submitPresses ?? 0) >= SUBMIT_VERIFY_MAX_PRESSES) {
      this.host.exhausted(entry, composer);
      return;
    }
    this.host.press(entry, entry.submitKey ?? Buffer.from("\r"));
    this.schedule();
  }
}
