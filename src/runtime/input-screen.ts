/**
 * Bounded, read-only screen for startup readiness. A stripped output stream is not a screen:
 * Codex draws separate rows with CUP instead of newlines and erases old prompts in place.
 * Unsupported screen edits invalidate the reading until a full clear; they never authorize input.
 * Activity and transcript/result extraction continue to use ReplayDigest's existing stream.
 */
export class InputScreen {
  private lines: string[][] = [];
  private row = 0;
  private column = 0;
  private top = 0;
  private bottom = 199;
  private reliable = true;
  private updating = false;

  reset(): void {
    this.lines = [];
    this.row = this.column = this.top = 0;
    this.bottom = 199;
    this.reliable = true;
    this.updating = false;
  }

  text(): string {
    return this.reliable && !this.updating
      ? this.lines.map((line) => line.join("").trimEnd()).join("\n") : "";
  }

  /** Receives complete escape sequences, after ReplayDigest's UTF-8 and control-sequence carry. */
  append(segment: string): void {
    const tokens = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)|\u001b\[([0-?]*)([ -/]*)([@-~])|\u001b(?:[()][0-9A-Z]|[@-Z\\^-_])|[^\u001b]+/gu;
    for (const token of segment.matchAll(tokens)) {
      if (token[1] !== undefined) {
        this.control(token[1], token[2]!, token[3]!);
      } else if (token[0] === "\u001bM") {
        if (this.row === this.top) this.lines.splice(this.top, 0, []);
        else this.row = Math.max(0, this.row - 1);
        this.lines.length = Math.min(this.lines.length, 200);
      } else if (!token[0].startsWith("\u001b")) {
        for (const character of token[0]) this.print(character);
      }
    }
  }

  private print(character: string): void {
    if (character === "\r") { this.column = 0; return; }
    if (character === "\n") {
      this.column = 0;
      if (this.row === this.bottom) {
        this.lines.splice(this.top, 1);
        this.lines.splice(this.bottom, 0, []);
      } else this.row = Math.min(199, this.row + 1);
      return;
    }
    if (character === "\b") { this.column = Math.max(0, this.column - 1); return; }
    if (character === "\t") { this.column = Math.min(511, (Math.floor(this.column / 8) + 1) * 8); return; }
    if (character < " ") return;
    if (this.column >= 512) { this.reliable = false; return; }
    const line = this.lines[this.row] ??= [];
    while (line.length < this.column) line.push(" ");
    line[this.column++] = character;
  }

  private control(parameters: string, intermediate: string, command: string): void {
    // Colors, cursor style, queries and keyboard/mouse modes do not edit the screen.
    if (parameters.startsWith("?") || parameters.startsWith(">") || intermediate !== "") {
      if (parameters === "?2026" && (command === "h" || command === "l")) {
        this.updating = command === "h";
      } else if (parameters === "?1049" && (command === "h" || command === "l")) {
        this.lines = []; this.reliable = false;
      } else if (parameters === "?6" && command === "h") {
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
          this.lines = []; this.reliable = true;
        } else if (mode === 0) {
          this.lines.length = Math.min(this.lines.length, this.row + 1);
          this.eraseLine(0);
        } else this.reliable = false;
        break;
      }
      case "K": this.eraseLine(values[0] ?? 0); break;
      case "r": this.top = count - 1; this.bottom = (values[1] || 200) - 1; break;
      case "m": case "n": case "c": case "h": case "l": break;
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
    if (mode === 0) line.length = Math.min(line.length, this.column);
    else if (mode === 2) this.lines[this.row] = [];
    else if (mode === 1) line.fill(" ", 0, this.column + 1);
    else this.reliable = false;
  }
}
