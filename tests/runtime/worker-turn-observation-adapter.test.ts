import { describe, expect, it } from "vitest";
import { WorkerTurnObservationAdapter } from "../../src/runtime/worker-turn-observation-adapter.js";

describe("WorkerTurnObservationAdapter", () => {
  it.each([
    ["codex", "› \n? for shortcuts  100% context left\n"],
    ["codex", "› Ask Codex to do anything\n100% context left\n"],
    ["claude", "─────────────────\n❯ \n─────────────────\n? for shortcuts\n"],
    ["claude", "❯ \n⏵⏵ bypass permissions on (shift+tab to cycle)\n"],
    ["claude", "❯ Try \"write a test for cli.ts\"\n────────────────────\n⏸ plan mode on (shift+tab to cycle)\n"],
    ["cursor", "→ Plan, search, build anything\n"],
    ["cursor", "→ Add a follow-up\n"],
    ["antigravity", "│ > Ask Gemini about this codebase │\n? for shortcuts\n"],
    ["claude", "│ > │\n"],
  ])("recognizes the empty %s input surface without borrowing an idle title", (provider, frame) => {
    const adapter = new WorkerTurnObservationAdapter();
    const replay = adapter.createReplay(128 * 1024);
    // Exercise incremental UTF-8 decoding, including a split in the prompt glyph.
    for (const byte of Buffer.from(frame)) replay.appendBytes(Buffer.from([byte]));
    expect(adapter.composer(provider!, replay)).toMatchObject({
      inputReady: true, occupied: false, modalOpen: false,
    });
  });

  it.each([
    ["codex", ""],
    ["claude", "\u001b]0;Claude\u0007Loading…\n"],
    ["codex", "› \nSelect a model\n  1. gpt-6.1-sol\n"],
    ["codex", "› \nA sentence quoting ? for shortcuts · more prose\n"],
    ["claude", "❯ operator draft\n? for shortcuts\n"],
    ["cursor", "→ /\n/run-everything Toggle Run Everything (currently enabled)\n"],
    ["codex", "› \n\u001b[2JLoading a replacement screen\n"],
    ["claude", "❯ \nDo you trust the contents of this project?\nEnter to confirm\n"],
    ["future-provider", "│ > │\n"],
  ])("keeps %s unknown screens, drafts, menus and modals unready", (provider, frame) => {
    const adapter = new WorkerTurnObservationAdapter();
    const replay = adapter.createReplay(128 * 1024);
    replay.appendBytes(Buffer.from(frame!));
    expect(adapter.composer(provider!, replay).inputReady).toBe(false);
  });

  it("keeps severed-tail provenance attached to the replay that produced it", () => {
    const adapter = new WorkerTurnObservationAdapter();
    const fatalText = "API Error: 401 authentication_error";
    const oversized = adapter.createReplay(128 * 1024);
    oversized.appendBytes(Buffer.from(`${"continuation ".repeat(400)}${fatalText}`));
    const severedTail = oversized.strippedTail(fatalText.length);
    expect(severedTail).toEqual({ text: fatalText, truncated: true });

    // Another session can be observed before this verdict is requested. Its tail must not replace
    // the truncation fact carried by the first replay and turn a severed fragment into a fatal line.
    const other = adapter.createReplay(128 * 1024);
    other.appendBytes(Buffer.from("healthy provider output\n"));
    other.strippedTail(4_000);

    expect(adapter.fatalTermination(severedTail, "2026-08-20T10:00:00.000Z"))
      .toBeUndefined();
  });

  it("reads Codex's positioned startup composer, not concatenated output or a loading frame", () => {
    const adapter = new WorkerTurnObservationAdapter();
    const replay = adapter.createReplay(128 * 1024);
    replay.appendBytes(Buffer.from("\u001b[?2026h\u001b[1;1H\u001b[J\u001b[3;6Hloading\u001b[6;1H› Ask Codex to do anything\u001b[?2026l"));
    expect(adapter.composer("codex", replay).inputReady).toBe(false);
    // Captured Codex 0.162.0 shape: rows are addressed rather than separated with LF. An idle
    // title alone, a half-painted synchronized frame, and the startup composer are not readiness.
    replay.appendBytes(Buffer.from("\u001b]0;workspace\u0007\u001b[?2026h\u001b[1;1H\u001b[J\u001b[11;1H/review - review any changes and find issues\u001b[14;1H› Ask Codex to do anything\u001b[16;1HGPT-6.1-Sol high · /tmp/workspace · ← f…"));
    expect(adapter.composer("codex", replay).inputReady).toBe(false);
    for (const byte of Buffer.from("\u001b[14;3H\u001b[?25h\u001b[?2026l")) replay.appendBytes(Buffer.from([byte]));
    expect(adapter.composer("codex", replay)).toMatchObject({ inputReady: true, occupied: false });
    // Replacing the screen with a picker erases readiness even without a CSI 2J.
    replay.appendBytes(Buffer.from("\u001b[1;1H\u001b[JSelect a model\u001b[3;1H❯ gpt-6.1-sol"));
    expect(adapter.composer("codex", replay).inputReady).toBe(false);
  });

  it("does not mistake a partial Claude trust selection for an empty composer", () => {
    const adapter = new WorkerTurnObservationAdapter();
    const replay = adapter.createReplay(128 * 1024);
    replay.appendBytes(Buffer.from("Quick safety check: Is this a project you created or one you trust?\n❯ "));
    expect(adapter.composer("claude", replay)).toMatchObject({ inputReady: false, modalOpen: true });
    replay.appendBytes(Buffer.from("No, exit\nYes, I trust this folder\nEnter to confirm · Esc to cancel\n"));
    expect(adapter.composer("claude", replay)).toMatchObject({ inputReady: false, modalOpen: true });
  });

  it("fails closed after unsupported screen edits until a full redraw, and resets per process", () => {
    const adapter = new WorkerTurnObservationAdapter();
    const replay = adapter.createReplay(128 * 1024);
    replay.appendBytes(Buffer.from("› \n? for shortcuts\n\u001b[1P"));
    expect(adapter.composer("codex", replay).inputReady).toBe(false);
    replay.appendBytes(Buffer.from("\u001b[1;1H\u001b[J› \n? for shortcuts\n"));
    expect(adapter.composer("codex", replay).inputReady).toBe(true);
    replay.reset("");
    expect(adapter.composer("codex", replay).inputReady).toBe(false);
  });

  it("preserves the occupied-composer hold when startup screen projection is unsupported", () => {
    const adapter = new WorkerTurnObservationAdapter();
    const replay = adapter.createReplay(128 * 1024);
    replay.appendBytes(Buffer.from("\u001b[1P│ > operator's unsent draft │\n? for shortcuts\n"));
    expect(adapter.composer("claude", replay)).toMatchObject({
      inputReady: false, occupied: true, content: "operator's unsent draft",
    });
  });
});
