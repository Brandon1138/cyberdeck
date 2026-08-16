/**
 * Per-chunk ingest cost, before and after MIK-87.
 *
 * The broker reads the same handful of things on every PTY chunk: what the worker is doing, whether
 * its provider has died, what its composer holds, how many tokens it has burned. `whole-replay` is
 * how it used to answer — re-strip the session's entire replay buffer, re-split it, re-scan it, and
 * compare it against a retained copy — and `digest` is how it answers now, by folding the chunk it
 * was handed into running state.
 *
 * Both compute the same readings, so what is measured is *when* the work happens, not what is
 * concluded. Run: `pnpm bench:ingest`.
 */
import { frameComposerState, terminalComposerState } from "../src/runtime/composer-state.js";
import { ReplayDigest } from "../src/runtime/replay-digest.js";
import {
  TAIL_BYTES,
  detectProviderLimitTermination,
  detectProviderLimitTerminationInTail,
  detectSessionFatalError,
  detectSessionFatalErrorInTail,
} from "../src/runtime/session-liveness.js";
import {
  markerTerminalActivity,
  providerTerminalActivity,
  terminalTokenCount,
} from "../src/runtime/terminal-replay.js";

/** The broker's default `replayBytes`. Scouts run at 1 MiB. */
const DEFAULT_REPLAY_BYTES = 128 * 1024;

/** A chunk shaped like a streaming provider frame: a redrawn status line and a line of output. */
function chunkAt(index: number): string {
  const body = `assistant output line ${index} ${"lorem ipsum dolor sit amet ".repeat(4)}`;
  return `\u001b[2K\r⠋ Working (esc to interrupt) · ${index * 7} tokens · esc to interrupt\n${body}\n`;
}

/** Every reading the old broadcast path made, against the session's whole replay buffer. */
function readWholeReplay(replay: string, retained: string | undefined): string {
  providerTerminalActivity("claude", replay);
  detectSessionFatalError(replay);
  detectProviderLimitTermination(replay);
  terminalComposerState("claude", replay, { modalOpen: false });
  terminalTokenCount(replay);
  // The stall observation kept a copy of the replay and compared against it character by character.
  // Kept here because it was part of the per-chunk cost, and part of every session's footprint.
  return retained === replay ? retained : replay;
}

/** The same readings, from the digest. */
function readDigest(digest: ReplayDigest, retained: number): number {
  markerTerminalActivity("claude", digest);
  const tail = digest.strippedTail(TAIL_BYTES);
  detectSessionFatalErrorInTail(tail);
  detectProviderLimitTerminationInTail(tail);
  frameComposerState("claude", digest.frameText(), { modalOpen: false });
  digest.tokenCount();
  return digest.version === retained ? retained : digest.version;
}

interface Sample {
  /** Total output the session has produced by the end of this sample, in KiB. */
  streamed: number;
  wholeReplayUs: number;
  digestUs: number;
}

function run(chunks: number, sampleEvery: number, replayBytes: number): Sample[] {
  const samples: Sample[] = [];
  let replay = "";
  let retainedReplay: string | undefined;
  const digest = new ReplayDigest();
  let retainedVersion = 0;
  let streamed = 0;

  let wholeReplayNs = 0;
  let digestNs = 0;
  let measured = 0;

  for (let index = 0; index < chunks; index += 1) {
    const chunk = chunkAt(index);
    streamed += chunk.length;
    // The PTY's replay buffer is a bounded tail. This is the structure the old reading re-scanned.
    replay = (replay + chunk).slice(-replayBytes);

    const beforeWhole = process.hrtime.bigint();
    retainedReplay = readWholeReplay(replay, retainedReplay);
    wholeReplayNs += Number(process.hrtime.bigint() - beforeWhole);

    const beforeDigest = process.hrtime.bigint();
    digest.append(chunk);
    retainedVersion = readDigest(digest, retainedVersion);
    digestNs += Number(process.hrtime.bigint() - beforeDigest);

    measured += 1;
    if ((index + 1) % sampleEvery !== 0) continue;
    samples.push({
      streamed: Math.round(streamed / 1024),
      wholeReplayUs: wholeReplayNs / measured / 1_000,
      digestUs: digestNs / measured / 1_000,
    });
    wholeReplayNs = 0;
    digestNs = 0;
    measured = 0;
  }
  return samples;
}

const microseconds = (value: number): string => `${value.toFixed(1).padStart(8)} µs`;

// Warm the JIT so the first sample is not measuring compilation.
run(600, 600, DEFAULT_REPLAY_BYTES);

console.log("Per-chunk cost as one session's output accumulates (replay buffer 128 KiB)\n");
console.log("  streamed   whole-replay/chunk   digest/chunk   ratio");
for (const sample of run(8_000, 1_000, DEFAULT_REPLAY_BYTES)) {
  console.log(
    `  ${String(sample.streamed).padStart(6)} KiB`
    + `   ${microseconds(sample.wholeReplayUs)}`
    + `      ${microseconds(sample.digestUs)}`
    + `   ${(sample.wholeReplayUs / sample.digestUs).toFixed(1)}x`,
  );
}

console.log("\nPer-chunk cost against the size of the buffer being re-read\n");
console.log("  replay buffer   whole-replay/chunk   digest/chunk   ratio");
for (const replayBytes of [16, 64, 128, 512, 1_024].map((kib) => kib * 1024)) {
  const sample = run(3_000, 3_000, replayBytes).at(-1)!;
  console.log(
    `  ${String(Math.round(replayBytes / 1024)).padStart(9)} KiB`
    + `      ${microseconds(sample.wholeReplayUs)}`
    + `      ${microseconds(sample.digestUs)}`
    + `   ${(sample.wholeReplayUs / sample.digestUs).toFixed(1)}x`,
  );
}
