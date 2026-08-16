import { describe, expect, it } from "vitest";

import { frameComposerState, terminalComposerState } from "../../src/runtime/composer-state.js";
import { ReplayDigest } from "../../src/runtime/replay-digest.js";
import {
  TAIL_BYTES,
  detectProviderLimitTermination,
  detectProviderLimitTerminationInTail,
  detectSessionFatalError,
  detectSessionFatalErrorInTail,
} from "../../src/runtime/session-liveness.js";
import {
  compactFrameResult,
  compactTerminalResult,
  markerTerminalActivity,
  providerTerminalActivity,
  terminalTokenCount,
} from "../../src/runtime/terminal-replay.js";
import type { ProviderId } from "../../src/domain/session.js";

/** Feed a replay through the digest in fixed-size pieces, as a PTY would deliver it. */
function fed(replay: string, size: number): ReplayDigest {
  const digest = new ReplayDigest();
  for (let at = 0; at < replay.length; at += size) digest.append(replay.slice(at, at + size));
  return digest;
}

const PROVIDERS: readonly ProviderId[] = ["claude", "codex", "cursor", "antigravity"];

/**
 * Chunk sizes that split things the reading depends on: 1 cuts every escape sequence and every
 * marker, 3 and 7 land mid-sequence at unaligned offsets, 4096 is one whole delivery.
 */
const CHUNK_SIZES = [1, 3, 7, 64, 4_096];

const REPLAYS = [
  `\u001b[2J\u001b[H⠋ Working (esc to interrupt) \u001b[0m\n`,
  `\u001b[2J\u001b[H> ready\nAdd a follow-up\n`,
  `\u001b[2J\u001b[H> ready\n? for shortcuts\n`,
  `\u001b[2Jesc to interrupt\n\u001b[2JAdd a follow-up\n`,
  `\u001b]777;notify;Cursor;Cursor is waiting for you\u0007`,
  `\u001b[2J╭────╮\n│ > Composing \u001b[0m │\n╰────╯\n`,
  `\u001b[2JDo you want to proceed?\n❯ 1. Yes\n  2. No\n`,
];

describe("ReplayDigest", () => {
  it("reads the same activity as a whole-replay scan, at every chunk boundary", () => {
    for (const replay of REPLAYS) {
      for (const provider of PROVIDERS) {
        const whole = providerTerminalActivity(provider, replay);
        for (const size of CHUNK_SIZES) {
          expect(
            markerTerminalActivity(provider, fed(replay, size)),
            `${provider} at chunk size ${size}: ${JSON.stringify(replay)}`,
          ).toBe(whole);
        }
      }
    }
  });

  it("reads the same token count as a whole-replay scan", () => {
    const replay = `\u001b[2Jthinking… 12.4k tokens\u001b[0m\nmore output\n· 1,234 tokens ·\n`;
    for (const size of CHUNK_SIZES) {
      expect(fed(replay, size).tokenCount()).toBe(terminalTokenCount(replay));
    }
    expect(terminalTokenCount(replay)).toBe(1_234);
  });

  it("reads the same composer state as a whole-replay scan", () => {
    const replay = `\u001b[2Jassistant output\n╭──────╮\n│ > write the tests │\n╰──────╯\n`
      + `tab to queue message\n`;
    const whole = terminalComposerState("claude", replay, { modalOpen: false });
    expect(whole.occupied).toBe(true);
    for (const size of CHUNK_SIZES) {
      expect(frameComposerState("claude", fed(replay, size).frameText(), { modalOpen: false }))
        .toEqual(whole);
    }
  });

  it("keeps the frame boundary at the last clear-screen, not at a chunk edge", () => {
    const replay = `\u001b[2Jold frame text\n\u001b[2Jnew frame text\n`;
    for (const size of CHUNK_SIZES) {
      const frame = fed(replay, size).frameText();
      expect(frame).toContain("new frame text");
      expect(frame).not.toContain("old frame text");
      expect(compactFrameResult(frame)).toBe(compactTerminalResult(replay));
    }
  });

  it("hands session-liveness the same tail a whole-replay strip would have", () => {
    const fatal = `\u001b[2Jrunning\nAPI Error: 401 {"type":"authentication_error"}\n`;
    const limit = `\u001b[2Jrunning\nClaude usage limit reached. Your limit will reset at 3pm.\n`;
    for (const size of CHUNK_SIZES) {
      expect(detectSessionFatalErrorInTail(fed(fatal, size).strippedTail(TAIL_BYTES)))
        .toEqual(detectSessionFatalError(fatal));
      expect(detectProviderLimitTerminationInTail(fed(limit, size).strippedTail(TAIL_BYTES)))
        .toEqual(detectProviderLimitTermination(limit));
    }
    expect(detectSessionFatalError(fatal)?.reason).toBe("provider authentication failed");
    expect(detectProviderLimitTermination(limit)?.kind).toBe("session-limit");
  });

  it("holds a multi-byte character until the rest of its bytes arrive", () => {
    const text = "héllo — ✓ ⠋\n";
    const digest = new ReplayDigest();
    for (const byte of Buffer.from(text, "utf8")) digest.appendBytes(Buffer.from([byte]));
    expect(digest.frameText()).toBe(text);
  });

  it("keeps per-chunk cost flat as the stream accumulates", () => {
    const digest = new ReplayDigest();
    const chunk = `\u001b[2K\r⠋ Working (esc to interrupt) · 1234 tokens · ${"x".repeat(600)}\n`;
    const feed = (count: number): number => {
      const started = performance.now();
      for (let index = 0; index < count; index += 1) digest.append(chunk);
      return performance.now() - started;
    };

    const early = feed(100);
    // ~1 MB of accumulated output: an order of magnitude past both the retained tail below and the
    // replay buffer the old reading re-scanned in full on every chunk.
    feed(1_200);
    const late = feed(100);

    // The retained state is a tail, not a transcript. This is what makes the cost above flat.
    expect(digest.strippedTail(Number.MAX_SAFE_INTEGER).text.length)
      .toBeLessThanOrEqual(ReplayDigest.TAIL_CHARS * 2);
    // Generous, because this is a wall-clock reading on a shared machine. The behaviour it rules
    // out grows with the stream, so it fails by orders of magnitude, not by a few percent.
    expect(late).toBeLessThan(Math.max(early * 5, 25));
  });

  it("stops reporting a title once it has scrolled out of the replay window", () => {
    const window = 4_096;
    const head = "\u001b[2J\u001b]0;\u280b Working\u0007";
    const tail = `${"x".repeat(window)}\n> ready\nAdd a follow-up\n`;

    const digest = new ReplayDigest(window);
    digest.append(head);
    expect(digest.lastTitle()).toBe("\u280b Working");
    // A spinner named in the title outranks every marker, so the verdict is working while it lasts.
    expect(markerTerminalActivity("claude", digest)).toBe("working");

    for (let at = 0; at < tail.length; at += 64) digest.append(tail.slice(at, at + 64));

    // The replay buffer has scrolled the title away, and so has the digest: the waiting marker that
    // arrived after it decides the turn instead of losing to a title nothing can still see.
    expect(digest.lastTitle()).toBeUndefined();
    expect(markerTerminalActivity("claude", digest))
      .toBe(providerTerminalActivity("claude", `${head}${tail}`.slice(-window)));
    expect(markerTerminalActivity("claude", digest)).toBe("awaiting-input");
  });

  it("keeps a title that is still inside the replay window", () => {
    const digest = new ReplayDigest(4_096);
    digest.append("\u001b[2J\u001b]0;\u280b Working\u0007");
    digest.append(`${"x".repeat(1_000)}\nAdd a follow-up\n`);
    expect(digest.lastTitle()).toBe("\u280b Working");
    expect(markerTerminalActivity("claude", digest)).toBe("working");
  });

  it("discards an oversized OSC payload instead of reading it as provider output", () => {
    // An OSC 52 clipboard write far past MAX_CARRY_CHARS, carrying text shaped like a fatal error.
    const payload = `API Error: 401 {"type":"authentication_error"} ${"QUJDRA".repeat(12_000)}`;
    const replay = `\u001b[2Jvisible head\n\u001b]52;c;${payload}\u0007visible tail\n`;
    expect(detectSessionFatalError(replay)).toBeUndefined();

    for (const size of CHUNK_SIZES) {
      const digest = fed(replay, size);
      const at = `at chunk size ${size}`;
      const frame = digest.frameText();
      expect(frame, at).toContain("visible head");
      expect(frame, at).toContain("visible tail");
      expect(frame, at).not.toContain("QUJDRA");
      // Not into liveness either: a clipboard payload is not a session that failed to authenticate.
      expect(detectSessionFatalErrorInTail(digest.strippedTail(TAIL_BYTES)), at)
        .toEqual(detectSessionFatalError(replay));
      // And none of it is retained — the digest holds the visible text, not the 72 KB it threw away.
      expect(digest.strippedTail(Number.MAX_SAFE_INTEGER).text.length, at).toBeLessThan(200);
    }
  });

  it("forgets the previous process when a session adopts a new PTY", () => {
    const digest = new ReplayDigest();
    digest.append(`\u001b[2J⠋ Working (esc to interrupt)\n`);
    expect(markerTerminalActivity("claude", digest)).toBe("working");

    digest.reset(`\u001b[2J> ready\nAdd a follow-up\n`);
    expect(markerTerminalActivity("claude", digest)).toBe("awaiting-input");
    // The revision counter is monotonic across a reset: a reader holding an old value must never
    // see it come round again and read an unchanged stream.
    expect(digest.version).toBe(2);
    expect(digest.tokenCount()).toBeUndefined();
  });

  it("counts one revision per non-empty chunk", () => {
    const digest = new ReplayDigest();
    digest.append("a");
    digest.append("");
    digest.append("b");
    expect(digest.version).toBe(2);
  });
});
