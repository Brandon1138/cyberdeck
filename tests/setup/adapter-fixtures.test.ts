import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonlDecoder } from "../../src/protocol/jsonl.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const recordingAgent = join(fixturesDir, "recording-agent.mjs");
const framesDir = join(fixturesDir, "stream-frames");

interface Recording {
  mode: string;
  argv: string[];
  cwd: string;
  env: Record<string, string | null>;
  stdin: string;
}

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  recording: Recording;
}

function runFixture(options: {
  args?: readonly string[];
  env?: Record<string, string>;
  cwd: string;
  recordPath: string;
  stdin?: string;
}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [recordingAgent, ...(options.args ?? [])], {
      cwd: options.cwd,
      env: {
        ...process.env,
        CYBERDECK_FIXTURE_RECORD: options.recordPath,
        ...options.env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);

    if (options.stdin !== undefined) {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();

    child.on("close", (exitCode) => {
      resolve({
        stdout,
        stderr,
        exitCode,
        recording: JSON.parse(readFileSync(options.recordPath, "utf8")) as Recording,
      });
    });
  });
}

describe("recording-agent fixture", () => {
  let workDir: string;
  let recordPath: string;

  beforeEach(() => {
    // realpath because macOS resolves /var to /private/var, which the child
    // reports back as its cwd.
    workDir = realpathSync(mkdtempSync(join(tmpdir(), "cyberdeck-fixture-")));
    recordPath = join(workDir, "recording.json");
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("records argv, cwd, allowlisted env, and stdin in headless mode", async () => {
    const result = await runFixture({
      cwd: workDir,
      recordPath,
      args: ["--session-id", "abc", "--permission-mode", "plan"],
      env: {
        CYBERDECK_FIXTURE_MODE: "headless",
        CYBERDECK_FIXTURE_ENV_KEYS: "DISABLE_UPDATES,CYBERDECK_ABSENT",
        DISABLE_UPDATES: "1",
      },
      stdin: "a prompt line\n",
    });

    expect(result.recording.mode).toBe("headless");
    expect(result.recording.argv).toEqual([
      "--session-id",
      "abc",
      "--permission-mode",
      "plan",
    ]);
    expect(result.recording.cwd).toBe(workDir);
    expect(result.recording.env).toEqual({ DISABLE_UPDATES: "1", CYBERDECK_ABSENT: null });
    expect(result.recording.stdin).toBe("a prompt line\n");
  });

  it("emits configured stdout, stderr, and exit code in headless mode", async () => {
    const result = await runFixture({
      cwd: workDir,
      recordPath,
      env: {
        CYBERDECK_FIXTURE_MODE: "headless",
        CYBERDECK_FIXTURE_STDOUT: "out-payload",
        CYBERDECK_FIXTURE_STDERR: "err-payload",
        CYBERDECK_FIXTURE_EXIT_CODE: "3",
      },
    });

    expect(result.stdout).toBe("out-payload");
    expect(result.stderr).toBe("err-payload");
    expect(result.exitCode).toBe(3);
  });

  it("streams a frame file verbatim so parser tests stay deterministic", async () => {
    const result = await runFixture({
      cwd: workDir,
      recordPath,
      env: {
        CYBERDECK_FIXTURE_MODE: "headless",
        CYBERDECK_FIXTURE_STDOUT_FILE: join(framesDir, "well-formed.jsonl"),
      },
    });

    expect(result.stdout).toBe(readFileSync(join(framesDir, "well-formed.jsonl"), "utf8"));
    expect(result.exitCode).toBe(0);
  });

  it("announces readiness and echoes lines in interactive mode", async () => {
    const result = await runFixture({
      cwd: workDir,
      recordPath,
      env: { CYBERDECK_FIXTURE_MODE: "interactive" },
      stdin: "first\n/exit\n",
    });

    expect(result.stdout).toContain("READY");
    expect(result.stdout).toContain("ECHO:first");
    expect(result.recording.mode).toBe("interactive");
    expect(result.recording.stdin).toBe("first\n/exit\n");
    expect(result.exitCode).toBe(0);
  });
});

const frameSchema = z.object({
  kind: z.literal("fixture-frame"),
  seq: z.number(),
  text: z.string(),
});

describe("stream-frame fixtures", () => {
  it("decodes every line of the well-formed fixture", () => {
    const decoder = new JsonlDecoder(frameSchema);
    const decoded = decoder.push(readFileSync(join(framesDir, "well-formed.jsonl")));

    expect(decoded).toHaveLength(3);
    expect(decoded.every((frame) => "kind" in frame && frame.kind === "fixture-frame")).toBe(true);
  });

  it("surfaces a protocol error for the malformed fixture without losing valid frames", () => {
    const decoder = new JsonlDecoder(frameSchema);
    const decoded = decoder.push(readFileSync(join(framesDir, "malformed.jsonl")));

    expect(decoded).toHaveLength(3);
    expect(decoded[1]).toMatchObject({ type: "protocol-error", code: "INVALID_FRAME" });
  });

  it("withholds a truncated trailing frame until its newline arrives", () => {
    const decoder = new JsonlDecoder(frameSchema);
    const decoded = decoder.push(readFileSync(join(framesDir, "truncated.jsonl")));

    expect(decoded).toHaveLength(1);
    expect(decoder.push(Buffer.from('"}\n', "utf8"))).toHaveLength(1);
  });
});
