import { constants } from "node:fs";
import { open, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  MAX_SCOUT_REPORT_BYTES,
  ScoutReportSchema,
  type ScoutReport,
  type ScoutRuntimeState,
} from "../domain/worker-profile.js";
import { plainTerminalText } from "../runtime/terminal-replay.js";
import {
  SCOUT_REPORT_BEGIN,
  SCOUT_REPORT_END,
} from "../orchestration/worker-profiles.js";
import { ensurePrivateDirectory } from "./private-files.js";

const PARTIAL_REPORT_PREFIX = "CYBERDECK_SCOUT_PARTIAL\n";
const INVALID_REPORT_PREFIX = "CYBERDECK_SCOUT_INVALID\n";

export type ScoutReportCapture =
  | { state: "missing" }
  | { state: "partial"; text: string }
  | { state: "invalid"; text: string; reason: string }
  | { state: "complete"; text: string; report: ScoutReport };

/**
 * Broker-owned Scout drop box. Composer never receives a repository write exception: it emits one
 * framed report, and Cyberdeck writes that content outside the worktree. This keeps report delivery
 * independent of terminal completion detection while leaving exactly one writable session root.
 */
export class ScoutReportStore {
  private readonly writeTails = new Map<string, Promise<void>>();

  constructor(private readonly stateDirectory: string) {}

  async initialize(sessionId: string, cwd: string): Promise<ScoutRuntimeState> {
    const dropBoxPath = join(this.stateDirectory, "scouts", sessionId);
    const reportPath = join(dropBoxPath, "report.json");
    await ensurePrivateDirectory(dropBoxPath);
    await Promise.all([
      ensurePrivateDirectory(join(dropBoxPath, "cursor-config")),
      ensurePrivateDirectory(join(dropBoxPath, "cursor-data")),
      ensurePrivateDirectory(join(dropBoxPath, "node-cache")),
      ensurePrivateDirectory(join(dropBoxPath, "tmp")),
    ]);
    const [canonicalCwd, canonicalDropBox] = await Promise.all([
      realpath(cwd),
      realpath(dropBoxPath),
    ]);
    if (
      pathContains(canonicalCwd, canonicalDropBox)
      || pathContains(canonicalDropBox, canonicalCwd)
    ) {
      throw new Error("Scout drop box and worker worktree must not overlap");
    }
    return {
      dropBoxPath: canonicalDropBox,
      reportPath: join(canonicalDropBox, "report.json"),
      canary: { status: "pending" },
      reportState: "missing",
    };
  }

  async capture(runtime: ScoutRuntimeState, replay: string): Promise<ScoutReportCapture> {
    await this.assertRuntimePaths(runtime);
    const captured = captureScoutReport(replay);
    if (captured.state === "missing") return captured;
    const durable = captured.state === "partial"
      ? `${PARTIAL_REPORT_PREFIX}${captured.text}`
      : captured.state === "invalid"
        ? `${INVALID_REPORT_PREFIX}${captured.text}`
        : captured.text;
    await this.write(runtime.reportPath, durable);
    return captured;
  }

  async collect(runtime: ScoutRuntimeState): Promise<ScoutReportCapture> {
    await this.assertRuntimePaths(runtime);
    const stored = await readNoFollow(runtime.reportPath);
    if (stored === undefined) return { state: "missing" };
    if (stored.startsWith(PARTIAL_REPORT_PREFIX)) {
      return { state: "partial", text: stored.slice(PARTIAL_REPORT_PREFIX.length) };
    }
    if (stored.startsWith(INVALID_REPORT_PREFIX)) {
      return {
        state: "invalid",
        text: stored.slice(INVALID_REPORT_PREFIX.length),
        reason: "Stored report is not valid Scout JSON",
      };
    }
    const parsed = parseCompleteReport(stored);
    return parsed === undefined
      ? { state: runtime.reportState === "invalid" ? "invalid" : "partial", text: stored,
          ...(runtime.reportState === "invalid" ? { reason: "Stored report is not valid Scout JSON" } : {}) } as ScoutReportCapture
      : parsed;
  }

  async remove(sessionId: string): Promise<void> {
    const scoutsRoot = resolve(this.stateDirectory, "scouts");
    const dropBoxPath = resolve(scoutsRoot, sessionId);
    if (dropBoxPath === scoutsRoot || !pathContains(scoutsRoot, dropBoxPath)) {
      throw new Error("Scout drop box must stay inside broker Scout state");
    }
    await this.writeTails.get(join(dropBoxPath, "report.json"))?.catch(() => undefined);
    await rm(dropBoxPath, { recursive: true, force: true });
  }

  private async assertRuntimePaths(runtime: ScoutRuntimeState): Promise<void> {
    if (!isAbsolute(runtime.dropBoxPath) || !isAbsolute(runtime.reportPath)) {
      throw new Error("Scout drop-box paths must be absolute");
    }
    if (!pathContains(runtime.dropBoxPath, runtime.reportPath)) {
      throw new Error("Scout report must stay inside its drop box");
    }
    const [scoutsRoot, dropBoxPath] = await Promise.all([
      realpath(resolve(this.stateDirectory, "scouts")),
      realpath(runtime.dropBoxPath),
    ]);
    if (
      dropBoxPath === scoutsRoot
      || !pathContains(scoutsRoot, dropBoxPath)
    ) {
      throw new Error("Scout drop box must stay inside broker Scout state");
    }
    if (resolve(runtime.reportPath) !== resolve(join(runtime.dropBoxPath, "report.json"))) {
      throw new Error("Scout has exactly one canonical report path");
    }
  }

  private async write(path: string, content: string): Promise<void> {
    const bounded = Buffer.byteLength(content) <= MAX_SCOUT_REPORT_BYTES
      ? content
      : Buffer.from(content).subarray(0, MAX_SCOUT_REPORT_BYTES).toString("utf8");
    const previous = this.writeTails.get(path) ?? Promise.resolve();
    const next = previous.then(async () => {
      await ensurePrivateDirectory(dirname(path));
      const handle = await open(
        path,
        constants.O_WRONLY
          | constants.O_CREAT
          | constants.O_TRUNC
          | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.chmod(0o600);
        await handle.writeFile(bounded, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
    this.writeTails.set(path, next);
    try {
      await next;
    } finally {
      if (this.writeTails.get(path) === next) this.writeTails.delete(path);
    }
  }
}

async function readNoFollow(path: string): Promise<string | undefined> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    },
  );
  if (handle === undefined) return undefined;
  try {
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

export function captureScoutReport(replay: string): ScoutReportCapture {
  const plain = plainTerminalText(replay);
  const begin = plain.lastIndexOf(SCOUT_REPORT_BEGIN);
  if (begin < 0) return { state: "missing" };
  const contentStart = begin + SCOUT_REPORT_BEGIN.length;
  const end = plain.indexOf(SCOUT_REPORT_END, contentStart);
  const text = plain.slice(contentStart, end < 0 ? undefined : end).trim();
  // Prompt rendering contains marker names plus a non-JSON contract placeholder. Ignore that echo;
  // only a provider report or partial report begins with a JSON object, optionally fenced.
  const jsonStart = text.replace(/^```(?:json)?\s*/iu, "").trimStart();
  if (!jsonStart.startsWith("{")) return { state: "missing" };
  if (end < 0) return { state: "partial", text };
  const parsed = parseCompleteReport(text);
  if (parsed !== undefined) return parsed;
  return {
    state: "invalid",
    text,
    reason: "Framed Scout report is not valid JSON matching the result contract",
  };
}

function parseCompleteReport(text: string): Extract<ScoutReportCapture, { state: "complete" }> | undefined {
  const normalized = text
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "")
    .trim();
  try {
    const report = ScoutReportSchema.parse(JSON.parse(normalized));
    const canonical = `${JSON.stringify(report, null, 2)}\n`;
    return { state: "complete", text: canonical, report };
  } catch {
    return undefined;
  }
}

function pathContains(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}
