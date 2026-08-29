import { stripTerminalControl } from "../../domain/terminal-replay.js";
import { displayWidth } from "../display-width.js";
import { COMPOSER_PROMPTS, ComposerMode, renderComposerLines } from "./render-composer.js";
import { renderFleet } from "./render-frame.js";
import { PREVIEW_REPAINT_INTERVAL_MS } from "./runtime-frame.js";
import { FleetState } from "./state.js";

export function waitForRefresh(register: (wake: () => void) => void, clear: () => void): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      clear();
      resolve();
    }, PREVIEW_REPAINT_INTERVAL_MS);
    register(() => {
      clearTimeout(timer);
      clear();
      resolve();
    });
  });
}

/**
 * The composer that owns text input in the rendered frame, or nothing when none does.
 *
 * The precedence is {@link renderFleet}'s own, not a second opinion about it: a picker that renders
 * instead of the list collects arrow keys, not text, and the two surfaces that do render a composer
 * row — the list's footer and the command palette — must be read for the same draft the row shows.
 */
export function composerFocus(state: FleetState): { mode: ComposerMode; value: string; } | undefined {
  if (state.view !== "fleet") return undefined;
  if (state.workerPicker !== undefined || state.permissionPicker !== undefined) return undefined;
  if (state.commandPalette !== undefined) return { mode: "task", value: state.draft };
  if (state.orchestratorPicker !== undefined || state.handoffPicker !== undefined) return undefined;
  if (state.rename !== undefined) return { mode: "rename", value: state.rename.draft };
  if (state.projectPrompt !== undefined) return { mode: "project", value: state.projectPrompt.draft };
  if (state.shellMode !== undefined) return { mode: "shell", value: state.shellMode.draft };
  return { mode: "task", value: state.draft };
}

/**
 * Where the caret belongs in the rendered frame, or nothing when no composer owns it.
 *
 * The column is counted in terminal cells rather than code points, because that is what the `CUP`
 * sequence addresses: a draft holding an ideograph or an emoji is wider on screen than it is long
 * in JavaScript, and counting the string would park the caret inside the text the operator typed.
 */
export function composerCursor(
  rendered: string,
  state: FleetState,
  width: number,
): { row: number; column: number; } | undefined {
  const focus = composerFocus(state);
  if (focus === undefined) return undefined;
  const lines = rendered.split("\n");
  const expectedComposerRow = renderComposerLines(focus.value, focus.mode, {
    width,
    height: lines.length,
    now: 0,
    color: false,
    home: "",
    pullRequests: new Map(),
    background: undefined,
  }).at(-1);
  const rowIndex = expectedComposerRow === undefined
    ? -1
    : lines.findLastIndex((line) =>
      stripTerminalControl(line) === stripTerminalControl(expectedComposerRow));
  if (rowIndex === -1) return undefined;
  const visibleLine = stripTerminalControl(lines[rowIndex] ?? "");
  // An empty draft shows its placeholder, so the caret is placed off the prompt the composer wears
  // rather than off the end of copy the operator did not type.
  const emptyColumn = displayWidth(COMPOSER_PROMPTS[focus.mode].prefix) + 2;
  return {
    row: Math.max(1, rowIndex + 1),
    column: focus.value === ""
      ? emptyColumn
      : Math.min(width, displayWidth(visibleLine) + 1),
  };
}

/**
 * Stateful terminal-input decoder for the fleet composer.
 *
 * Provider TUIs can leave mouse/focus reporting enabled on the shared pane. Those reports are CSI
 * control sequences and may be split across arbitrary stdin chunks, so a per-chunk decoder would
 * turn their printable suffixes into task text. This decoder buffers incomplete escape sequences,
 * recognizes the fleet's navigation keys, and consumes every other complete CSI sequence.
 */
export class FleetKeyDecoder {
  private pending = "";

  get hasPendingInput(): boolean {
    return this.pending !== "";
  }

  push(bytes: Buffer | string): string[] {
    const value = this.pending + (Buffer.isBuffer(bytes) ? bytes.toString("utf8") : bytes);
    this.pending = "";
    return this.decode(value);
  }

  flush(): string[] {
    if (this.pending === "") return [];
    const pending = this.pending;
    this.pending = "";
    return pending === "\u001b" ? ["escape"] : [];
  }

  reset(): void {
    this.pending = "";
  }

  private decode(value: string): string[] {
    const keys: string[] = [];
    for (let index = 0; index < value.length;) {
      const rest = value.slice(index);
      const special = [
        ["\u001b[A", "up"],
        ["\u001b[B", "down"],
        ["\u001b[D", "left"],
        ["\u001b[C", "right"],
        ["\u001b[1;2A", "shift+up"],
        ["\u001b[1;2B", "shift+down"],
        ["\u001b[5~", "pageup"],
        ["\u001b[6~", "pagedown"],
        ["\u001b[H", "home"],
        ["\u001b[1~", "home"],
        ["\u001b[7~", "home"],
        ["\u001b[F", "end"],
        ["\u001b[4~", "end"],
        ["\u001b[8~", "end"],
      ] as const;
      const match = special.find(([sequence]) => rest.startsWith(sequence));
      if (match !== undefined) {
        keys.push(match[1]);
        index += match[0].length;
        continue;
      }
      if (rest.startsWith("\u001b[")) {
        const csi = /^\u001b\[[0-?]*[ -/]*[@-~]/u.exec(rest);
        if (csi === null) {
          this.pending = rest;
          break;
        }
        const csiKey = decodeCsiUKey(csi[0]);
        if (csiKey !== undefined) keys.push(csiKey);
        index += csi[0].length;
        continue;
      }
      // SS3 has its own three-byte shape. Consuming it whole keeps its final byte out of the draft.
      if (rest.startsWith("\u001bO")) {
        if (rest.length < 3) {
          this.pending = rest;
          break;
        }
        index += 3;
        continue;
      }
      if (rest === "\u001b") {
        this.pending = rest;
        break;
      }
      // An Esc that already has a byte behind it is the Meta prefix of a single chord, never Esc plus
      // that key. Resolving it here is what stops Option+Enter from clearing the draft and submitting.
      if (rest.startsWith("\u001b")) {
        if (rest.charCodeAt(1) === 0x1b) {
          keys.push("escape");
          index += 1;
          continue;
        }
        const chord = altChordKey(rest.charCodeAt(1), rest[1]!);
        if (chord !== undefined) keys.push(chord);
        index += 2;
        continue;
      }
      const code = value.charCodeAt(index);
      if (code === 0x03) keys.push("ctrl+c");
      else if (code === 0x04) keys.push("ctrl+d");
      else if (code === 0x07) keys.push("ctrl+g");
      else if (code === 0x0a) keys.push("ctrl+j");
      else if (code === 0x0c) keys.push("ctrl+l");
      else if (code === 0x0e) keys.push("ctrl+n");
      else if (code === 0x0f) keys.push("ctrl+o");
      else if (code === 0x12) keys.push("ctrl+r");
      else if (code === 0x13) keys.push("ctrl+s");
      else if (code === 0x14) keys.push("ctrl+t");
      else if (code === 0x15) keys.push("ctrl+u");
      else if (code === 0x16) keys.push("ctrl+v");
      else if (code === 0x17) keys.push("ctrl+w");
      else if (code === 0x18) keys.push("ctrl+x");
      else if (code === 0x1d) keys.push("ctrl+]");
      else if (code === 0x0d) keys.push("enter");
      // Tab is byte-identical to Ctrl+I, so this names one key, not two. It is bound only inside the
      // project prompt, where Ctrl+I completing a path as well costs the operator nothing.
      else if (code === 0x09) keys.push("tab");
      else if (code === 0x7f || code === 0x08) keys.push("backspace");
      else if (code >= 0x20) keys.push(value[index]!);
      index += 1;
    }
    return keys;
  }
}

/**
 * Decode a CSI-u key report into a fleet key name.
 *
 * A provider TUI can leave the terminal in a keyboard protocol that reports ordinary keys as
 * `CSI <code> ; <modifiers> u` rather than as bytes, and that mode outlives the attachment. Without
 * this the fleet swallowed every such report as an anonymous control sequence, so Esc did nothing
 * and Option+Enter did nothing — the same gesture behaving differently depending on which provider
 * the operator had visited last. Sequences that are not key reports stay consumed and unnamed.
 */
export function decodeCsiUKey(sequence: string): string | undefined {
  const report = /^\u001b\[(\d+)(?:;(\d+)(?::\d+)?)?u$/u.exec(sequence);
  if (report === null) return undefined;
  const code = Number(report[1]);
  const modifiers = report[2] === undefined ? 0 : Number(report[2]) - 1;
  const shift = (modifiers & 1) !== 0;
  const alt = (modifiers & 2) !== 0;
  const ctrl = (modifiers & 4) !== 0;
  if (code === 27) return "escape";
  if (code === 13 || code === 10) {
    if (alt) return "alt+enter";
    if (shift) return "shift+enter";
    return ctrl ? "ctrl+enter" : "enter";
  }
  if (code === 127 || code === 8) return "backspace";
  if (code === 9) return "tab";
  if (ctrl || code < 0x20) return undefined;
  const character = String.fromCodePoint(code);
  return alt ? `alt+${character}` : character;
}

/**
 * Name the single chord an Esc prefix forms with the byte behind it.
 *
 * Option is delivered either as this prefix or as a composed character; a composed character needs
 * no decoding, so this is the whole of Meta handling. Chords the fleet does not bind resolve to
 * `undefined` and are dropped, which is the point: an unbound chord must do nothing rather than
 * decay into its two halves and fire two bindings.
 */
export function altChordKey(code: number, character: string): string | undefined {
  if (code === 0x0d || code === 0x0a) return "alt+enter";
  if (code === 0x7f || code === 0x08) return "alt+backspace";
  if (code < 0x20) return undefined;
  return `alt+${character}`;
}
