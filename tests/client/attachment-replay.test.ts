import { describe, expect, it } from "vitest";
import { attachmentReplay } from "../../src/client/attachment-replay.js";

describe("attachment history", () => {
  it("does not reissue the Codex startup probes that produce fresh terminal input on attach", () => {
    const probes = "\u001b[6n\u001b]10;?\u001b\\\u001b]11;?\u001b\\\u001b[?u\u001b[c";
    const surface = "\u001b[?2004h\u001b[>4;0m\u001b[>7u\u001b[?1004h"
      + "\u001b[?2026h\u001b[1;1H› Ask Codex to do anything\u001b[?2026l";
    expect(attachmentReplay(Buffer.from(probes + surface))).toEqual(Buffer.from(surface));
  });

  it("removes both OSC terminators, secondary DA, version and mode queries", () => {
    const probes = "\u001b[>0c\u001b[0n\u001b[>0q\u001b[?2026$p"
      + "\u001b]10;?\u0007\u001b]12;?\u001b\\\u001b]4;2;?\u0007";
    expect(attachmentReplay(Buffer.from(probes))).toEqual(Buffer.alloc(0));
  });

  it("preserves UTF-8, drawing, hyperlinks, color assignments and keyboard modes byte for byte", () => {
    const display = Buffer.from("\u001b[H\u001b[2J› 👩‍💻 文言文\r\n\u001b[38;2;1;2;3mready"
      + "\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007"
      + "\u001b]10;rgb:ffff/ffff/ffff\u001b\\\u001b[>1u\u001b[<u\u001b[=1u");
    expect(attachmentReplay(display)).toBe(display);
  });
});
