/**
 * Deterministic adapter fixture.
 *
 * Stands in for a provider CLI in automated tests. It makes no network call and
 * needs no authentication: it records how it was invoked and replays canned
 * output. Nothing it prints is provider-shaped evidence — it proves Cyberdeck
 * mechanics only.
 *
 * Configuration (all via environment, so argv stays exactly what the adapter
 * under test produced):
 *   CYBERDECK_FIXTURE_RECORD       required; path to write the JSON recording
 *   CYBERDECK_FIXTURE_MODE         "interactive" (default) | "headless"
 *   CYBERDECK_FIXTURE_ENV_KEYS     comma-separated env names to record;
 *                                  absent names are recorded as null
 *   CYBERDECK_FIXTURE_STDOUT       literal text written to stdout (headless)
 *   CYBERDECK_FIXTURE_STDOUT_FILE  file streamed verbatim to stdout (headless);
 *                                  takes precedence over CYBERDECK_FIXTURE_STDOUT
 *   CYBERDECK_FIXTURE_STDERR       literal text written to stderr (headless)
 *   CYBERDECK_FIXTURE_EXIT_CODE    integer exit code, default 0
 *
 * Recording shape: { mode, argv, cwd, env, stdin }
 */
import { readFileSync, writeFileSync } from "node:fs";

const recordPath = process.env.CYBERDECK_FIXTURE_RECORD;
const mode = process.env.CYBERDECK_FIXTURE_MODE === "headless" ? "headless" : "interactive";
const argv = process.argv.slice(2);

const envKeys = (process.env.CYBERDECK_FIXTURE_ENV_KEYS ?? "")
  .split(",")
  .map((key) => key.trim())
  .filter((key) => key !== "");

let stdinText = "";

function record() {
  if (recordPath === undefined) return;
  const env = {};
  for (const key of envKeys) {
    env[key] = process.env[key] ?? null;
  }
  writeFileSync(
    recordPath,
    `${JSON.stringify({ mode, argv, cwd: process.cwd(), env, stdin: stdinText }, null, 2)}\n`,
  );
}

function exitCode() {
  const raw = process.env.CYBERDECK_FIXTURE_EXIT_CODE;
  if (raw === undefined) return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

process.stdin.setEncoding("utf8");

if (mode === "headless") {
  process.stdin.on("data", (chunk) => {
    stdinText += chunk;
  });
  process.stdin.on("end", () => {
    const stdoutFile = process.env.CYBERDECK_FIXTURE_STDOUT_FILE;
    if (stdoutFile !== undefined) {
      process.stdout.write(readFileSync(stdoutFile, "utf8"));
    } else if (process.env.CYBERDECK_FIXTURE_STDOUT !== undefined) {
      process.stdout.write(process.env.CYBERDECK_FIXTURE_STDOUT);
    }
    if (process.env.CYBERDECK_FIXTURE_STDERR !== undefined) {
      process.stderr.write(process.env.CYBERDECK_FIXTURE_STDERR);
    }
    record();
    process.exit(exitCode());
  });
} else {
  process.stdout.write("READY\r\n");

  let pending = "";
  process.stdin.on("data", (chunk) => {
    stdinText += chunk;
    pending += chunk;
    for (;;) {
      const newlineIndex = pending.indexOf("\n");
      if (newlineIndex === -1) break;
      const line = pending.slice(0, newlineIndex).replace(/\r$/, "");
      pending = pending.slice(newlineIndex + 1);
      process.stdout.write(`ECHO:${line}\r\n`);

      if (line === "/exit") {
        record();
        process.exit(exitCode());
      }
    }
  });
  process.stdin.on("end", () => {
    record();
    process.exit(exitCode());
  });
}
