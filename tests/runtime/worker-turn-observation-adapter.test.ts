import { describe, expect, it } from "vitest";
import { WorkerTurnObservationAdapter } from "../../src/runtime/worker-turn-observation-adapter.js";
import { PROVIDER_SCREENS, redraw } from "./provider-screen-fixtures.js";

describe("WorkerTurnObservationAdapter", () => {
  it("keeps Claude's composer readable after Kitty keyboard mode changes", () => {
    const adapter = new WorkerTurnObservationAdapter();
    const replay = adapter.createReplay(128 * 1024);
    const frame = "\u001b[<u\u001b[>1u\u001b[=1u\u001b[1;1HClaude Code v2.1.280\u001b[4;1H❯ \u001b[5;1H────────────────\u001b[6;1H⏵⏵ auto mode on (shift+tab to cycle) ◈ max · /effort";
    for (const byte of Buffer.from(frame)) replay.appendBytes(Buffer.from([byte]));
    expect(adapter.composer("claude", replay)).toMatchObject({ inputReady: true, occupied: false });
  });

  it("reads Codex's repainted empty composer after submitting a wrapped draft", () => {
    const adapter = new WorkerTurnObservationAdapter();
    const replay = adapter.createReplay(128 * 1024);
    replay.appendBytes(Buffer.from("\u001b[1;1H› Reply with exactly SECOND_ACK. Do not use tools\u001b[2;1H  or make changes.\u001b[4;1HGPT-6.1-Sol high · /tmp/repo"));
    expect(adapter.composer("codex", replay).occupied).toBe(true);
    replay.appendBytes(Buffer.from("\u001b[1;1H\u001b[J› Reply with exactly SECOND_ACK. Do not use tools\u001b[2;1H  or make changes.\u001b[4;1H• SECOND_ACK\u001b[6;1H› Ask Codex to do anything\u001b[8;1HGPT-6.1-Sol high · /tmp/repo"));
    expect(adapter.composer("codex", replay)).toMatchObject({ inputReady: true, occupied: false });
  });

  it.each(PROVIDER_SCREENS)("projects indented $provider busy/permission controls without homing an ED2 clear", ({ provider, modal, working }) => {
    const adapter = new WorkerTurnObservationAdapter();
    const replay = adapter.createReplay(128 * 1024);
    replay.appendBytes(Buffer.from("\u001b[8;11Hprevious screen\u001b[2J" + modal.map((row) => `   ${row}`).join("\r\n")));
    expect(adapter.activity(provider, replay)).toBe("needs-input");
    expect(adapter.composer(provider, replay)).toMatchObject({ modalOpen: true, inputReady: false });
    replay.appendBytes(Buffer.from("\u001b]0;⠹ busy\u0007\u001b[2J" + working.map((row) => `   ${row}`).join("\r\n")));
    expect(adapter.activity(provider, replay)).toBe("working");
    expect(adapter.composer(provider, replay).modalOpen).toBe(false);
  });

  it.each(["界", "e\u0301", "👩‍💻"])("does not authorize a cursor-addressed prompt after unmodeled glyph widths %j", (glyph) => {
    const adapter = new WorkerTurnObservationAdapter();
    const replay = adapter.createReplay(128 * 1024);
    replay.appendBytes(Buffer.from(redraw([`Answer ${glyph}`, "› ", "? for shortcuts"])));
    expect(adapter.activity("codex", replay)).toBe("unknown");
    expect(adapter.composer("codex", replay).inputReady).toBe(false);
    replay.appendBytes(Buffer.from(redraw(["Answer", "› ", "? for shortcuts"])));
    expect(adapter.composer("codex", replay).inputReady).toBe(true);
  });

  it.each(["\u001b[?1047h", "\u001b[1;2;3;4$z", "\u001b7"])("fails closed on unmodeled screen control %j", (control) => {
    const adapter = new WorkerTurnObservationAdapter();
    const replay = adapter.createReplay(128 * 1024);
    replay.appendBytes(Buffer.from(redraw(["› ", "? for shortcuts"]) + control));
    expect(adapter.activity("codex", replay)).toBe("unknown");
    expect(adapter.composer("codex", replay).inputReady).toBe(false);
  });

  it.each(PROVIDER_SCREENS)("removes a $provider modal via row erasure without a frame clear", ({ provider, modal, working }) => {
    const adapter = new WorkerTurnObservationAdapter();
    const replay = adapter.createReplay(128 * 1024);
    replay.appendBytes(Buffer.from(redraw(modal)));
    const eraseRows = modal.map((_, index) => `\u001b[${index + 1};1H\u001b[2K`).join("");
    replay.appendBytes(Buffer.from(eraseRows + redraw(working, "")));
    expect(adapter.activity(provider, replay)).toBe("working");
    expect(adapter.composer(provider, replay).modalOpen).toBe(false);
  });

  it.each(PROVIDER_SCREENS)("tracks $provider redraws without historical modal or composer evidence", ({ provider, modal, working, idle, draft }) => {
    for (const chunkSize of [1, 3, 7, 4096]) {
      const adapter = new WorkerTurnObservationAdapter();
      const replay = adapter.createReplay(128 * 1024);
      const append = (text: string) => {
        const bytes = Buffer.from(text);
        for (let index = 0; index < bytes.length; index += chunkSize) replay.appendBytes(bytes.subarray(index, index + chunkSize));
      };
      append(redraw(modal));
      expect(adapter.activity(provider, replay)).toBe("needs-input");
      expect(adapter.composer(provider, replay)).toMatchObject({ modalOpen: true, inputReady: false });
      append(redraw(working));
      expect(adapter.activity(provider, replay)).toBe("working");
      expect(adapter.composer(provider, replay).modalOpen).toBe(false);
      append(redraw(draft));
      expect(adapter.composer(provider, replay)).toMatchObject({ occupied: true, content: "operator's unsent draft", inputReady: false });
      // Row replacement and EL erase the draft without any display clear/frame boundary.
      append(redraw(idle, ""));
      expect(adapter.activity(provider, replay)).toBe("awaiting-input");
      expect(adapter.composer(provider, replay)).toMatchObject({ modalOpen: false, occupied: false, inputReady: true });
    }
  });

  it.each(["codex", "claude", "cursor", "antigravity"])("returns unknown activity after unsupported %s editing", (provider) => {
    const adapter = new WorkerTurnObservationAdapter();
    const replay = adapter.createReplay(128 * 1024);
    replay.appendBytes(Buffer.from(redraw(["Working", "esc to interrupt"]) + "\u001b[1P"));
    expect(adapter.activity(provider, replay)).toBe("unknown");
    expect(adapter.composer(provider, replay).inputReady).toBe(false);
  });

  it("orders Cursor notifications against a newer redraw and ignores clipboard payloads", () => {
    const adapter = new WorkerTurnObservationAdapter();
    const replay = adapter.createReplay(128 * 1024);
    replay.appendBytes(Buffer.from("\u001b]777;notify;Cursor;Cursor is waiting for you\u0007"));
    expect(adapter.activity("cursor", replay)).toBe("awaiting-input");
    replay.appendBytes(Buffer.from(redraw(["Composing 12 tokens", "ctrl+c to stop"])));
    expect(adapter.activity("cursor", replay)).toBe("working");
    replay.appendBytes(Buffer.from("\u001b]52;c;Cursor is waiting for you\u0007"));
    expect(adapter.activity("cursor", replay)).toBe("working");
  });

  it("does not let a working composer's repaint imply an idle transition", () => {
    const adapter = new WorkerTurnObservationAdapter();
    const replay = adapter.createReplay(128 * 1024);
    replay.appendBytes(Buffer.from(redraw(["Working… (esc to interrupt)", "› ", "? for shortcuts  98% context left"])));
    expect(adapter.activity("codex", replay)).toBe("working");
  });

  it.each([
    ["codex", "› \n? for shortcuts  100% context left\n"],
    ["codex", "› Ask Codex to do anything\n100% context left\n"],
    ["claude", "─────────────────\n❯ \n─────────────────\n? for shortcuts\n"],
    ["claude", "❯ \n⏵⏵ bypass permissions on (shift+tab to cycle)\n"],
    ["claude", "❯ \n⏵⏵ auto mode on (shift+tab to cycle)\n"],
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

  it("recognizes Claude's real cursor-positioned trust wording as a modal", () => {
    const adapter = new WorkerTurnObservationAdapter();
    const replay = adapter.createReplay(128 * 1024);
    replay.appendBytes(Buffer.from("Quick\u001b[8Gsafety\u001b[15Gcheck:\u001b[22GIs\u001b[25Gthis\u001b[30Ga\u001b[32Gproject\u001b[40Gyou\u001b[44Gcreated\u001b[52Gor\u001b[55Gone\u001b[59Gyou\u001b[63Gtrust?\n❯\u001b[3GNo,\u001b[7Gexit\nYes,\u001b[6GI\u001b[8Gtrust\u001b[14Gthis\u001b[19Gfolder\nEnter\u001b[7Gto\u001b[10Gconfirm\n"));
    expect(adapter.activity("claude", replay)).toBe("needs-input");
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
