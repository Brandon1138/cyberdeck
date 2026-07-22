import { spawn as nodeSpawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JobControlPlane } from "../../src/control-plane/job-control-plane.js";
import { InMemoryProviderRegistry } from "../../src/control-plane/provider-registry.js";
import { CONTROL_PLANE_SCHEMA_VERSION } from "../../src/domain/control-plane.js";
import type { DispatchRequest } from "../../src/domain/dispatch.js";
import type { JobReport } from "../../src/domain/job.js";
import {
  CURSOR_PROVIDER_DESCRIPTOR,
  CursorJobDispatchAdapter,
  type CursorProcessHandle,
  type CursorResultInterpreter,
  type CursorSpawn,
} from "../../src/providers/cursor/dispatch-adapter.js";
import {
  buildCursorHeadlessCommand,
  buildCursorInteractiveCommand,
} from "../../src/providers/cursor/commands.js";
import { CursorStreamDecoder } from "../../src/providers/cursor/stream-codec.js";

const RECORDING_AGENT = fileURLToPath(new URL("../fixtures/recording-agent.mjs", import.meta.url));
const tempDirs: string[] = [];
const children = new Set<ReturnType<typeof nodeSpawn>>();
const NOW = "2026-07-21T10:00:00.000Z";

afterEach(() => {
  vi.useRealTimers();
  for (const child of children) child.kill("SIGKILL");
  children.clear();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "cyberdeck-cursor-"));
  tempDirs.push(directory);
  return directory;
}

function request(overrides: Record<string, unknown> = {}): DispatchRequest {
  return {
    schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
    jobId: crypto.randomUUID(),
    correlationId: crypto.randomUUID(),
    request: {
      schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
      provider: "cursor",
      cwd: "/tmp/repo",
      sandbox: "read-only",
      instruction: "inspect the fixture repository",
      ...overrides,
    },
  } as DispatchRequest;
}

function fixtureSpawn(options: {
  recordPath: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  observe?: (command: { executable: string; args: string[] }) => void;
}): CursorSpawn {
  return (command) => {
    options.observe?.({ executable: command.executable, args: [...command.args] });
    expect(command.executable).toBe("agent");
    const child = nodeSpawn(process.execPath, [RECORDING_AGENT, ...command.args], {
      // The fixture itself runs in an existing temporary directory; `observe` captures the command
      // cwd separately, so no test ever needs the requested repository to exist.
      cwd: tempDirs[0] ?? tmpdir(),
      env: {
        ...process.env,
        CYBERDECK_FIXTURE_RECORD: options.recordPath,
        CYBERDECK_FIXTURE_MODE: "headless",
        ...(options.stdout !== undefined ? { CYBERDECK_FIXTURE_STDOUT: options.stdout } : {}),
        ...(options.stderr !== undefined ? { CYBERDECK_FIXTURE_STDERR: options.stderr } : {}),
        CYBERDECK_FIXTURE_EXIT_CODE: String(options.exitCode ?? 0),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.add(child);
    child.once("exit", () => children.delete(child));
    return {
      onStdout: (listener) => child.stdout.on("data", listener),
      onStderr: (listener) => child.stderr.on("data", listener),
      onExit: (listener) => child.on("exit", listener),
      onError: (listener) => child.on("error", listener),
      endStdin: () => child.stdin.end(),
      kill: (signal) => child.kill(signal),
    };
  };
}

function nextReport(adapter: CursorJobDispatchAdapter): Promise<JobReport> {
  return new Promise((resolve) => {
    const unsubscribe = adapter.onReport((report) => {
      unsubscribe();
      resolve(report);
    });
  });
}

function controllableHandle(): CursorProcessHandle & {
  exit(code?: number | null, signal?: NodeJS.Signals | null): void;
  fail(error: Error): void;
  killed: NodeJS.Signals[];
} {
  let exitListener: (code: number | null, signal: NodeJS.Signals | null) => void = () => {};
  let errorListener: (error: Error) => void = () => {};
  const handle = {
    killed: [] as NodeJS.Signals[],
    onStdout() {},
    onStderr() {},
    onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void) {
      exitListener = listener;
    },
    onError(listener: (error: Error) => void) {
      errorListener = listener;
    },
    endStdin() {},
    kill(signal: NodeJS.Signals = "SIGTERM") {
      handle.killed.push(signal);
    },
    exit(code: number | null = 0, signal: NodeJS.Signals | null = null) {
      exitListener(code, signal);
    },
    fail(error: Error) {
      errorListener(error);
    },
  };
  return handle;
}

describe("Cursor command construction", () => {
  it("builds an interactive read-only command for a broker-owned PTY", () => {
    const command = buildCursorInteractiveCommand(request().request);
    expect(command).toEqual({
      executable: "agent",
      args: ["--workspace", "/tmp/repo", "--sandbox", "enabled", "--mode", "plan"],
      cwd: "/tmp/repo",
      env: expect.any(Object),
    });
  });

  it("adds an explicit initial prompt as Cursor's positional interactive prompt", () => {
    expect(buildCursorInteractiveCommand(request().request, "Ping back").args.slice(-1))
      .toEqual(["Ping back"]);
  });

  it("builds headless stream-json argv with the documented positional prompt", () => {
    const command = buildCursorHeadlessCommand(request().request, { streamPartialOutput: true });
    expect(command.executable).toBe("agent");
    expect(command.args).toEqual([
      "--print",
      "--output-format",
      "stream-json",
      "--stream-partial-output",
      "--workspace",
      "/tmp/repo",
      "--sandbox",
      "enabled",
      "--mode",
      "plan",
      "inspect the fixture repository",
    ]);
    expect(command.cwd).toBe("/tmp/repo");
  });

  it("keeps workspace-write sandboxed without inventing a read-only mode", () => {
    const interactive = buildCursorInteractiveCommand(
      request({ sandbox: "workspace-write" }).request,
    );
    const headless = buildCursorHeadlessCommand(request({ sandbox: "workspace-write" }).request);
    for (const command of [interactive, headless]) {
      expect(command.args).toContain("enabled");
      expect(command.args).not.toContain("plan");
      expect(command.args).not.toContain("ask");
    }
  });

  it("forwards only an explicitly supplied model and never forwards role", () => {
    const omitted = buildCursorHeadlessCommand(request({ role: "reviewer" }).request);
    expect(omitted.args).not.toContain("--model");
    expect(omitted.args).not.toContain("reviewer");

    const explicit = buildCursorHeadlessCommand(
      request({ model: "provider-native-model", role: "reviewer" }).request,
    );
    expect(explicit.args).toContain("--model");
    expect(explicit.args[explicit.args.indexOf("--model") + 1]).toBe("provider-native-model");
    expect(explicit.args).not.toContain("reviewer");
  });

  it("never emits trust, force, auto-routing, fallback, continuation, or MCP bypass flags", () => {
    const commands = [
      buildCursorInteractiveCommand(request().request),
      buildCursorHeadlessCommand(request().request),
    ];
    const forbidden = [
      "--force",
      "-f",
      "--yolo",
      "--auto-review",
      "--approve-mcps",
      "--trust",
      "--resume",
      "--continue",
      "--worktree",
      "--add-dir",
      "--api-key",
    ];
    for (const command of commands) {
      for (const flag of forbidden) expect(command.args).not.toContain(flag);
    }
  });
});

describe("CursorStreamDecoder", () => {
  it("reassembles partial frames and decodes multiple frames", () => {
    const decoder = new CursorStreamDecoder();
    expect(decoder.push(Buffer.from('{"seq":'))).toEqual([]);
    expect(decoder.push(Buffer.from('1}\n{"seq":2}\n'))).toEqual([
      { kind: "json", value: { seq: 1 } },
      { kind: "json", value: { seq: 2 } },
    ]);
  });

  it("surfaces malformed and truncated output without dropping valid frames", () => {
    const decoder = new CursorStreamDecoder();
    const frames = decoder.push(Buffer.from('{"seq":1}\nnot-json\n{"seq":'));
    expect(frames[0]).toEqual({ kind: "json", value: { seq: 1 } });
    expect(frames[1]?.kind).toBe("malformed");
    expect(decoder.flush()[0]?.kind).toBe("malformed");
  });
});

describe("CursorJobDispatchAdapter", () => {
  it("uses only the injected fixture spawn and emits one validated terminal report", async () => {
    const directory = tempDir();
    let observedExecutable = "";
    const interpreter: CursorResultInterpreter = (outcome) => {
      expect(outcome.frames).toHaveLength(2);
      return { result: { outcome: "completed", summary: "fixture complete", artifacts: [] } };
    };
    const adapter = new CursorJobDispatchAdapter({
      spawn: fixtureSpawn({
        recordPath: join(directory, "record.json"),
        stdout: '{"fixture":1}\n{"fixture":2}\n',
        observe: (command) => {
          observedExecutable = command.executable;
        },
      }),
      interpreter,
      now: () => NOW,
    });
    const report = nextReport(adapter);
    const dispatch = request();
    const accepted = await adapter.dispatch(dispatch);
    const settled = await report;

    expect(accepted.jobId).toBe(dispatch.jobId);
    expect(settled.result).toEqual({
      outcome: "completed",
      summary: "fixture complete",
      artifacts: [],
    });
    expect(observedExecutable).toBe("agent");
    const recording = JSON.parse(readFileSync(join(directory, "record.json"), "utf8"));
    expect(recording.stdin).toBe("");
    expect(recording.argv.at(-1)).toBe("inspect the fixture repository");
  });

  it("fails closed on a clean exit when Cursor's frame schema remains live-unverified", async () => {
    const directory = tempDir();
    const adapter = new CursorJobDispatchAdapter({
      spawn: fixtureSpawn({
        recordPath: join(directory, "record.json"),
        stdout: '{"fixture":1}\n',
      }),
      now: () => NOW,
    });
    const report = nextReport(adapter);
    await adapter.dispatch(request());
    const settled = await report;
    expect(settled.result.outcome).toBe("failed");
    if (settled.result.outcome === "failed") expect(settled.result.error.message).toMatch(/unverified/i);
  });

  it("fails deterministically on malformed output or non-zero exit", async () => {
    for (const fixture of [
      { stdout: "not-json\n", exitCode: 0 },
      { stdout: '{"fixture":1}\n', stderr: "boom", exitCode: 3 },
    ]) {
      const directory = tempDir();
      const interpreter = vi.fn<CursorResultInterpreter>(() => ({
        result: { outcome: "completed", artifacts: [] },
      }));
      const adapter = new CursorJobDispatchAdapter({
        spawn: fixtureSpawn({ recordPath: join(directory, "record.json"), ...fixture }),
        interpreter,
        now: () => NOW,
      });
      const report = nextReport(adapter);
      await adapter.dispatch(request());
      const settled = await report;
      expect(settled.result.outcome).toBe("failed");
      expect(interpreter).not.toHaveBeenCalled();
    }
  });

  it("reports cancellation once, kills the process, and cleans its running state", async () => {
    const handle = controllableHandle();
    const adapter = new CursorJobDispatchAdapter({ spawn: () => handle, now: () => NOW });
    const dispatch = request();
    const report = nextReport(adapter);
    await adapter.dispatch(dispatch);
    const cancelled = await adapter.cancel({
      schemaVersion: 1,
      jobId: dispatch.jobId,
      correlationId: dispatch.correlationId,
      reason: "operator stop",
    });
    expect(cancelled.accepted).toBe(true);
    expect(handle.killed).toEqual(["SIGTERM"]);
    handle.exit(null, "SIGTERM");
    expect((await report).result).toEqual({ outcome: "cancelled", reason: "operator stop" });
    expect(adapter.activeJobCount).toBe(0);
  });

  it("times out, kills, and reports timedOut without provider interpretation", async () => {
    vi.useFakeTimers();
    const handle = controllableHandle();
    const interpreter = vi.fn<CursorResultInterpreter>();
    const adapter = new CursorJobDispatchAdapter({
      spawn: () => handle,
      interpreter,
      timeoutMs: 50,
      now: () => NOW,
    });
    const report = nextReport(adapter);
    await adapter.dispatch(request());
    await vi.advanceTimersByTimeAsync(50);
    expect(handle.killed).toEqual(["SIGTERM"]);
    handle.exit(null, "SIGTERM");
    expect((await report).result.outcome).toBe("timedOut");
    expect(interpreter).not.toHaveBeenCalled();
    expect(adapter.activeJobCount).toBe(0);
  });

  it("turns a process error into one failed report and cleanup", async () => {
    const handle = controllableHandle();
    const adapter = new CursorJobDispatchAdapter({ spawn: () => handle, now: () => NOW });
    const report = nextReport(adapter);
    await adapter.dispatch(request());
    handle.fail(new Error("fixture spawn failure"));
    const settled = await report;
    expect(settled.result.outcome).toBe("failed");
    expect(adapter.activeJobCount).toBe(0);
    handle.exit(1, null);
  });

  it("rejects duplicate dispatch before constructing a second process", async () => {
    const handle = controllableHandle();
    const spawn = vi.fn<CursorSpawn>(() => handle);
    const adapter = new CursorJobDispatchAdapter({ spawn, now: () => NOW });
    const dispatch = request();
    await adapter.dispatch(dispatch);
    await expect(adapter.dispatch(dispatch)).rejects.toThrow(/already dispatched/i);
    expect(spawn).toHaveBeenCalledTimes(1);
    handle.exit(0, null);
  });

  it("registers through A1/A2's open provider and adapter seams without A-owned edits", async () => {
    const registry = new InMemoryProviderRegistry();
    registry.register(CURSOR_PROVIDER_DESCRIPTOR);
    const handle = controllableHandle();
    const adapter = new CursorJobDispatchAdapter({ spawn: () => handle, now: () => NOW });
    const plane = new JobControlPlane({ registry, now: () => NOW });
    plane.registerAdapter(adapter);

    const submitted = await plane.submit({
      request: request().request,
      idempotencyKey: "cursor-fixture",
    });
    expect(submitted.job.request.provider).toBe("cursor");
    expect(submitted.job.lifecycle.status).toBe("dispatched");
    handle.exit(0, null);
    await plane.whenIdle();
  });
});
