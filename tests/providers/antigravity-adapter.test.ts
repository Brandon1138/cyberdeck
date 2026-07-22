import { spawn as nodeSpawn } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
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
  ANTIGRAVITY_CAPABILITIES,
  antigravityCapability,
} from "../../src/providers/antigravity/capabilities.js";
import {
  AntigravityLaunchSafetyError,
  AntigravityUnsupportedSandboxError,
  buildAntigravityHeadlessCommand,
  buildAntigravityInteractiveCommand,
} from "../../src/providers/antigravity/commands.js";
import {
  ANTIGRAVITY_PROVIDER_DESCRIPTOR,
  AntigravityJobDispatchAdapter,
  type AntigravityProcessHandle,
  type AntigravityResultInterpreter,
  type AntigravitySpawn,
} from "../../src/providers/antigravity/dispatch-adapter.js";
import {
  AntigravityMalformedOutputError,
  AntigravityTextCollector,
} from "../../src/providers/antigravity/text-output.js";

const RECORDING_AGENT = fileURLToPath(new URL("../fixtures/recording-agent.mjs", import.meta.url));
const NOW = "2026-07-21T12:00:00.000Z";
const CONTROLLED_ENV: NodeJS.ProcessEnv = { PATH: "", CYBERDECK_TEST_MARKER: "agy-fixture" };
const tempDirs: string[] = [];
const children = new Set<ReturnType<typeof nodeSpawn>>();

afterEach(() => {
  vi.useRealTimers();
  for (const child of children) child.kill("SIGKILL");
  children.clear();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function tempDir(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "cyberdeck-antigravity-")));
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
      provider: "antigravity",
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
  observe?: (command: {
    executable: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdin: string;
  }) => void;
}): AntigravitySpawn {
  return (command) => {
    options.observe?.({ ...command, args: [...command.args], env: { ...command.env } });
    expect(command.executable).toBe("agy");
    expect(command.env.PATH).toBe("");

    // The fixture is addressed through the current Node executable. PATH is deliberately empty,
    // so this test cannot resolve or spawn the installed `agy` executable.
    const child = nodeSpawn(process.execPath, [RECORDING_AGENT, ...command.args], {
      cwd: command.cwd,
      env: {
        ...command.env,
        CYBERDECK_FIXTURE_RECORD: options.recordPath,
        CYBERDECK_FIXTURE_MODE: "headless",
        CYBERDECK_FIXTURE_ENV_KEYS: "PATH,CYBERDECK_TEST_MARKER",
        ...(options.stdout !== undefined ? { CYBERDECK_FIXTURE_STDOUT: options.stdout } : {}),
        ...(options.stderr !== undefined ? { CYBERDECK_FIXTURE_STDERR: options.stderr } : {}),
        CYBERDECK_FIXTURE_EXIT_CODE: String(options.exitCode ?? 0),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.add(child);
    child.once("close", () => children.delete(child));
    return {
      onStdout: (listener) => child.stdout.on("data", listener),
      onStderr: (listener) => child.stderr.on("data", listener),
      onExit: (listener) => child.on("close", listener),
      onError: (listener) => child.on("error", listener),
      endStdin: () => child.stdin.end(command.stdin),
      kill: (signal) => child.kill(signal),
    };
  };
}

function controllableHandle(): AntigravityProcessHandle & {
  stdout(chunk: Buffer): void;
  stderr(chunk: Buffer): void;
  exit(code?: number | null, signal?: NodeJS.Signals | null): void;
  fail(error: Error): void;
  readonly killed: NodeJS.Signals[];
  readonly stdinEnds: number;
} {
  let stdoutListener: (chunk: Buffer) => void = () => {};
  let stderrListener: (chunk: Buffer) => void = () => {};
  let exitListener: (code: number | null, signal: NodeJS.Signals | null) => void = () => {};
  let errorListener: (error: Error) => void = () => {};
  const state = { killed: [] as NodeJS.Signals[], stdinEnds: 0 };
  return {
    get killed() {
      return state.killed;
    },
    get stdinEnds() {
      return state.stdinEnds;
    },
    onStdout(listener) {
      stdoutListener = listener;
    },
    onStderr(listener) {
      stderrListener = listener;
    },
    onExit(listener) {
      exitListener = listener;
    },
    onError(listener) {
      errorListener = listener;
    },
    endStdin() {
      state.stdinEnds += 1;
    },
    kill(signal = "SIGTERM") {
      state.killed.push(signal);
    },
    stdout(chunk) {
      stdoutListener(chunk);
    },
    stderr(chunk) {
      stderrListener(chunk);
    },
    exit(code = 0, signal = null) {
      exitListener(code, signal);
    },
    fail(error) {
      errorListener(error);
    },
  };
}

function nextReport(adapter: AntigravityJobDispatchAdapter): Promise<JobReport> {
  return new Promise((resolve) => {
    const unsubscribe = adapter.onReport((report) => {
      unsubscribe();
      resolve(report);
    });
  });
}

describe("Antigravity command construction", () => {
  it("exports neutral registration evidence and an exact broker-PTY command", () => {
    expect(ANTIGRAVITY_PROVIDER_DESCRIPTOR).toEqual({
      id: "antigravity",
      displayName: "Antigravity",
    });
    const command = buildAntigravityInteractiveCommand(request().request, {
      env: CONTROLLED_ENV,
    });
    expect(command).toEqual({
      executable: "agy",
      args: ["--mode", "plan", "--sandbox"],
      cwd: "/tmp/repo",
      env: CONTROLLED_ENV,
      stdin: "",
    });
  });

  it("uses agy's documented prompt-interactive mode for an initial worker prompt", () => {
    const command = buildAntigravityInteractiveCommand({
      ...request().request,
      effort: "low",
    }, {
      env: CONTROLLED_ENV,
      initialPrompt: "Ping back",
    });
    expect(command.args).toEqual([
      "--prompt-interactive",
      "Ping back",
      "--mode",
      "plan",
      "--sandbox",
      "--effort",
      "low",
    ]);
  });

  it("rejects effort values outside agy's documented low-medium-high range", () => {
    expect(() => buildAntigravityInteractiveCommand({
      ...request().request,
      effort: "xhigh",
    })).toThrow(expect.objectContaining({ code: "ANTIGRAVITY_LAUNCH_UNSAFE" }));
  });

  it("maps the documented headless prompt to argv and closes empty stdin", () => {
    const command = buildAntigravityHeadlessCommand(request().request, {
      env: CONTROLLED_ENV,
    });
    expect(command).toEqual({
      executable: "agy",
      args: ["--print", "inspect the fixture repository", "--mode", "plan", "--sandbox"],
      cwd: "/tmp/repo",
      env: {
        ...CONTROLLED_ENV,
        CYBERDECK_PROCESS_ROLE: "worker",
        CYBERDECK_WORKER_MODE: "normal",
      },
      stdin: "",
    });
  });

  it("injects Caveman policy into the actual Antigravity worker prompt", () => {
    const command = buildAntigravityHeadlessCommand(request({ workerMode: "caveman" }).request, {
      env: CONTROLLED_ENV,
    });
    expect(command.args[1]).toContain("CAVEMAN MODE ACTIVE");
    expect(command.args[1]).toContain("WORKER TASK\ninspect the fixture repository");
  });

  it("rejects workspace-write because accept-edits is not proven equivalent", () => {
    const writeRequest = request({ sandbox: "workspace-write" }).request;
    expect(() => buildAntigravityInteractiveCommand(writeRequest)).toThrow(
      AntigravityUnsupportedSandboxError,
    );
    expect(() => buildAntigravityHeadlessCommand(writeRequest)).toThrow(
      AntigravityUnsupportedSandboxError,
    );
  });

  it("forwards only an explicit model and never derives --agent from role", () => {
    const omitted = buildAntigravityHeadlessCommand(request({ role: "reviewer" }).request);
    expect(omitted.args).not.toContain("--model");
    expect(omitted.args).not.toContain("--agent");
    expect(omitted.args).not.toContain("reviewer");

    const explicit = buildAntigravityHeadlessCommand(
      request({ model: "gemini-provider-native", role: "reviewer" }).request,
    );
    expect(explicit.args.slice(-2)).toEqual(["--model", "gemini-provider-native"]);
    expect(explicit.args).not.toContain("--agent");
    expect(explicit.args).not.toContain("reviewer");
  });

  it("rejects Fable and never emits bypass, routing, retry, fallback, or continuation flags", () => {
    expect(() =>
      buildAntigravityHeadlessCommand(request({ model: "claude-fable-5" }).request),
    ).toThrow(AntigravityLaunchSafetyError);

    const commands = [
      buildAntigravityInteractiveCommand(request().request),
      buildAntigravityHeadlessCommand(request().request),
    ];
    const forbidden = [
      "--dangerously-skip-permissions",
      "--force",
      "--yolo",
      "--continue",
      "-c",
      "--conversation",
      "--resume",
      "--fallback-model",
      "--agent",
      "--output-format",
      "--retry",
      "--route",
    ];
    for (const command of commands) {
      for (const flag of forbidden) expect(command.args).not.toContain(flag);
    }
  });
});

describe("Antigravity plain-text output", () => {
  it("retains partial UTF-8 and JSON-looking output as unstructured text", () => {
    const collector = new AntigravityTextCollector(64);
    const bytes = Buffer.from('first {"looks":"structured"} ☃');
    collector.push(bytes.subarray(0, bytes.length - 2));
    collector.push(bytes.subarray(bytes.length - 2));
    expect(collector.text()).toBe('first {"looks":"structured"} ☃');
  });

  it("rejects malformed UTF-8 rather than manufacturing replacement text", () => {
    const collector = new AntigravityTextCollector(64);
    collector.push(Buffer.from([0xff]));
    expect(() => collector.text()).toThrow(AntigravityMalformedOutputError);
  });
});

describe("Antigravity capability evidence", () => {
  it("reports unsupported and live-unverified behavior honestly", () => {
    expect(antigravityCapability("structured-streaming")?.support).toBe("unsupported");
    expect(antigravityCapability("workspace-write")?.support).toBe("unsupported");
    expect(antigravityCapability("agent-selection-from-contract")?.support).toBe("unsupported");
    expect(antigravityCapability("conversation-resume")?.support).toBe("live-unverified");
    expect(antigravityCapability("plain-text-result-interpretation")?.support).toBe(
      "live-unverified",
    );
    for (const capability of ANTIGRAVITY_CAPABILITIES) {
      expect(capability.reason.length).toBeGreaterThan(0);
    }
  });
});

describe("AntigravityJobDispatchAdapter", () => {
  it("uses only the controlled fixture and maps exact argv, cwd, env, and empty stdin", async () => {
    const workspace = tempDir();
    const recordPath = join(workspace, "record.json");
    let observed: Parameters<NonNullable<Parameters<typeof fixtureSpawn>[0]["observe"]>>[0] | undefined;
    const interpreter: AntigravityResultInterpreter = (outcome) => {
      expect(outcome).toEqual({ stdout: "plain fixture output", stderr: "", exitCode: 0 });
      return { result: { outcome: "completed", summary: outcome.stdout, artifacts: [] } };
    };
    const adapter = new AntigravityJobDispatchAdapter({
      spawn: fixtureSpawn({
        recordPath,
        stdout: "plain fixture output",
        observe: (command) => {
          observed = command;
        },
      }),
      interpreter,
      env: CONTROLLED_ENV,
      now: () => NOW,
    });
    const dispatch = request({ cwd: workspace });
    const report = nextReport(adapter);
    const accepted = await adapter.dispatch(dispatch);
    const settled = await report;
    const recording = JSON.parse(readFileSync(recordPath, "utf8")) as {
      argv: string[];
      cwd: string;
      env: Record<string, string>;
      stdin: string;
    };

    expect(accepted).toEqual({ schemaVersion: 1, jobId: dispatch.jobId, acceptedAt: NOW });
    expect(observed).toEqual({
      executable: "agy",
      args: ["--print", "inspect the fixture repository", "--mode", "plan", "--sandbox"],
      cwd: workspace,
      env: {
        ...CONTROLLED_ENV,
        CYBERDECK_PROCESS_ROLE: "worker",
        CYBERDECK_WORKER_MODE: "normal",
      },
      stdin: "",
    });
    expect(recording).toMatchObject({
      argv: observed?.args,
      cwd: workspace,
      env: CONTROLLED_ENV,
      stdin: "",
    });
    expect(settled.result).toEqual({
      outcome: "completed",
      summary: "plain fixture output",
      artifacts: [],
    });
    expect(settled.usage).toBeUndefined();
    expect(adapter.activeJobCount).toBe(0);
    expect(children.size).toBe(0);
  });

  it("fails closed on clean EOF instead of treating text or JSON as structured completion", async () => {
    for (const stdout of ["looks successful", '{"outcome":"completed"}']) {
      const handle = controllableHandle();
      const adapter = new AntigravityJobDispatchAdapter({ spawn: () => handle, now: () => NOW });
      const reported = nextReport(adapter);
      await adapter.dispatch(request());
      handle.stdout(Buffer.from(stdout));
      handle.exit(0, null);
      const report = await reported;
      expect(report.result.outcome).toBe("failed");
      if (report.result.outcome === "failed") {
        expect(report.result.error.message).toMatch(/interpreter|unverified/i);
      }
    }
  });

  it("preserves partial output and captured stderr for an explicit interpreter", async () => {
    const handle = controllableHandle();
    const interpreter = vi.fn<AntigravityResultInterpreter>(() => ({
      result: { outcome: "completed", artifacts: [] },
    }));
    const adapter = new AntigravityJobDispatchAdapter({
      spawn: () => handle,
      interpreter,
      now: () => NOW,
    });
    const reported = nextReport(adapter);
    await adapter.dispatch(request());
    handle.stdout(Buffer.from("par"));
    handle.stdout(Buffer.from("tial"));
    handle.stderr(Buffer.from("warning"));
    handle.exit(0, null);
    await reported;
    expect(interpreter).toHaveBeenCalledWith({
      stdout: "partial",
      stderr: "warning",
      exitCode: 0,
    });
  });

  it.each(["stdout", "stderr"] as const)("bounds %s and terminates the fixture process", async (stream) => {
    const handle = controllableHandle();
    const interpreter = vi.fn<AntigravityResultInterpreter>();
    const adapter = new AntigravityJobDispatchAdapter({
      spawn: () => handle,
      interpreter,
      maxOutputBytes: 4,
      now: () => NOW,
    });
    const reported = nextReport(adapter);
    await adapter.dispatch(request());
    handle[stream](Buffer.from("12345"));
    const report = await reported;
    expect(report.result.outcome).toBe("failed");
    expect(handle.killed).toEqual(["SIGTERM"]);
    expect(interpreter).not.toHaveBeenCalled();
    expect(adapter.activeJobCount).toBe(0);
  });

  it("rejects malformed UTF-8 without invoking the result interpreter", async () => {
    const handle = controllableHandle();
    const interpreter = vi.fn<AntigravityResultInterpreter>();
    const adapter = new AntigravityJobDispatchAdapter({
      spawn: () => handle,
      interpreter,
      now: () => NOW,
    });
    const reported = nextReport(adapter);
    await adapter.dispatch(request());
    handle.stdout(Buffer.from([0xff]));
    handle.exit(0, null);
    expect((await reported).result.outcome).toBe("failed");
    expect(interpreter).not.toHaveBeenCalled();
  });

  it("fails non-zero exit with bounded stderr and never lets an interpreter override it", async () => {
    const handle = controllableHandle();
    const interpreter = vi.fn<AntigravityResultInterpreter>();
    const adapter = new AntigravityJobDispatchAdapter({
      spawn: () => handle,
      interpreter,
      now: () => NOW,
    });
    const reported = nextReport(adapter);
    await adapter.dispatch(request());
    handle.stdout(Buffer.from("partial"));
    handle.stderr(Buffer.from("provider failed"));
    handle.exit(7, null);
    const report = await reported;
    expect(report.result.outcome).toBe("failed");
    if (report.result.outcome === "failed") expect(report.result.error.message).toMatch(/7.*provider failed/);
    expect(interpreter).not.toHaveBeenCalled();
  });

  it("reports process error once, kills, and suppresses a later exit", async () => {
    const handle = controllableHandle();
    const adapter = new AntigravityJobDispatchAdapter({ spawn: () => handle, now: () => NOW });
    const reports: JobReport[] = [];
    adapter.onReport((report) => reports.push(report));
    await adapter.dispatch(request());
    handle.fail(new Error("fixture disconnect"));
    handle.exit(1, null);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.result.outcome).toBe("failed");
    expect(handle.killed).toEqual(["SIGTERM"]);
    expect(adapter.activeJobCount).toBe(0);
  });

  it("cancels, terminates, suppresses interpretation, and cleans running state", async () => {
    const handle = controllableHandle();
    const interpreter = vi.fn<AntigravityResultInterpreter>();
    const adapter = new AntigravityJobDispatchAdapter({
      spawn: () => handle,
      interpreter,
      now: () => NOW,
    });
    const dispatch = request();
    const reported = nextReport(adapter);
    await adapter.dispatch(dispatch);
    const cancellation = await adapter.cancel({
      schemaVersion: 1,
      jobId: dispatch.jobId,
      correlationId: dispatch.correlationId,
      reason: "operator stop",
    });
    expect(cancellation.accepted).toBe(true);
    expect(handle.killed).toEqual(["SIGTERM"]);
    handle.exit(null, "SIGTERM");
    expect((await reported).result).toEqual({ outcome: "cancelled", reason: "operator stop" });
    expect(interpreter).not.toHaveBeenCalled();
    expect(adapter.activeJobCount).toBe(0);
  });

  it("times out, terminates, and reports timedOut without interpretation", async () => {
    vi.useFakeTimers();
    const handle = controllableHandle();
    const interpreter = vi.fn<AntigravityResultInterpreter>();
    const adapter = new AntigravityJobDispatchAdapter({
      spawn: () => handle,
      interpreter,
      timeoutMs: 25,
      now: () => NOW,
    });
    const reported = nextReport(adapter);
    await adapter.dispatch(request());
    await vi.advanceTimersByTimeAsync(25);
    expect(handle.killed).toEqual(["SIGTERM"]);
    handle.exit(null, "SIGTERM");
    expect((await reported).result.outcome).toBe("timedOut");
    expect(interpreter).not.toHaveBeenCalled();
    expect(adapter.activeJobCount).toBe(0);
  });

  it("rejects workspace-write and duplicate dispatch before a second process exists", async () => {
    const handle = controllableHandle();
    const spawn = vi.fn<AntigravitySpawn>(() => handle);
    const adapter = new AntigravityJobDispatchAdapter({ spawn, now: () => NOW });
    await expect(adapter.dispatch(request({ sandbox: "workspace-write" }))).rejects.toThrow(
      AntigravityUnsupportedSandboxError,
    );
    expect(spawn).not.toHaveBeenCalled();

    const dispatch = request();
    await adapter.dispatch(dispatch);
    await expect(adapter.dispatch(dispatch)).rejects.toThrow(/already dispatched/i);
    expect(spawn).toHaveBeenCalledTimes(1);
    handle.exit(0, null);
  });

  it("registers only through the neutral A1/A2 seams", async () => {
    const registry = new InMemoryProviderRegistry();
    registry.register(ANTIGRAVITY_PROVIDER_DESCRIPTOR);
    const handle = controllableHandle();
    const adapter = new AntigravityJobDispatchAdapter({ spawn: () => handle, now: () => NOW });
    const plane = new JobControlPlane({ registry, now: () => NOW });
    plane.registerAdapter(adapter);

    const submitted = await plane.submit({
      request: request().request,
      idempotencyKey: "antigravity-fixture",
    });
    expect(submitted.job.request.provider).toBe("antigravity");
    expect(submitted.job.lifecycle.status).toBe("dispatched");
    handle.exit(0, null);
    await plane.whenIdle();
  });
});
