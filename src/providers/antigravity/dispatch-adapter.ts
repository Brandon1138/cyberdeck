import { spawn as spawnChildProcess } from "node:child_process";
import { CONTROL_PLANE_SCHEMA_VERSION } from "../../domain/control-plane.js";
import {
  CancellationResultSchema,
  DispatchAcceptedSchema,
  type CancellationRequest,
  type CancellationResult,
  type DispatchAccepted,
  type DispatchRequest,
  type JobDispatchAdapter,
} from "../../domain/dispatch.js";
import { JobReportSchema, type JobReport, type JobResult } from "../../domain/job.js";
import type { ProviderDescriptor, ProviderId } from "../../domain/provider-registration.js";
import type { UsageReport } from "../../domain/usage.js";
import {
  buildAntigravityHeadlessCommand,
  type AntigravityCommand,
} from "./commands.js";
import { AntigravityTextCollector } from "./text-output.js";

export const ANTIGRAVITY_PROVIDER_DESCRIPTOR = {
  id: "antigravity",
  displayName: "Antigravity",
} as const satisfies ProviderDescriptor;

export interface AntigravityProcessHandle {
  onStdout(listener: (chunk: Buffer) => void): void;
  onStderr(listener: (chunk: Buffer) => void): void;
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  onError(listener: (error: Error) => void): void;
  endStdin(): void;
  kill(signal?: NodeJS.Signals): void;
}

export type AntigravitySpawn = (command: AntigravityCommand) => AntigravityProcessHandle;

/** Plain text is data only. An explicit interpreter is the sole path to successful completion. */
export interface AntigravityHeadlessOutcome {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: 0;
}

export interface AntigravityInterpretation {
  result: JobResult;
  usage?: UsageReport;
}

export type AntigravityResultInterpreter = (
  outcome: AntigravityHeadlessOutcome,
) => AntigravityInterpretation;

export const unverifiedAntigravityResultInterpreter: AntigravityResultInterpreter = () => ({
  result: failedResult(
    "Antigravity plain-text result interpreter is unverified: agy documents no result envelope " +
      "or exit-code contract, so text cannot be promoted to structured completion",
  ),
});

export interface AntigravityJobDispatchAdapterOptions {
  spawn?: AntigravitySpawn;
  interpreter?: AntigravityResultInterpreter;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
  now?: () => string;
}

interface RunningJob {
  readonly handle: AntigravityProcessHandle;
  readonly stdout: AntigravityTextCollector;
  readonly stderr: AntigravityTextCollector;
  settled: boolean;
  cancelled: boolean;
  timedOut: boolean;
  cancelReason?: string;
  timer?: NodeJS.Timeout;
}

/** Fixture-proven bounded adapter behind A1's provider-neutral dispatch port. */
export class AntigravityJobDispatchAdapter implements JobDispatchAdapter {
  readonly provider: ProviderId = "antigravity";
  private readonly running = new Map<string, RunningJob>();
  private readonly seen = new Set<string>();
  private readonly listeners = new Set<(report: JobReport) => void>();
  private readonly spawn: AntigravitySpawn;
  private readonly interpret: AntigravityResultInterpreter;

  constructor(private readonly options: AntigravityJobDispatchAdapterOptions = {}) {
    validatePositiveOption("timeoutMs", options.timeoutMs);
    validatePositiveOption("maxOutputBytes", options.maxOutputBytes, true);
    this.spawn = options.spawn ?? defaultAntigravitySpawn;
    this.interpret = options.interpreter ?? unverifiedAntigravityResultInterpreter;
  }

  get activeJobCount(): number {
    return this.running.size;
  }

  async dispatch(request: DispatchRequest): Promise<DispatchAccepted> {
    if (this.seen.has(request.jobId)) {
      throw new Error(`Job ${request.jobId} was already dispatched`);
    }

    // Unsupported sandboxes and unsafe explicit models fail before process construction.
    const command = buildAntigravityHeadlessCommand(
      request.request,
      this.options.env === undefined ? {} : { env: this.options.env },
    );
    this.seen.add(request.jobId);
    const handle = this.spawn(command);
    const entry: RunningJob = {
      handle,
      stdout: new AntigravityTextCollector(this.options.maxOutputBytes),
      stderr: new AntigravityTextCollector(this.options.maxOutputBytes),
      settled: false,
      cancelled: false,
      timedOut: false,
    };
    this.running.set(request.jobId, entry);

    handle.onStdout((chunk) => this.collect(request, entry, entry.stdout, chunk, "stdout"));
    handle.onStderr((chunk) => this.collect(request, entry, entry.stderr, chunk, "stderr"));
    handle.onError((error) => {
      if (entry.cancelled) {
        this.finish(request, entry, cancelledInterpretation(entry.cancelReason));
      } else if (entry.timedOut) {
        this.finish(request, entry, { result: { outcome: "timedOut" } });
      } else {
        this.failAndTerminate(request, entry, `Antigravity process error: ${error.message}`);
      }
    });
    handle.onExit((code, signal) => this.processExit(request, entry, code, signal));

    if (this.options.timeoutMs !== undefined) {
      entry.timer = setTimeout(() => {
        if (entry.settled) return;
        entry.timedOut = true;
        entry.handle.kill("SIGTERM");
      }, this.options.timeoutMs);
      entry.timer.unref();
    }

    try {
      handle.endStdin();
    } catch (error) {
      this.failAndTerminate(
        request,
        entry,
        `Antigravity stdin close failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return DispatchAcceptedSchema.parse({
      schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
      jobId: request.jobId,
      acceptedAt: this.now(),
    });
  }

  async cancel(request: CancellationRequest): Promise<CancellationResult> {
    const entry = this.running.get(request.jobId);
    if (entry === undefined) {
      const code = this.seen.has(request.jobId) ? "JOB_ALREADY_TERMINAL" : "JOB_NOT_FOUND";
      return CancellationResultSchema.parse({ accepted: false, jobId: request.jobId, code });
    }
    if (!entry.cancelled) {
      entry.cancelled = true;
      if (request.reason !== undefined) entry.cancelReason = request.reason;
      if (entry.timer !== undefined) clearTimeout(entry.timer);
      entry.handle.kill("SIGTERM");
    }
    return CancellationResultSchema.parse({ accepted: true, jobId: request.jobId });
  }

  onReport(listener: (report: JobReport) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private collect(
    request: DispatchRequest,
    entry: RunningJob,
    collector: AntigravityTextCollector,
    chunk: Buffer,
    stream: "stdout" | "stderr",
  ): void {
    if (entry.settled) return;
    try {
      collector.push(chunk);
    } catch (error) {
      this.failAndTerminate(
        request,
        entry,
        `Antigravity ${stream} rejected: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private processExit(
    request: DispatchRequest,
    entry: RunningJob,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (entry.settled) return;
    if (entry.cancelled) {
      this.finish(request, entry, cancelledInterpretation(entry.cancelReason));
      return;
    }
    if (entry.timedOut) {
      this.finish(request, entry, { result: { outcome: "timedOut" } });
      return;
    }
    if (signal !== null) {
      this.finish(request, entry, {
        result: failedResult(`Antigravity process exited from signal ${signal}`),
      });
      return;
    }

    let stdout: string;
    let stderr: string;
    try {
      stdout = entry.stdout.text();
      stderr = entry.stderr.text();
    } catch (error) {
      this.finish(request, entry, {
        result: failedResult(error instanceof Error ? error.message : String(error)),
      });
      return;
    }

    if (code !== 0) {
      const detail = stderr.trim() === "" ? "" : `: ${stderr.trim()}`;
      this.finish(request, entry, {
        result: failedResult(`Antigravity process exited with code ${String(code)}${detail}`),
      });
      return;
    }

    this.finish(request, entry, this.interpret({ stdout, stderr, exitCode: 0 }));
  }

  private failAndTerminate(
    request: DispatchRequest,
    entry: RunningJob,
    message: string,
  ): void {
    if (entry.settled) return;
    entry.handle.kill("SIGTERM");
    this.finish(request, entry, { result: failedResult(message) });
  }

  private finish(
    request: DispatchRequest,
    entry: RunningJob,
    interpretation: AntigravityInterpretation,
  ): void {
    if (entry.settled) return;
    entry.settled = true;
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    this.running.delete(request.jobId);
    const report = JobReportSchema.parse({
      schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
      jobId: request.jobId,
      correlationId: request.correlationId,
      reportedAt: this.now(),
      result: interpretation.result,
      ...(interpretation.usage !== undefined ? { usage: interpretation.usage } : {}),
    });
    for (const listener of [...this.listeners]) listener(report);
  }

  private now(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }
}

function cancelledInterpretation(reason: string | undefined): AntigravityInterpretation {
  return {
    result: {
      outcome: "cancelled",
      ...(reason !== undefined ? { reason } : {}),
    },
  };
}

function failedResult(message: string): JobResult {
  return {
    outcome: "failed",
    error: { code: "DISPATCH_REJECTED", message },
    artifacts: [],
  };
}

function validatePositiveOption(name: string, value: number | undefined, integer = false): void {
  if (
    value !== undefined &&
    (!Number.isFinite(value) || value <= 0 || (integer && !Number.isSafeInteger(value)))
  ) {
    throw new Error(`${name} must be a positive ${integer ? "safe integer" : "finite number"}`);
  }
}

/** Real executable path. Every B4 automated test injects a controlled fixture spawn. */
const defaultAntigravitySpawn: AntigravitySpawn = (command) => {
  const child = spawnChildProcess(command.executable, command.args, {
    cwd: command.cwd,
    env: command.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return {
    onStdout: (listener) => child.stdout?.on("data", listener),
    onStderr: (listener) => child.stderr?.on("data", listener),
    // `close` waits for stdio EOF, retaining all bounded output before interpretation.
    onExit: (listener) => child.on("close", listener),
    onError: (listener) => child.on("error", listener),
    endStdin: () => child.stdin?.end(command.stdin),
    kill: (signal) => {
      child.kill(signal);
    },
  };
};
