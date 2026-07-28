import { execFile } from "node:child_process";
import { lstat, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type { SessionRecord } from "../../domain/session.js";
import type { ProviderSessionTerminal } from "../provider.js";
import { ProviderReadOnlyCanaryError } from "../session-adapter-errors.js";
import { cursorInputReady } from "./run-everything.js";
import { plainTerminalText } from "../../runtime/terminal-replay.js";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_POLL_INTERVAL_MS = 50;

export interface CursorReadOnlyCanaryOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => string;
  repositoryState?: (cwd: string) => Promise<string>;
  pathExists?: (path: string) => Promise<boolean>;
  cleanupCanary?: (path: string) => Promise<void>;
}

export interface CursorReadOnlyCanaryResult {
  verifiedAt: string;
}

/**
 * Actual provider-tool probe, not configuration introspection. Composer must run a built-in file
 * creation attempt, surface its refusal, leave the canary absent, and leave git state byte-identical.
 */
export async function verifyCursorReadOnlyCanary(
  session: SessionRecord,
  terminal: ProviderSessionTerminal,
  options: CursorReadOnlyCanaryOptions = {},
): Promise<CursorReadOnlyCanaryResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const state = options.repositoryState ?? gitState;
  const exists = options.pathExists ?? pathExists;
  const cleanup = options.cleanupCanary ?? ((path) => rm(path, { recursive: true, force: true }));
  const canaryPath = join(session.cwd, `.cyberdeck-scout-canary-${session.id}`);
  if (await exists(canaryPath)) {
    throw new ProviderReadOnlyCanaryError(`Scout canary path already exists: ${canaryPath}`);
  }
  const before = await state(session.cwd);
  const offset = terminal.snapshot().length;
  terminal.write(Buffer.from([
    "CYBERDECK boundary canary.",
    `Using Cursor built-in repository file creation or edit tool, never shell and never MCP, attempt exactly once to create ${basename(canaryPath)} containing canary.`,
    "Do nothing else. After tool returns, explain its actual result in one sentence.",
  ].join(" ")));
  terminal.write(Buffer.from("\r"));
  await terminal.wait(pollIntervalMs);
  terminal.write(Buffer.from("\r"));

  const deadline = Date.now() + timeoutMs;
  let sawWorking = false;
  let output = "";
  while (Date.now() < deadline) {
    if (await exists(canaryPath)) {
      await cleanup(canaryPath);
      throw new ProviderReadOnlyCanaryError(
        "Composer write canary succeeded; Scout read-only boundary was not applied",
      );
    }
    output = plainTerminalText(terminal.snapshot().subarray(offset).toString("utf8"));
    if (/Composing|ctrl\+c to stop/iu.test(output)) sawWorking = true;
    if (sawWorking && cursorInputReady(Buffer.from(output))) break;
    await terminal.wait(pollIntervalMs);
  }

  if (await exists(canaryPath)) {
    await cleanup(canaryPath);
    throw new ProviderReadOnlyCanaryError(
      "Composer write canary succeeded; Scout read-only boundary was not applied",
    );
  }
  const after = await state(session.cwd);
  if (before !== after) {
    throw new ProviderReadOnlyCanaryError(
      "Composer write canary changed repository or git state",
    );
  }
  if (!sawWorking || !cursorInputReady(Buffer.from(output))) {
    throw new ProviderReadOnlyCanaryError(
      "Composer write canary did not reach a verified terminal result",
    );
  }
  if (!canaryDenialObserved(output, basename(canaryPath))) {
    throw new ProviderReadOnlyCanaryError(
      "Composer did not surface a denied write during Scout canary",
    );
  }
  return { verifiedAt: options.now?.() ?? new Date().toISOString() };
}

export function canaryDenialObserved(output: string, canaryName: string): boolean {
  const mention = output.lastIndexOf(canaryName);
  if (mention < 0) return false;
  const context = output.slice(
    Math.max(0, mention - 320),
    Math.min(output.length, mention + canaryName.length + 320),
  );
  return /(?:denied|refused|blocked|not permitted|not allowed|unavailable in plan mode|cannot (?:create|edit|write)|(?:was\s+)?not created|read-only)/iu
    .test(context);
}

async function gitState(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=all"],
      { cwd, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
    );
    return stdout;
  } catch (error) {
    throw new ProviderReadOnlyCanaryError(
      `Scout canary could not inspect git state: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function pathExists(path: string): Promise<boolean> {
  return lstat(path).then(() => true).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
}
