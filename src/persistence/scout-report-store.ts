import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  MAX_SCOUT_EVIDENCE_BYTES,
  MAX_SCOUT_REPORT_BYTES,
  MAX_SCOUT_TRACE_BYTES,
  ScoutReportSchema,
  type ScoutReport,
  type ScoutArtifactKind,
  type ScoutRuntimeState,
} from "../domain/worker-profile.js";
import {
  parseScoutDecisionCard,
  parseStoredScoutDecisionCard,
  scoutFramedTextFromCursorStream,
  type ScoutDecisionCard,
} from "../domain/scout-output.js";
import { plainTerminalText } from "../runtime/terminal-replay.js";
import {
  SCOUT_REPORT_BEGIN,
  SCOUT_REPORT_END,
} from "../orchestration/worker-profiles.js";
import { ensurePrivateDirectory } from "./private-files.js";

const PARTIAL_REPORT_PREFIX = "CYBERDECK_SCOUT_PARTIAL\n";
const INVALID_REPORT_PREFIX = "CYBERDECK_SCOUT_INVALID\n";
const TRACE_TRUNCATED_MARKER = Buffer.from(
  `${JSON.stringify({
    type: "cyberdeck_trace_truncated",
    maximumBytes: MAX_SCOUT_TRACE_BYTES,
  })}\n`,
);

export type ScoutReportCapture =
  | { state: "missing" }
  | { state: "partial"; text: string }
  | { state: "invalid"; text: string; reason: string }
  | {
      state: "complete";
      text: string;
      card: ScoutDecisionCard;
      evidenceText?: string;
    }
  | { state: "complete"; text: string; report: ScoutReport };

export interface ScoutArtifactRead {
  artifact: ScoutArtifactKind;
  text: string;
  afterByte: number;
  nextByte: number;
  totalBytes: number;
  complete: boolean;
}

/**
 * Broker-owned Scout drop box. Composer never receives a repository write exception: it emits one
 * framed report, and Cyberdeck writes that content outside the worktree. This keeps report delivery
 * independent of terminal completion detection while leaving exactly one writable session root.
 */
export class ScoutReportStore {
  private readonly writeTails = new Map<string, Promise<void>>();
  private readonly captureTails = new Map<string, Promise<ScoutReportCapture>>();

  constructor(private readonly stateDirectory: string) {}

  async initialize(sessionId: string, cwd: string): Promise<ScoutRuntimeState> {
    const dropBoxPath = join(this.stateDirectory, "scouts", sessionId);
    const reportPath = join(dropBoxPath, "card.md");
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
      reportPath: join(canonicalDropBox, "card.md"),
      evidencePath: join(canonicalDropBox, "evidence.md"),
      tracePath: join(canonicalDropBox, "trace.jsonl"),
      transport: "headless-stream-json",
      canary: { status: "pending" },
      reportState: "missing",
    };
  }

  async capture(runtime: ScoutRuntimeState, replay: string): Promise<ScoutReportCapture> {
    await this.assertRuntimePaths(runtime);
    const previous = this.captureTails.get(runtime.reportPath)
      ?? Promise.resolve({ state: "missing" as const });
    const next = previous.catch(() => ({ state: "missing" as const }))
      .then(() => this.captureOnce(runtime, replay));
    this.captureTails.set(runtime.reportPath, next);
    try {
      return await next;
    } finally {
      if (this.captureTails.get(runtime.reportPath) === next) {
        this.captureTails.delete(runtime.reportPath);
      }
    }
  }

  private async captureOnce(
    runtime: ScoutRuntimeState,
    replay: string,
  ): Promise<ScoutReportCapture> {
    const captured = captureScoutReport(replay);
    if (captured.state === "missing") return captured;
    const existing = await this.collect(runtime);
    if (existing.state === "complete" && captured.state !== "complete") {
      return existing;
    }
    const durable = captured.state === "partial"
      ? `${PARTIAL_REPORT_PREFIX}${captured.text}`
      : captured.state === "invalid"
        ? `${INVALID_REPORT_PREFIX}${captured.text}`
        : captured.text;
    await this.write(runtime.reportPath, durable, MAX_SCOUT_REPORT_BYTES);
    if (
      captured.state === "complete"
      && "card" in captured
      && captured.evidenceText !== undefined
      && runtime.evidencePath !== undefined
    ) {
      await this.write(
        runtime.evidencePath,
        `${captured.evidenceText.trim()}\n`,
        MAX_SCOUT_EVIDENCE_BYTES,
      );
    }
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
        reason: "Stored Scout result does not match the decision-card contract",
      };
    }
    const card = parseStoredScoutDecisionCard(stored);
    if (card !== undefined) {
      return { state: "complete", text: stored, card };
    }
    const parsed = parseCompleteReport(stored);
    return parsed === undefined
      ? { state: runtime.reportState === "invalid" ? "invalid" : "partial", text: stored,
          ...(runtime.reportState === "invalid"
            ? { reason: "Stored Scout result does not match a supported result contract" }
            : {}) } as ScoutReportCapture
      : parsed;
  }

  async appendTrace(runtime: ScoutRuntimeState, chunk: Buffer): Promise<void> {
    await this.assertRuntimePaths(runtime);
    if (runtime.tracePath === undefined || chunk.length === 0) return;
    const path = runtime.tracePath;
    const previous = this.writeTails.get(path) ?? Promise.resolve();
    const next = previous.then(async () => {
      await ensurePrivateDirectory(dirname(path));
      const current = await stat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      const size = current?.size ?? 0;
      if (size >= MAX_SCOUT_TRACE_BYTES) return;
      const payloadLimit = MAX_SCOUT_TRACE_BYTES - TRACE_TRUNCATED_MARKER.length;
      const availablePayload = Math.max(0, payloadLimit - size);
      const body = size >= payloadLimit
        ? TRACE_TRUNCATED_MARKER.subarray(0, MAX_SCOUT_TRACE_BYTES - size)
        : chunk.length <= availablePayload
          ? chunk
          : Buffer.concat([
              chunk.subarray(0, availablePayload),
              TRACE_TRUNCATED_MARKER,
            ]);
      const handle = await open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.chmod(0o600);
        await handle.write(body);
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

  async readArtifact(
    runtime: ScoutRuntimeState,
    artifact: ScoutArtifactKind,
    afterByte = 0,
    maxBytes = 16 * 1024,
  ): Promise<ScoutArtifactRead> {
    await this.assertRuntimePaths(runtime);
    const path = artifact === "card"
      ? runtime.reportPath
      : artifact === "evidence"
        ? runtime.evidencePath
        : runtime.tracePath;
    if (path === undefined) {
      return {
        artifact,
        text: "",
        afterByte,
        nextByte: afterByte,
        totalBytes: 0,
        complete: true,
      };
    }
    await this.writeTails.get(path)?.catch(() => undefined);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (handle === undefined) {
      return {
        artifact,
        text: "",
        afterByte,
        nextByte: afterByte,
        totalBytes: 0,
        complete: true,
      };
    }
    try {
      const metadata = await handle.stat();
      const start = Math.max(0, Math.min(afterByte, metadata.size));
      const remaining = metadata.size - start;
      const length = Math.min(Math.max(4, maxBytes), 64 * 1024, remaining);
      if (length === 0) {
        return {
          artifact,
          text: "",
          afterByte: start,
          nextByte: start,
          totalBytes: metadata.size,
          complete: true,
        };
      }
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, start);
      const decoded = decodeUtf8Prefix(
        buffer.subarray(0, bytesRead),
        start + bytesRead >= metadata.size,
      );
      const nextByte = start + decoded.bytes;
      return {
        artifact,
        text: decoded.text,
        afterByte: start,
        nextByte,
        totalBytes: metadata.size,
        complete: nextByte >= metadata.size,
      };
    } finally {
      await handle.close();
    }
  }

  async remove(sessionId: string): Promise<void> {
    const scoutsRoot = resolve(this.stateDirectory, "scouts");
    const dropBoxPath = resolve(scoutsRoot, sessionId);
    if (dropBoxPath === scoutsRoot || !pathContains(scoutsRoot, dropBoxPath)) {
      throw new Error("Scout drop box must stay inside broker Scout state");
    }
    await Promise.all([
      this.captureTails.get(join(dropBoxPath, "card.md"))?.catch(() => undefined),
      this.captureTails.get(join(dropBoxPath, "report.json"))?.catch(() => undefined),
      this.writeTails.get(join(dropBoxPath, "card.md"))?.catch(() => undefined),
      this.writeTails.get(join(dropBoxPath, "report.json"))?.catch(() => undefined),
      this.writeTails.get(join(dropBoxPath, "evidence.md"))?.catch(() => undefined),
      this.writeTails.get(join(dropBoxPath, "trace.jsonl"))?.catch(() => undefined),
    ]);
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
    const reportPath = resolve(runtime.reportPath);
    if (
      reportPath !== resolve(join(runtime.dropBoxPath, "card.md"))
      && reportPath !== resolve(join(runtime.dropBoxPath, "report.json"))
    ) {
      throw new Error("Scout has exactly one canonical result path");
    }
    if (
      runtime.evidencePath !== undefined
      && resolve(runtime.evidencePath) !== resolve(join(runtime.dropBoxPath, "evidence.md"))
    ) {
      throw new Error("Scout evidence must stay at its canonical path");
    }
    if (
      runtime.tracePath !== undefined
      && resolve(runtime.tracePath) !== resolve(join(runtime.dropBoxPath, "trace.jsonl"))
    ) {
      throw new Error("Scout trace must stay at its canonical path");
    }
  }

  private async write(path: string, content: string, maximumBytes: number): Promise<void> {
    const bounded = Buffer.byteLength(content) <= maximumBytes
      ? content
      : Buffer.from(content).subarray(0, maximumBytes).toString("utf8");
    const previous = this.writeTails.get(path) ?? Promise.resolve();
    const next = previous.then(async () => {
      await ensurePrivateDirectory(dirname(path));
      const existing = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        },
      );
      await existing?.close();
      const temporaryPath = join(dirname(path), `.${randomUUID()}.tmp`);
      const handle = await open(
        temporaryPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        try {
          await handle.chmod(0o600);
          await handle.writeFile(bounded, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporaryPath, path);
      } catch (error) {
        await rm(temporaryPath, { force: true });
        throw error;
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

function decodeUtf8Prefix(
  value: Buffer,
  atEnd: boolean,
): { text: string; bytes: number } {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let trim = 0; trim <= Math.min(3, value.length); trim += 1) {
    const bytes = value.length - trim;
    if (bytes === 0 && !atEnd) continue;
    try {
      return { text: decoder.decode(value.subarray(0, bytes)), bytes };
    } catch {
      // A bounded read may end inside one UTF-8 scalar. Retry without up to three trailing bytes.
    }
  }
  if (atEnd) return { text: value.toString("utf8"), bytes: value.length };
  throw new Error("Scout artifact byte cursor does not point to a UTF-8 boundary");
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
  const framed = scoutFramedTextFromCursorStream(replay);
  const card = parseScoutDecisionCard(framed);
  if (card.state !== "missing") {
    if (
      card.state === "complete"
      && Buffer.byteLength(card.text) > MAX_SCOUT_REPORT_BYTES
    ) {
      return {
        state: "invalid",
        text: card.text,
        reason: `Scout decision card exceeds ${MAX_SCOUT_REPORT_BYTES} bytes`,
      };
    }
    return card;
  }
  if (containsJsonStreamFrame(replay)) return { state: "missing" };
  return captureLegacyScoutReport(replay);
}

function containsJsonStreamFrame(replay: string): boolean {
  return replay.replace(/\r\n?/gu, "\n").split("\n").some((line) => {
    if (line.trim() === "") return false;
    try {
      const parsed: unknown = JSON.parse(line);
      return typeof parsed === "object" && parsed !== null && "type" in parsed;
    } catch {
      return false;
    }
  });
}

function captureLegacyScoutReport(replay: string): ScoutReportCapture {
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
