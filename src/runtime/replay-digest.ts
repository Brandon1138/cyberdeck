import { StringDecoder } from "node:string_decoder";

import type { ProviderId } from "../domain/session.js";
import {
  ACTIVITY_MARKERS,
  BLOCKED_PROMPT_TAIL_CHARS,
  OSC_TITLE,
  TOKEN_COUNT_MAX_SPAN,
  blockedPromptIndexInTail,
  lastBrailleIndex,
  plainTerminalText,
  plainTokenCount,
  stripTerminalControl,
  type ActivityMarker,
  type TerminalMarkerSource,
} from "./terminal-replay.js";

/**
 * Incremental reading of one session's PTY output.
 *
 * The broker used to answer every question about a worker by re-reading the worker's entire replay
 * buffer. Each output chunk cost a decode of 128 KiB, four regex passes to strip it, a `split` of
 * the result, and a 128 KiB string comparison — per chunk, per session. That is quadratic in the
 * output a worker has produced, and at seven concurrent workers it pinned a core: Fleet froze
 * because the broker it polls had no cycles left to answer, attach echo lagged because a keystroke
 * round-trips through the same thread, and semantic turn capture lost its races against the
 * provider transcript and settled for a screen scrape. That was MIK-87.
 *
 * Nothing here changes what the broker concludes. It changes when the reading happens: each chunk
 * is stripped exactly once, on arrival, and what the readings need — where each activity marker
 * last landed, where the current frame starts, what the last token counter said — is kept as
 * running state instead of rediscovered. Per-chunk work is proportional to the chunk.
 *
 * ## What this deliberately does not keep
 *
 * The raw replay. That still lives in the PTY handle, which is where an attaching client's replay
 * comes from and where anything needing the untouched bytes should ask. Mirroring it here would
 * double every session's memory to serve readers that are not on the hot path.
 *
 * ## Where it is approximate, and why that is safe
 *
 * Marker positions are remembered forever, in a stream coordinate that is never rebased. A replay
 * buffer forgets a marker once it scrolls past 128 KiB; this does not. The verdicts are decided by
 * comparing last-occurrence positions against each other, and a remembered-but-ancient marker loses
 * to every newer one exactly as a forgotten one would. The single difference is a worker that has
 * scrolled *every* marker out of its buffer: the replay-backed reading calls that `unknown`, this
 * one still answers from what it saw. Providers redraw their status line continuously while they
 * emit, so a marker only ages out while the session is quiet — and a quiet session is not scrolling.
 */
export class ReplayDigest implements TerminalMarkerSource {
  /**
   * Stripped and normalized tails, in characters.
   *
   * Only tail-shaped readers exist: the fatal-error scan wants 4 000 characters, the blocked-prompt
   * scan wants 8 000, the composer wants the current screen. This is comfortably above all three,
   * and is what bounds a session's steady-state footprint.
   */
  static readonly TAIL_CHARS = 32_000;

  /**
   * Withheld bytes are bounded so an unterminated escape sequence — a provider that dies mid-OSC —
   * cannot grow the carry without limit. Past this the carry is consumed as ordinary text, which is
   * what the whole-replay strip would have done with it anyway.
   */
  static readonly MAX_CARRY_CHARS = 8_192;

  /**
   * How much of the tail counts as "the current screen" when there is no clear-screen to anchor to.
   *
   * A provider that scrolls instead of clearing never draws a frame boundary, and the readings that
   * ask for a frame — the composer, the fallback result — are asking about what is in front of the
   * operator. The old reading handed them the whole replay buffer for want of a boundary, which put
   * 128 KiB of splitting and line work into every chunk. This is roughly two hundred wrapped lines:
   * past the composer scan window, and far past a screen.
   */
  static readonly FRAME_CHARS = 16_000;

  /** Enough overlap for the longest tracked literal and the longest token counter to be re-found. */
  static readonly #OVERLAP_CHARS = 64;

  /** Matches the `replayBytes` default, so a digest built without one ages titles the same way. */
  static readonly DEFAULT_REPLAY_CHARS = 128 * 1024;

  /**
   * How much raw stream a title stays visible in.
   *
   * Marker positions may outlive the replay buffer — see the note above, they lose to every newer
   * marker exactly as a forgotten one would. A title cannot: {@link markerTerminalActivity} gives it
   * unconditional precedence over every marker, so a remembered-forever title is a verdict that
   * never yields. A provider that names a spinner in its title once and then prints its way past the
   * replay buffer would stay `working` for the rest of the session, ignoring every waiting marker
   * after it. The replay-backed reading stops finding that title, and so does this.
   *
   * Counted in characters against a buffer bounded in bytes, which for UTF-8 can only make the
   * window wider than the buffer — a title is dropped no earlier than the replay would drop it.
   */
  readonly #replayChars: number;

  #decoder = new StringDecoder("utf8");
  readonly #markers = new Map<ActivityMarker, number>();
  readonly #rawMarkers = new Map<ActivityMarker, number>();
  /** Enough of the previous raw chunk to re-find a marker that straddled the boundary. */
  #rawSeam = "";
  #rawOffset = 0;
  #carry = "";
  #stripped = "";
  #strippedOffset = 0;
  #normalized = "";
  #normalizedOffset = 0;
  #frameOffset = 0;
  #braille = -1;
  #title: string | undefined;
  #titleAt = -1;
  #tokens: number | undefined;
  #version = 0;
  /** Set while an oversized OSC payload is being thrown away; see {@link append}. */
  #discardingOsc = false;
  /** The one character an `ESC \` terminator could have started in, and nothing else. */
  #oscSeam = "";

  /** @param replayChars How much raw stream the session's PTY replay buffer holds. */
  constructor(replayChars: number = ReplayDigest.DEFAULT_REPLAY_CHARS) {
    this.#replayChars = Math.max(1, replayChars);
  }

  /**
   * Increments once per non-empty append, and never goes backwards — not even across a reset.
   *
   * The cheap answer to "has anything arrived since?", which is the whole of the stall observation:
   * it used to be a retained copy of the replay compared character by character. Monotonic because a
   * counter that restarts can collide with the value a reader is holding, and a stall clock that
   * fails to reset is a worker reported as stuck that is not.
   */
  get version(): number {
    return this.#version;
  }

  /**
   * Fold one PTY chunk in, as the bytes arrived.
   *
   * A PTY hands back arbitrary byte boundaries, so a multi-byte character can be split across two
   * chunks. Decoding each chunk on its own would turn that character into replacement bytes and
   * corrupt the very text every reading here is drawn from; the decoder holds the partial sequence
   * until the rest of it arrives.
   */
  appendBytes(chunk: Buffer): void {
    this.append(this.#decoder.write(chunk));
  }

  /** Drop everything and read one replay from the start. Used when a session adopts a new PTY. */
  reset(replay = ""): void {
    this.#decoder = new StringDecoder("utf8");
    this.#markers.clear();
    this.#rawMarkers.clear();
    this.#rawSeam = "";
    this.#rawOffset = 0;
    this.#carry = "";
    this.#stripped = "";
    this.#strippedOffset = 0;
    this.#normalized = "";
    this.#normalizedOffset = 0;
    this.#frameOffset = 0;
    this.#braille = -1;
    this.#title = undefined;
    this.#titleAt = -1;
    this.#tokens = undefined;
    this.#discardingOsc = false;
    this.#oscSeam = "";
    if (replay !== "") this.append(replay);
  }

  /**
   * Fold one PTY chunk in.
   *
   * The chunk is not stripped as it stands. A control sequence split across two chunks would be
   * stripped by neither half, so the trailing fragment is withheld and prepended to the next chunk.
   * That is the whole correctness condition for stripping incrementally: no match may straddle the
   * cut, and the cut is placed where none can.
   *
   * An OSC that outgrows the carry gets its payload discarded rather than consumed. The carry is
   * bounded, and past that bound a still-unterminated sequence used to be handed to the visible-text
   * path — but its terminator arrives in a later chunk, so `stripTerminalControl` never sees a whole
   * sequence and never removes the prefix. An OSC 52 clipboard payload big enough to reach that
   * bound would then land in the activity, composer, liveness and fallback-result readings as if the
   * provider had printed it, and payload text shaped like a fatal error would mark the session
   * errored. So the opener and everything after it is thrown away until the terminator shows up,
   * which costs one retained character and reaches the same visible text the terminator would have.
   */
  append(chunk: string): void {
    if (chunk.length === 0) return;
    this.#version += 1;
    this.#ingestRaw(chunk);

    let text = chunk;
    if (this.#discardingOsc) {
      const search = this.#oscSeam + chunk;
      const resume = oscTerminatorEnd(search);
      if (resume < 0) {
        this.#oscSeam = chunk.slice(-1);
        return;
      }
      this.#discardingOsc = false;
      this.#oscSeam = "";
      text = search.slice(resume);
    }

    const pending = this.#carry + text;
    const cut = consumableEnd(pending);
    let consumable: string;
    if (pending.length - cut.at <= ReplayDigest.MAX_CARRY_CHARS) {
      this.#carry = pending.slice(cut.at);
      consumable = pending.slice(0, cut.at);
    } else if (cut.osc) {
      this.#carry = "";
      this.#discardingOsc = true;
      this.#oscSeam = pending.slice(-1);
      consumable = pending.slice(0, cut.at);
    } else {
      // Not an OSC: a CSI or a shorter escape this long is not a sequence any provider is writing,
      // and consuming it as text is what the whole-replay strip would have done with it anyway.
      this.#carry = "";
      consumable = pending;
    }
    if (consumable.length === 0) return;

    // Raw coordinates, so the title ages against the same stream the PTY replay buffer bounds.
    const consumableStart = this.#rawOffset - pending.length;
    for (const match of consumable.matchAll(OSC_TITLE)) {
      this.#title = match[1];
      this.#titleAt = consumableStart + match.index;
    }

    // Split at the last clear-screen so the frame boundary is exact rather than chunk-aligned. The
    // split lands on the first byte of an escape sequence, so neither half loses a match.
    const clearAt = consumable.lastIndexOf(CLEAR_SCREEN);
    if (clearAt < 0) {
      this.#ingest(consumable, false);
      return;
    }
    this.#ingest(consumable.slice(0, clearAt), false);
    this.#ingest(consumable.slice(clearAt), true);
  }

  /** The stripped tail, at most `limit` characters, and whether anything was cut from its head. */
  strippedTail(limit: number): { text: string; truncated: boolean } {
    const streamLength = this.#strippedOffset + this.#stripped.length;
    if (limit >= streamLength) return { text: this.#stripped, truncated: this.#strippedOffset > 0 };
    return { text: this.#stripped.slice(this.#stripped.length - limit), truncated: true };
  }

  /**
   * Normalized text since the last clear-screen, bounded by the retained tail.
   *
   * A provider that scrolls instead of clearing has no frame boundary to find, and this hands back
   * the tail rather than everything it ever printed. Every reader of a frame is asking about the
   * screen in front of the operator, which is a few dozen lines.
   */
  frameText(): string {
    const boundary = Math.max(this.#frameOffset - this.#normalizedOffset, 0);
    const start = Math.max(boundary, this.#normalized.length - ReplayDigest.FRAME_CHARS);
    return start <= 0 ? this.#normalized : this.#normalized.slice(start);
  }

  /** Last token counter the provider rendered, or undefined if it has never rendered one. */
  tokenCount(): number | undefined {
    return this.#tokens;
  }

  lastIndexOf(marker: ActivityMarker): number {
    return this.#markers.get(marker) ?? -1;
  }

  lastRawIndexOf(marker: ActivityMarker): number {
    return this.#rawMarkers.get(marker) ?? -1;
  }

  lastBrailleIndex(): number {
    return this.#braille;
  }

  lastTitle(): string | undefined {
    if (this.#title === undefined) return undefined;
    if (this.#rawOffset - this.#titleAt > this.#replayChars) {
      this.#title = undefined;
      this.#titleAt = -1;
      return undefined;
    }
    return this.#title;
  }

  blockedPromptIndex(provider: ProviderId): number {
    const { text } = this.strippedTail(BLOCKED_PROMPT_TAIL_CHARS);
    const tailStart = this.#strippedOffset + this.#stripped.length - text.length;
    const index = blockedPromptIndexInTail(provider, text);
    return index < 0 ? -1 : tailStart + index;
  }

  /**
   * Track markers in the *raw* stream, before anything is stripped.
   *
   * Cursor announces that it is waiting inside an OSC notification, which stripping deletes, so its
   * markers can only be found here. This coordinate space is its own: a raw offset is never compared
   * against a stripped one, and {@link markerTerminalActivity} keeps each provider on one of them.
   */
  #ingestRaw(chunk: string): void {
    const base = this.#rawOffset - this.#rawSeam.length;
    const search = this.#rawSeam + chunk;
    for (const marker of ACTIVITY_MARKERS) {
      const at = search.lastIndexOf(marker);
      if (at >= 0) this.#rawMarkers.set(marker, base + at);
    }
    this.#rawOffset += chunk.length;
    this.#rawSeam = search.slice(Math.max(0, search.length - ReplayDigest.#OVERLAP_CHARS));
  }

  #ingest(segment: string, startsFrame: boolean): void {
    if (startsFrame) this.#frameOffset = this.#normalizedOffset + this.#normalized.length;
    if (segment.length === 0) return;

    const stripped = stripTerminalControl(segment);
    const normalized = plainTerminalText(segment);

    // Search across the seam, not just the new text: a marker whose first half arrived in an
    // earlier chunk is still a marker on the operator's screen.
    const strippedSeam = Math.max(0, this.#stripped.length - ReplayDigest.#OVERLAP_CHARS);
    const strippedBase = this.#strippedOffset + strippedSeam;
    const strippedSearch = this.#stripped.slice(strippedSeam) + stripped;
    for (const marker of ACTIVITY_MARKERS) {
      const at = strippedSearch.lastIndexOf(marker);
      if (at >= 0) this.#markers.set(marker, strippedBase + at);
    }
    const braille = lastBrailleIndex(strippedSearch);
    if (braille >= 0) this.#braille = strippedBase + braille;

    const normalizedSeam = Math.max(0, this.#normalized.length - TOKEN_COUNT_MAX_SPAN);
    const tokens = plainTokenCount(this.#normalized.slice(normalizedSeam) + normalized);
    if (tokens !== undefined) this.#tokens = tokens;

    this.#stripped += stripped;
    this.#normalized += normalized;
    this.#trim();
  }

  /**
   * Trim only once a tail has doubled, so the cost of copying it is amortized across the characters
   * that earned it. Trimming on every append would put the tail length back into the per-chunk cost
   * this class exists to remove.
   */
  #trim(): void {
    const limit = ReplayDigest.TAIL_CHARS * 2;
    if (this.#stripped.length > limit) {
      const drop = this.#stripped.length - ReplayDigest.TAIL_CHARS;
      this.#stripped = this.#stripped.slice(drop);
      this.#strippedOffset += drop;
    }
    if (this.#normalized.length > limit) {
      const drop = this.#normalized.length - ReplayDigest.TAIL_CHARS;
      this.#normalized = this.#normalized.slice(drop);
      this.#normalizedOffset += drop;
    }
  }
}

const CLEAR_SCREEN = "\u001b[2J";
const OSC_OPENER = "\u001b]";
const OSC_BEL = "\u0007";
const OSC_ST = "\u001b\\";

/** An OSC that has arrived in full, anchored at its opener. */
const TERMINATED_OSC = /^\u001b\][^\u0007]*(?:\u0007|\u001b\\)/u;

/**
 * A complete control sequence, anchored at the escape that opens it.
 *
 * Mirrors the alternatives `stripTerminalControl` removes, with one deliberate narrowing: `[` and
 * `]` are excluded from the single-character escapes, because those two are openers. Accepting
 * `\u001b[` as whole would consume the head of a CSI and leave its parameters — `2J` — behind as
 * text. The whole-replay strip cannot make that mistake, because it never sees a cut sequence.
 */
const COMPLETE_SEQUENCE =
  /^(?:\u001b\][^\u0007]*(?:\u0007|\u001b\\)|\u001b\[[0-?]*[ -/]*[@-~]|\u001b(?:[()][0-9A-Z]|[@-Z\\^-_]))/u;

/**
 * Where the withheld tail of a chunk begins, and whether an unterminated OSC is what put it there.
 *
 * Three things can straddle a chunk boundary and be missed by both halves: an OSC whose terminator
 * has not arrived, a shorter escape sequence in the same state, and a carriage return whose newline
 * has not — normalization folds `CR LF` into one newline, so splitting between them would turn one
 * line break into two.
 *
 * The OSC case is reported separately because it is the only one of the three with an unbounded
 * payload, and so the only one {@link ReplayDigest.append} can be asked to discard instead of hold.
 */
function consumableEnd(value: string): { at: number; osc: boolean } {
  // An OSC payload can contain escapes of its own, so the last escape in the text is not
  // necessarily the one that opened the sequence still being written. Its opener is checked first.
  const osc = value.lastIndexOf(OSC_OPENER);
  if (osc >= 0 && !TERMINATED_OSC.test(value.slice(osc))) return { at: osc, osc: true };
  const escape = value.lastIndexOf("\u001b");
  if (escape >= 0 && !COMPLETE_SEQUENCE.test(value.slice(escape))) return { at: escape, osc: false };
  if (value.endsWith("\r")) return { at: value.length - 1, osc: false };
  return { at: value.length, osc: false };
}

/**
 * One past the first OSC terminator in `value`, or -1.
 *
 * First, not last: a reader that sees the stream once cannot know whether a later terminator is
 * coming, and stopping at the first one is what a terminal does. It is also the safe direction —
 * text after it is shown rather than swallowed.
 */
function oscTerminatorEnd(value: string): number {
  const bel = value.indexOf(OSC_BEL);
  const st = value.indexOf(OSC_ST);
  if (bel < 0) return st < 0 ? -1 : st + OSC_ST.length;
  if (st < 0 || bel < st) return bel + OSC_BEL.length;
  return st + OSC_ST.length;
}
