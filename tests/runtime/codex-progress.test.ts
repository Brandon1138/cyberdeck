import { expect, it } from "vitest";
import { CodexScreenProgress } from "../../src/runtime/codex-progress.js";
import { WorkerTurnObservationAdapter } from "../../src/runtime/worker-turn-observation-adapter.js";

it("ignores the busy footer clock, spinner, hooks and composer while tracking tool/response changes", () => {
  const progress = new CodexScreenProgress();
  const frame = (body: string, seconds: number, tail = "") => `${body}\n• Working (${seconds}s • esc to interrupt)\n${tail}`;
  const first = progress.observe(frame("Ran tests", 1));
  expect(progress.observe(frame("Ran tests", 130, "Running hooks\n› pending draft"))).toBe(first);
  expect(progress.observe(frame("Ran tests\nEdited app.ts (+3 -0)", 131))).toBeGreaterThan(first);
  const latest = progress.observe(frame("Ran tests\nEdited app.ts (+3 -0)", 132));
  expect(progress.observe("unrecognized screen")).toBe(latest);
  progress.reset();
  expect(progress.observe("")).toBe(0);
});

it("uses rendered terminal rows rather than accumulating redraw bytes as progress", () => {
  const replay = new WorkerTurnObservationAdapter().createReplay(128 * 1024);
  const draw = (body: string, clock: string) => replay.appendBytes(Buffer.from(`\x1b[2J\x1b[H${body}\r\n• Working (${clock} • esc to interrupt)\r\n› Ask Codex to do anything`));
  draw("Ran tests", "1s");
  const first = replay.progressVersion!("codex");
  expect(first).toBeGreaterThan(0);
  draw("Ran tests", "2m 5s");
  expect(replay.progressVersion!("codex")).toBe(first);
  draw("Edited app.ts", "2m 6s");
  expect(replay.progressVersion!("codex")).toBeGreaterThan(first);
});
