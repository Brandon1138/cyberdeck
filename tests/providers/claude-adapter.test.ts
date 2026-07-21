import { spawn as nodeSpawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONTROL_PLANE_SCHEMA_VERSION } from "../../src/domain/control-plane.js";
import type { DispatchRequest } from "../../src/domain/dispatch.js";
import { JobReportSchema, type JobReport } from "../../src/domain/job.js";
import { ClaudeProviderAdapter } from "../../src/providers/claude.js";
import {
  ClaudeJobDispatchAdapter,
  type ClaudeResultInterpreter,
  type ClaudeSpawn,
} from "../../src/providers/claude/dispatch-adapter.js";
import { buildClaudeHeadlessCommand } from "../../src/providers/claude/headless-command.js";
import { ClaudeStreamDecoder } from "../../src/providers/claude/stream-codec.js";
import type { SessionRecord } from "../../src/domain/session.js";

const RECORDING_AGENT = fileURLToPath(
  new URL("../fixtures/recording-agent.mjs", import.meta.url),
);

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cyberdeck-claude-"));
  tempDirs.push(dir);
  return dir;
}

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    provider: "claude",
    cwd: "/tmp/repo",
    detached: true,
    sandbox: "read-only",
    model: "opus",
    createdAt: now,
    updatedAt: now,
    executionState: "active",
    attachmentState: "detached",
    pid: 123,
    exitCode: null,
    childIds: [],
    ...overrides,
  };
}

function dispatchRequest(overrides: Record<string, unknown> = {}): DispatchRequest {
  return {
    schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
    jobId: crypto.randomUUID(),
    correlationId: crypto.randomUUID(),
    request: {
      schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
      provider: "claude",
      cwd: "/tmp/repo",
      sandbox: "read-only",
      instruction: "summarise the repository",
      model: "opus",
      ...overrides,
    },
  } as DispatchRequest;
}

/**
 * Routes the adapter's command at B1's deterministic fixture instead of the real `claude`
 * executable, while recording the argv/env/cwd the adapter actually produced. No test in this file
 * can resolve or spawn the installed Claude binary.
 */
function fixtureSpawn(options: {
  recordPath: string;
  stdout?: string;
  stdoutFile?: string;
  stderr?: string;
  exitCode?: number;
  onCommand?: (command: { executable: string; args: string[] }) => void;
}): ClaudeSpawn {
  return (command) => {
    options.onCommand?.({ executable: command.executable, args: [...command.args] });
    expect(command.executable).toBe("claude");

    const child = nodeSpawn(process.execPath, [RECORDING_AGENT], {
      cwd: tempDirs[0] ?? tmpdir(),
      env: {
        ...process.env,
        CYBERDECK_FIXTURE_RECORD: options.recordPath,
        CYBERDECK_FIXTURE_MODE: "headless",
        CYBERDECK_FIXTURE_ENV_KEYS: "DISABLE_UPDATES",
        ...(options.stdout !== undefined ? { CYBERDECK_FIXTURE_STDOUT: options.stdout } : {}),
        ...(options.stdoutFile !== undefined
          ? { CYBERDECK_FIXTURE_STDOUT_FILE: options.stdoutFile }
          : {}),
        ...(options.stderr !== undefined ? { CYBERDECK_FIXTURE_STDERR: options.stderr } : {}),
        CYBERDECK_FIXTURE_EXIT_CODE: String(options.exitCode ?? 0),
        DISABLE_UPDATES: command.env.DISABLE_UPDATES ?? "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    return {
      onStdout: (listener) => child.stdout.on("data", listener),
      onStderr: (listener) => child.stderr.on("data", listener),
      onExit: (listener) => child.on("exit", listener),
      writeStdin: (data) => child.stdin.write(data),
      endStdin: () => child.stdin.end(),
      kill: (signal) => child.kill(signal),
    };
  };
}

function nextReport(adapter: ClaudeJobDispatchAdapter): Promise<JobReport> {
  return new Promise((resolve) => {
    const unsubscribe = adapter.onReport((report) => {
      unsubscribe();
      resolve(report);
    });
  });
}

describe("ClaudeProviderAdapter interactive launch safety", () => {
  it("refuses to build a launch spec when the model is omitted", () => {
    // The native default displayed Fable, so an omitted model must fail before the launch spec
    // (and therefore before any process) is constructed.
    expect(() => new ClaudeProviderAdapter().buildLaunchSpec(session({ model: undefined }))).toThrow(
      /CLAUDE_LAUNCH_REQUIRES_EXPLICIT_NON_FABLE_MODEL/,
    );
  });

  it("refuses to build a launch spec for a Fable model", () => {
    expect(() =>
      new ClaudeProviderAdapter().buildLaunchSpec(session({ model: "claude-fable-5" })),
    ).toThrow(/CLAUDE_LAUNCH_REQUIRES_EXPLICIT_NON_FABLE_MODEL/);
  });

  it("preserves the Phase 1 interactive argv for an explicit ordinary model", () => {
    const record = session({ name: "proof", sandbox: "workspace-write", model: "opus" });
    const spec = new ClaudeProviderAdapter().buildLaunchSpec(record);
    expect(spec.executable).toBe("claude");
    expect(spec.args).toEqual([
      "--session-id",
      record.id,
      "--name",
      "proof",
      "--permission-mode",
      "manual",
      "--model",
      "opus",
    ]);
    expect(spec.cwd).toBe("/tmp/repo");
    expect(spec.env.DISABLE_UPDATES).toBe("1");
  });

  it("maps read-only to plan and never emits a bypass permission mode", () => {
    const spec = new ClaudeProviderAdapter().buildLaunchSpec(session({ sandbox: "read-only" }));
    expect(spec.args).toContain("plan");
    expect(spec.args).not.toContain("bypassPermissions");
    expect(spec.args).not.toContain("dontAsk");
  });
});

describe("buildClaudeHeadlessCommand", () => {
  it("uses only flags the installed CLI documents for print mode", () => {
    const command = buildClaudeHeadlessCommand(dispatchRequest().request);
    expect(command.executable).toBe("claude");
    expect(command.args).toEqual([
      "--print",
      "--input-format",
      "text",
      "--output-format",
      "stream-json",
      "--permission-mode",
      "plan",
      "--model",
      "opus",
    ]);
    expect(command.cwd).toBe("/tmp/repo");
    expect(command.env.DISABLE_UPDATES).toBe("1");
    expect(command.stdin).toBe("summarise the repository");
  });

  it("maps workspace-write to manual and never emits a bypass permission mode", () => {
    const command = buildClaudeHeadlessCommand(
      dispatchRequest({ sandbox: "workspace-write" }).request,
    );
    expect(command.args).toContain("manual");
    expect(command.args).not.toContain("bypassPermissions");
    expect(command.args).not.toContain("dontAsk");
  });

  it("never emits resume, continuation, or fallback flags", () => {
    const command = buildClaudeHeadlessCommand(dispatchRequest({ name: "child" }).request);
    for (const forbidden of [
      "--resume",
      "-r",
      "--continue",
      "-c",
      "--fork-session",
      "--fallback-model",
      "--session-id",
      "--from-pr",
    ]) {
      expect(command.args).not.toContain(forbidden);
    }
  });

  it("never forwards role as a model or any other argument", () => {
    const command = buildClaudeHeadlessCommand(
      dispatchRequest({ role: "reviewer", model: "opus" }).request,
    );
    expect(command.args).not.toContain("reviewer");
    expect(command.args.filter((arg) => arg === "--model")).toHaveLength(1);
    expect(command.args[command.args.indexOf("--model") + 1]).toBe("opus");
  });

  it("refuses an omitted or Fable model before constructing a command", () => {
    expect(() => buildClaudeHeadlessCommand(dispatchRequest({ model: undefined }).request)).toThrow(
      /CLAUDE_LAUNCH_REQUIRES_EXPLICIT_NON_FABLE_MODEL/,
    );
    expect(() =>
      buildClaudeHeadlessCommand(dispatchRequest({ model: "claude-fable-5-preview" }).request),
    ).toThrow(/CLAUDE_LAUNCH_REQUIRES_EXPLICIT_NON_FABLE_MODEL/);
  });

  it("emits include-partial-messages only when explicitly requested", () => {
    const withoutPartials = buildClaudeHeadlessCommand(dispatchRequest().request);
    expect(withoutPartials.args).not.toContain("--include-partial-messages");

    const withPartials = buildClaudeHeadlessCommand(dispatchRequest().request, {
      includePartialMessages: true,
    });
    expect(withPartials.args).toContain("--include-partial-messages");
  });
});

describe("ClaudeStreamDecoder", () => {
  it("reassembles a frame split across chunks", () => {
    const decoder = new ClaudeStreamDecoder();
    expect(decoder.push(Buffer.from('{"kind":"fixt'))).toEqual([]);
    expect(decoder.push(Buffer.from('ure-frame"}\n'))).toEqual([
      { kind: "json", value: { kind: "fixture-frame" } },
    ]);
  });

  it("decodes multiple frames delivered in one chunk", () => {
    const decoder = new ClaudeStreamDecoder();
    const frames = decoder.push(Buffer.from('{"a":1}\n{"b":2}\n'));
    expect(frames).toEqual([
      { kind: "json", value: { a: 1 } },
      { kind: "json", value: { b: 2 } },
    ]);
  });

  it("reports malformed lines without discarding surrounding frames", () => {
    const decoder = new ClaudeStreamDecoder();
    const frames = decoder.push(Buffer.from('{"a":1}\nnot json\n{"b":2}\n'));
    expect(frames[0]).toEqual({ kind: "json", value: { a: 1 } });
    expect(frames[1]?.kind).toBe("malformed");
    expect(frames[2]).toEqual({ kind: "json", value: { b: 2 } });
  });

  it("skips blank lines and surfaces unterminated trailing data on flush", () => {
    const decoder = new ClaudeStreamDecoder();
    expect(decoder.push(Buffer.from('\n\n{"a":1}\n{"trunc'))).toEqual([
      { kind: "json", value: { a: 1 } },
    ]);
    const flushed = decoder.flush();
    expect(flushed).toHaveLength(1);
    expect(flushed[0]?.kind).toBe("malformed");
  });

  it("decodes B1's well-formed fixture frames", () => {
    const path = fileURLToPath(
      new URL("../fixtures/stream-frames/well-formed.jsonl", import.meta.url),
    );
    const decoder = new ClaudeStreamDecoder();
    const frames = decoder.push(Buffer.from(readFileSync(path)));
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((frame) => frame.kind === "json")).toBe(true);
  });
});

describe("ClaudeJobDispatchAdapter", () => {
  it("acknowledges exactly one accepted job and forwards the instruction on stdin", async () => {
    const dir = tempDir();
    const recordPath = join(dir, "record.json");
    let observed: { executable: string; args: string[] } | undefined;
    const adapter = new ClaudeJobDispatchAdapter({
      spawn: fixtureSpawn({
        recordPath,
        stdout: '{"kind":"fixture-frame"}\n',
        onCommand: (command) => {
          observed = command;
        },
      }),
    });

    const request = dispatchRequest();
    const report = nextReport(adapter);
    const accepted = await adapter.dispatch(request);
    expect(accepted.jobId).toBe(request.jobId);
    expect(typeof accepted.acceptedAt).toBe("string");
    await report;

    const recording = JSON.parse(readFileSync(recordPath, "utf8"));
    expect(recording.stdin).toBe("summarise the repository");
    expect(recording.env.DISABLE_UPDATES).toBe("1");
    expect(observed?.executable).toBe("claude");
    expect(observed?.args).toContain("--print");
  });

  it("fails closed rather than inventing a terminal outcome from an unverified frame schema", async () => {
    const dir = tempDir();
    const adapter = new ClaudeJobDispatchAdapter({
      spawn: fixtureSpawn({
        recordPath: join(dir, "record.json"),
        stdout: '{"kind":"fixture-frame"}\n',
      }),
    });

    const report = nextReport(adapter);
    await adapter.dispatch(dispatchRequest());
    const settled = await report;

    expect(() => JobReportSchema.parse(settled)).not.toThrow();
    expect(settled.result.outcome).toBe("failed");
    if (settled.result.outcome === "failed") {
      expect(settled.result.error.code).toBe("DISPATCH_REJECTED");
      expect(settled.result.error.message).toMatch(/unverified/i);
    }
    expect(settled.usage).toBeUndefined();
  });

  it("emits a validated terminal report through an injected interpreter, with usage only when reported", async () => {
    const dir = tempDir();
    const interpreter: ClaudeResultInterpreter = (outcome) => {
      expect(outcome.exitCode).toBe(0);
      expect(outcome.frames).toHaveLength(1);
      return {
        result: { outcome: "completed", summary: "done", artifacts: [] },
        usage: { schemaVersion: CONTROL_PLANE_SCHEMA_VERSION, inputTokens: 11 },
      };
    };
    const adapter = new ClaudeJobDispatchAdapter({
      spawn: fixtureSpawn({
        recordPath: join(dir, "record.json"),
        stdout: '{"kind":"fixture-frame"}\n',
      }),
      interpreter,
    });

    const report = nextReport(adapter);
    const request = dispatchRequest();
    await adapter.dispatch(request);
    const settled = await report;

    expect(settled.jobId).toBe(request.jobId);
    expect(settled.correlationId).toBe(request.correlationId);
    expect(settled.result).toEqual({ outcome: "completed", summary: "done", artifacts: [] });
    expect(settled.usage?.inputTokens).toBe(11);
  });

  it("omits usage entirely when the interpreter reports none", async () => {
    const dir = tempDir();
    const adapter = new ClaudeJobDispatchAdapter({
      spawn: fixtureSpawn({ recordPath: join(dir, "record.json"), stdout: "" }),
      interpreter: () => ({ result: { outcome: "completed", artifacts: [] } }),
    });

    const report = nextReport(adapter);
    await adapter.dispatch(dispatchRequest());
    const settled = await report;
    expect("usage" in settled).toBe(false);
  });

  it("surfaces a non-zero exit code and stderr to the interpreter", async () => {
    const dir = tempDir();
    const seen: Array<{ exitCode: number | null; stderr: string }> = [];
    const adapter = new ClaudeJobDispatchAdapter({
      spawn: fixtureSpawn({
        recordPath: join(dir, "record.json"),
        stderr: "boom",
        exitCode: 3,
      }),
      interpreter: (outcome) => {
        seen.push({ exitCode: outcome.exitCode, stderr: outcome.stderr });
        return {
          result: {
            outcome: "failed",
            error: { code: "DISPATCH_REJECTED", message: outcome.stderr },
            artifacts: [],
          },
        };
      },
    });

    const report = nextReport(adapter);
    await adapter.dispatch(dispatchRequest());
    const settled = await report;

    expect(seen[0]?.exitCode).toBe(3);
    expect(seen[0]?.stderr).toContain("boom");
    expect(settled.result.outcome).toBe("failed");
  });

  it("reports malformed stdout as decoded malformed frames rather than crashing", async () => {
    const dir = tempDir();
    const malformedFixture = fileURLToPath(
      new URL("../fixtures/stream-frames/malformed.jsonl", import.meta.url),
    );
    let malformedCount = 0;
    const adapter = new ClaudeJobDispatchAdapter({
      spawn: fixtureSpawn({
        recordPath: join(dir, "record.json"),
        stdoutFile: malformedFixture,
      }),
      interpreter: (outcome) => {
        malformedCount = outcome.frames.filter((frame) => frame.kind === "malformed").length;
        return { result: { outcome: "completed", artifacts: [] } };
      },
    });

    const report = nextReport(adapter);
    await adapter.dispatch(dispatchRequest());
    await report;
    expect(malformedCount).toBeGreaterThan(0);
  });

  it("accepts cancellation, cleans up the process, and settles as cancelled", async () => {
    const dir = tempDir();
    const killed = vi.fn();
    const adapter = new ClaudeJobDispatchAdapter({
      spawn: (command) => {
        const handle = fixtureSpawn({ recordPath: join(dir, "record.json") })(command);
        return { ...handle, kill: (signal) => {
          killed(signal);
          handle.kill(signal);
        } };
      },
      interpreter: () => ({ result: { outcome: "completed", artifacts: [] } }),
    });

    const request = dispatchRequest();
    const report = nextReport(adapter);
    await adapter.dispatch(request);
    const result = await adapter.cancel({
      schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
      jobId: request.jobId,
      correlationId: request.correlationId,
      reason: "operator stopped it",
    });

    expect(result).toEqual({ accepted: true, jobId: request.jobId });
    expect(killed).toHaveBeenCalled();
    const settled = await report;
    expect(settled.result).toEqual({ outcome: "cancelled", reason: "operator stopped it" });
  });

  it("refuses cancellation for an unknown job", async () => {
    const adapter = new ClaudeJobDispatchAdapter({ spawn: () => { throw new Error("unused"); } });
    const result = await adapter.cancel({
      schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
      jobId: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
    } as never);
    expect(result).toEqual({
      accepted: false,
      jobId: expect.any(String),
      code: "JOB_NOT_FOUND",
    });
  });

  it("refuses a second dispatch of the same job id", async () => {
    const dir = tempDir();
    const adapter = new ClaudeJobDispatchAdapter({
      spawn: fixtureSpawn({ recordPath: join(dir, "record.json") }),
      interpreter: () => ({ result: { outcome: "completed", artifacts: [] } }),
    });
    const request = dispatchRequest();
    const report = nextReport(adapter);
    await adapter.dispatch(request);
    await expect(adapter.dispatch(request)).rejects.toThrow(/already/i);
    await report;
  });

  it("rejects a dispatch whose model is omitted before any process is spawned", async () => {
    const spawn = vi.fn();
    const adapter = new ClaudeJobDispatchAdapter({ spawn: spawn as unknown as ClaudeSpawn });
    await expect(adapter.dispatch(dispatchRequest({ model: undefined }))).rejects.toThrow(
      /CLAUDE_LAUNCH_REQUIRES_EXPLICIT_NON_FABLE_MODEL/,
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it("stops delivering reports after unsubscribe", async () => {
    const dir = tempDir();
    const adapter = new ClaudeJobDispatchAdapter({
      spawn: fixtureSpawn({ recordPath: join(dir, "record.json") }),
      interpreter: () => ({ result: { outcome: "completed", artifacts: [] } }),
    });
    const listener = vi.fn();
    const unsubscribe = adapter.onReport(listener);
    unsubscribe();

    const settled = nextReport(adapter);
    await adapter.dispatch(dispatchRequest());
    await settled;
    expect(listener).not.toHaveBeenCalled();
  });

  it("declares the neutral claude provider id", () => {
    expect(new ClaudeJobDispatchAdapter().provider).toBe("claude");
  });
});
