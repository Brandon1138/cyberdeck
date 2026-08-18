/**
 * Prints the octopus the way a terminal shows it, which is the only way to judge it.
 *
 * ASCII art is the one thing a diff genuinely cannot review: the mark's four frames differ by a
 * handful of bytes on one row, and whether that reads as an arm swinging or as noise is a question
 * only a real terminal answers. Run this after touching `src/client/octopus.ts`.
 *
 *   pnpm exec tsx scripts/preview-octopus.ts             one of each, held still
 *   pnpm exec tsx scripts/preview-octopus.ts --animate   the paddle at its own cadence
 */

import {
  MARK_FRAME_INTERVAL_MS,
  OCTOPUS_MARK_FRAMES,
  OCTOPUS_SPLASH,
  asciiArtHeight,
  asciiArtWidth,
  octopusMarkFrame,
  renderAsciiArt,
} from "../src/client/octopus.js";

const color = process.stdout.isTTY === true && !process.argv.includes("--no-color");
const write = (text: string) => { process.stdout.write(text); };

function heading(text: string): void {
  write(`\n${color ? "\u001b[1m" : ""}${text}${color ? "\u001b[0m" : ""}\n\n`);
}

const [rest] = OCTOPUS_MARK_FRAMES;
heading(
  `Mark — ${OCTOPUS_MARK_FRAMES.length} frames, ${asciiArtWidth(rest!)}x${asciiArtHeight(rest!)}`,
);

// Side by side is how a jitter shows: the mantle must sit on the same columns in every frame.
const frames = OCTOPUS_MARK_FRAMES.map((frame) => renderAsciiArt(frame, color));
for (let row = 0; row < frames[0]!.length; row += 1) {
  write(`  ${frames.map((frame) => frame[row]).join("    ")}\n`);
}

heading("Mark in the header, as Fleet lays it out");
const text = [
  "Cyberdeck",
  "Codex Sol · high · ~/code/personal/cyberdeck",
  "18 agents · 1 needs input · 2 working · 14 done",
];
for (const [index, line] of renderAsciiArt(rest!, color).entries()) {
  write(`  ${line}  ${text[index] ?? ""}\n`);
}

heading(`Splash — ${asciiArtWidth(OCTOPUS_SPLASH)}x${asciiArtHeight(OCTOPUS_SPLASH)}`);
for (const line of renderAsciiArt(OCTOPUS_SPLASH, color)) write(`  ${line}\n`);

heading("Colourless, which is the whole point of the ramp");
for (const line of renderAsciiArt(OCTOPUS_SPLASH, false)) write(`  ${line}\n`);
write("\n");
for (const line of renderAsciiArt(rest!, false)) write(`  ${line}\n`);

if (process.argv.includes("--animate")) {
  heading("Working — the four-beat paddle at its own cadence, ctrl+c to stop");
  const height = asciiArtHeight(rest!);
  write("\u001b[?25l");
  const paint = () => {
    const art = renderAsciiArt(octopusMarkFrame({ now: Date.now(), animated: true }), color);
    write(`${art.map((line) => `  ${line}`).join("\n")}\u001b[${height - 1}A\r`);
  };
  paint();
  // Sampled faster than the interval so a frame boundary is never missed by a whole beat.
  setInterval(paint, MARK_FRAME_INTERVAL_MS / 5);
  process.on("SIGINT", () => {
    write(`\u001b[${height}B\u001b[?25h\n`);
    process.exit(0);
  });
}
