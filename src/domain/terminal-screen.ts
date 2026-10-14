/**
 * Bounded, read-only provider screen. A stripped output stream is not a screen:
 * Codex draws separate rows with CUP instead of newlines and erases old prompts in place.
 * Unsupported screen edits invalidate the reading until a full clear; they never authorize input.
 * Transcript/result extraction remains separate from this current-state projection.
 */
export interface RenderedTerminalScreen {
  text: string;
  /** Raw stream position of the newest write in this rendered range, or -1. */
  writtenAt(start: number, end: number): number;
  /** Raw position of the clear establishing this screen, or -1 before the first clear. */
  clearedAt: number;
}

export class InputScreen {
  private lines: string[][] = [];
  private positions: number[][] = [];
  private offset = 0;
  private clearedAt = -1;
  private cached: RenderedTerminalScreen | undefined;
  private row = 0;
  private column = 0;
  private top = 0;
  private bottom = 199;
  private reliable = true;
  private updating = false;

  reset(): void {
    this.lines = [];
    this.positions = [];
    this.offset = 0;
    this.clearedAt = -1;
    this.cached = undefined;
    this.row = this.column = this.top = 0;
    this.bottom = 199;
    this.reliable = true;
    this.updating = false;
  }

  text(): string {
    return this.snapshot()?.text ?? "";
  }

  snapshot(): RenderedTerminalScreen | undefined {
    if (!this.reliable || this.updating) return undefined;
    if (this.cached !== undefined) return this.cached;
    const rows = Array.from(this.lines, (line) => line?.join("").trimEnd() ?? "");
    const positions: number[] = [];
    for (let row = 0; row < rows.length; row += 1) {
      positions.push(...(this.positions[row] ?? []).slice(0, rows[row]!.length), -1);
    }
    return this.cached = {
      text: rows.join("\n"), clearedAt: this.clearedAt,
      writtenAt: (start, end) => {
        let at = -1;
        for (let index = start; index < end; index += 1) at = Math.max(at, positions[index] ?? -1);
        return at;
      },
    };
  }

  /** Receives complete escape sequences, after ReplayDigest's UTF-8 and control-sequence carry. */
  append(segment: string, offset = this.offset): void {
    this.cached = undefined;
    const tokens = /\u001b\](?:[^\u0007\u001b]|\u001b(?!\\))*(?:\u0007|\u001b\\)|\u001b\[([0-?]*)([ -/]*)([@-~])|\u001b(?:[()][0-9A-Z]|[@-Z\\^-_])|[^\u001b]+/gu;
    let consumed = 0;
    for (const token of segment.matchAll(tokens)) {
      if (token.index !== consumed) this.reliable = false;
      consumed = token.index + token[0].length;
      if (token[1] !== undefined) {
        this.control(token[1], token[2]!, token[3]!, offset + token.index);
      } else if (token[0] === "\u001bM") {
        if (this.row === this.top) {
          this.lines.length = Math.max(this.lines.length, this.bottom + 1);
          this.positions.length = Math.max(this.positions.length, this.bottom + 1);
          this.lines.splice(this.top, 0, []);
          this.positions.splice(this.top, 0, []);
          this.lines.splice(this.bottom + 1, 1);
          this.positions.splice(this.bottom + 1, 1);
        }
        else this.row = Math.max(0, this.row - 1);
        this.lines.length = Math.min(this.lines.length, 200);
        this.positions.length = Math.min(this.positions.length, 200);
      } else if (!token[0].startsWith("\u001b")) {
        let at = offset + token.index;
        for (const character of token[0]) {
          this.print(character, at);
          at += character.length;
        }
      }
    }
    if (consumed !== segment.length) this.reliable = false;
    this.offset = offset + segment.length;
  }

  private print(character: string, at: number): void {
    if (character === "\r") { this.column = 0; return; }
    if (character === "\n") {
      this.column = 0;
      if (this.row === this.bottom) {
        this.lines.length = Math.max(this.lines.length, this.bottom + 1);
        this.positions.length = Math.max(this.positions.length, this.bottom + 1);
        this.lines.splice(this.top, 1);
        this.lines.splice(this.bottom, 0, []);
        this.positions.splice(this.top, 1);
        this.positions.splice(this.bottom, 0, []);
      } else this.row = Math.min(199, this.row + 1);
      return;
    }
    if (character === "\b") { this.column = Math.max(0, this.column - 1); return; }
    if (character === "\t") { this.column = Math.min(511, (Math.floor(this.column / 8) + 1) * 8); return; }
    if (character < " ") return;
    // This small projection has no grapheme/terminal-width engine. Do not claim cursor-addressed
    // state after glyphs whose cells it cannot count, even when later ASCII looks like a prompt.
    if (character.length > 1 || /[\p{Mark}\p{Cf}\u1100-\u115f\u2329-\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/u.test(character)) {
      this.reliable = false;
    }
    if (this.column + character.length > 512) { this.reliable = false; return; }
    const line = this.lines[this.row] ??= [];
    const positions = this.positions[this.row] ??= [];
    while (line.length < this.column) { line.push(" "); positions.push(-1); }
    // UTF-16 offsets in the snapshot and the replay must agree for ordering OSC and screen writes.
    for (const unit of character.split("")) {
      line[this.column] = unit;
      positions[this.column++] = at;
    }
  }

  private control(parameters: string, intermediate: string, command: string, at: number): void {
    // Colors, cursor style, queries and keyboard/mouse modes do not edit the screen.
    // Kitty keyboard push/pop/set flags change input encoding, never rendered cells.
    if (intermediate === "" && command === "u" && /^[<=>][\d;]*$/u.test(parameters)) return;
    if (parameters.startsWith("?") || parameters.startsWith(">") || intermediate !== "") {
      if (parameters === "?2026" && (command === "h" || command === "l")) {
        this.updating = command === "h";
      } else if (/^\?(?:47|1047|1049)$/u.test(parameters) && (command === "h" || command === "l")) {
        this.lines = []; this.positions = []; this.reliable = false;
      } else if (parameters === "?6" && command === "h") {
        this.reliable = false;
      } else if (!("hmnlcu".includes(command) || (intermediate === " " && command === "q"))) {
        // Rectangular erases and unfamiliar edits may carry intermediate/private bytes too.
        this.reliable = false;
      }
      return;
    }
    const values = parameters.split(";").map((value) => Number(value));
    const count = values[0] || 1;
    switch (command) {
      case "H": case "f": this.row = count - 1; this.column = (values[1] || 1) - 1; break;
      case "A": this.row = Math.max(0, this.row - count); break;
      case "B": this.row += count; break;
      case "C": this.column += count; break;
      case "D": this.column = Math.max(0, this.column - count); break;
      case "G": this.column = count - 1; break;
      case "d": this.row = count - 1; break;
      case "J": {
        const mode = values[0] ?? 0;
        if (mode === 2 || (mode === 0 && this.row === 0 && this.column === 0)) {
          this.lines = []; this.positions = []; this.reliable = true; this.clearedAt = at;
        } else if (mode === 0) {
          this.lines.length = Math.min(this.lines.length, this.row + 1);
          this.positions.length = Math.min(this.positions.length, this.row + 1);
          this.eraseLine(0);
        } else this.reliable = false;
        break;
      }
      case "K": this.eraseLine(values[0] ?? 0); break;
      case "r": this.top = count - 1; this.bottom = (values[1] || 200) - 1; break;
      case "h": if (parameters === "4") this.reliable = false; break;
      case "m": case "n": case "c": case "l": break;
      default: this.reliable = false;
    }
    if (this.row > 199 || this.column > 511 || this.bottom > 199 || this.top > this.bottom) {
      this.reliable = false;
      this.row = Math.min(199, this.row); this.column = Math.min(511, this.column);
    }
  }

  private eraseLine(mode: number): void {
    const line = this.lines[this.row];
    if (line === undefined) return;
    const positions = this.positions[this.row]!;
    if (mode === 0) { line.length = Math.min(line.length, this.column); positions.length = line.length; }
    else if (mode === 2) { this.lines[this.row] = []; this.positions[this.row] = []; }
    else if (mode === 1) { line.fill(" ", 0, this.column + 1); positions.fill(-1, 0, this.column + 1); }
    else this.reliable = false;
  }
}
