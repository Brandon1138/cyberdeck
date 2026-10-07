import { spawnSync } from "node:child_process";
import { randomInt } from "node:crypto";
import { readFileSync } from "node:fs";

export const MASCOT_COLUMNS = 10;
export const MASCOT_ROWS = 4;

export interface TerminalMascotPlacement {
  columns: number;
  rows: readonly string[];
}

export interface TerminalMascot {
  placement: TerminalMascotPlacement;
  enter(): void;
  dispose(): void;
  setCursorVisible?(visible: boolean): void;
}

interface ImageOutput {
  isTTY?: boolean;
  write(chunk: string | Uint8Array): unknown;
}

// Kitty's rowcolumn-diacritics.txt, indices 0–9. These encode image coordinates, not image pixels.
const COORDINATES = [0x0305, 0x030d, 0x030e, 0x0310, 0x0312, 0x033d, 0x033e, 0x033f, 0x0346, 0x034a];
const PLACEHOLDER = "\u{10EEEE}";

/** tmux understands the placeholder text; only the image transfer bypasses its parser. */
export function graphicsEscape(command: string, inTmux: boolean): string {
  const sequence = `\u001b_G${command}\u001b\\`;
  return inTmux ? `\u001bPtmux;${sequence.replaceAll("\u001b", "\u001b\u001b")}\u001b\\` : sequence;
}

/** Upload a PNG without moving the caret or sending protocol replies into the key decoder. */
export function imageTransmission(png: Uint8Array, imageId: number, inTmux: boolean): string {
  const payload = Buffer.from(png).toString("base64");
  const commands: string[] = [];
  for (let offset = 0; offset < payload.length; offset += 4096) {
    const chunk = payload.slice(offset, offset + 4096);
    const metadata = offset === 0
      ? `a=T,f=100,t=d,U=1,C=1,i=${imageId},c=${MASCOT_COLUMNS},r=${MASCOT_ROWS},q=2,`
      : "q=2,";
    commands.push(graphicsEscape(`${metadata}m=${offset + chunk.length < payload.length ? 1 : 0};${chunk}`, inTmux));
  }
  return commands.join("");
}

/** A retained text rectangle that Ghostty/Kitty replaces with the full-resolution image. */
export function imagePlacement(imageId: number, cursorVisible = true): TerminalMascotPlacement {
  const color = `\u001b[38;2;${imageId >>> 16};${(imageId >>> 8) & 255};${imageId & 255}m`;
  return {
    columns: MASCOT_COLUMNS,
    rows: Array.from({ length: MASCOT_ROWS }, (_, row) => {
      const cells = Array.from({ length: MASCOT_COLUMNS }, (_, column) => {
        // Include the transparent gap to cover the cursor glow when the square art is fit to cells.
        if (!cursorVisible && row === MASCOT_ROWS - 1 && column >= 5) return " ";
        return `${PLACEHOLDER}${String.fromCodePoint(COORDINATES[row]!)}${String.fromCodePoint(COORDINATES[column]!)}`;
      });
      return `${color}${cells.join("")}\u001b[0m`;
    }),
  };
}

function tmux(args: string[]): string | undefined {
  const result = spawnSync("tmux", args, { encoding: "utf8", timeout: 1000, maxBuffer: 4096 });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

/**
 * Use native graphics only on known compatible terminals. In tmux, capability replies can reach
 * a different focused pane, so identify the attached terminal without probing its input stream.
 * Passthrough is enabled only for a graphics transfer and restored before provider output.
 */
export function createTerminalMascot(
  output: ImageOutput,
  environment: NodeJS.ProcessEnv = process.env,
): TerminalMascot | undefined {
  if (output.isTTY !== true) return undefined;
  const inTmux = environment.TMUX !== undefined;
  const pane = environment.TMUX_PANE;
  if (inTmux && pane === undefined) return undefined;
  const terminal = inTmux
    ? tmux(["display-message", "-p", "-t", pane!, "#{client_termname}"])
    : environment.TERM_PROGRAM === "ghostty" ? "xterm-ghostty" : environment.TERM;
  if (terminal !== "xterm-ghostty" && terminal !== "xterm-kitty") return undefined;

  let png: Buffer;
  try {
    png = readFileSync(new URL("./assets/cyberpunk-prompt.png", import.meta.url));
  } catch {
    return undefined;
  }
  const writeGraphics = (sequence: string) => {
    let restorePassthrough: (() => void) | undefined;
    if (inTmux) {
      const original = tmux(["show-options", "-p", "-t", pane!, "allow-passthrough"]);
      const effective = tmux(["show-options", "-pAv", "-t", pane!, "allow-passthrough"]);
      if (original === undefined || effective === undefined) return;
      if (effective !== "on" && effective !== "all") {
        if (tmux(["set-option", "-p", "-t", pane!, "allow-passthrough", "on"]) === undefined) return;
        restorePassthrough = () => {
          if (tmux(["show-options", "-pv", "-t", pane!, "allow-passthrough"]) !== "on") return;
          const previous = /^allow-passthrough (off|on|all)$/u.exec(original)?.[1];
          tmux(previous === undefined
            ? ["set-option", "-pu", "-t", pane!, "allow-passthrough"]
            : ["set-option", "-p", "-t", pane!, "allow-passthrough", previous]);
        };
      }
    }
    try {
      output.write(sequence);
    } finally {
      restorePassthrough?.();
    }
  };
  const imageId = randomInt(1, 0x1000000);
  const visible = imagePlacement(imageId);
  const hidden = imagePlacement(imageId, false);
  let cursorVisible = true;
  // The same uploaded pixels serve both states, so the chevron never shifts during a blink.
  const transmission = imageTransmission(png, imageId, inTmux);
  return {
    get placement() { return cursorVisible ? visible : hidden; },
    setCursorVisible: (value) => { cursorVisible = value; },
    enter: () => { writeGraphics(transmission); },
    dispose: () => { writeGraphics(graphicsEscape(`a=d,d=I,i=${imageId},q=2`, inTmux)); },
  };
}
