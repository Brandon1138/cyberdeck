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
  buildCursorHeadlessCommand,
  type CursorCommand,
  type CursorHeadlessOptions,
} from "./commands.js";
import { CursorStreamDecoder, type CursorStreamFrame } from "./stream-codec.js";

export const CURSOR_PROVIDER_DESCRIPTOR = {
  id: "cursor",
  displayName: "Cursor Agent",
} as const satisfies ProviderDescriptor;

export interface CursorProcessHandle {
  onStdout(listener: (chunk: Buffer) => void): void;
  onStderr(listener: (chunk: Buffer) => void): void;
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  onError(listener: (error: Error) => void): void;
  endStdin(): void;
  kill(signal?: NodeJS.Signals): void;
}

export type CursorSpawn = (command: CursorCommand) => CursorProcessHandle;

export interface CursorHeadlessOutcome {
  readonly frames: readonly CursorStreamFrame[];
  readonly stderr: string;
  readonly exitCode: 0;
}

export interface CursorInterpretation {
  result: JobResult;
  usage?: UsageReport;
}

export type CursorResultInterpreter = (outcome: CursorHeadlessOutcome) => CursorInterpretation;

export const unverifiedCursorResultInterpreter: CursorResultInterpreter = () => ({
  result: {
    outcome: "failed",
    error: {
      code: "DISPATCH_REJECTED",
      message:
        "Cursor structured result interpretation is live-unverified: stream-json is documented, " +
        "but its frame schema and terminal-result fields have not been established",
    },
    artifacts: [],
  },
});

export interface CursorJobDispatchAdapterOptions {
  spawn?: CursorSpawn;
  interpreter?: CursorResultInterpreter;
  headless?: CursorHeadlessOptions;
  timeoutMs?: number;
  now?: () => string;
}

interface RunningJob {
  handle: CursorProcessHandle;
  settled: boolean;
  cancelled: boolean;
  timedOut: boolean;
  cancelReason?: string;
  timer?: NodeJS.Timeout;
}

/** Fixture-proven bounded adapter behind A1's provider-neutral dispatch port. */
export class CursorJobDispatchAdapter implements JobDispatchAdapter {
  readonly provider: ProviderId = "cursor";
  private readonly running = new Map<string, RunningJob>();
  private readonly seen = new Set<string>();
  private readonly listeners = new Set<(report: JobReport) => void>();
  private readonly spawn: CursorSpawn;
  private readonly interpret: CursorResultInterpreter;

  constructor(private readonly options: CursorJobDispatchAdapterOptions = {}) {
    if (
      options.timeoutMs !== undefined &&
      (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
    ) {
      throw new Error("timeoutMs must be a positive finite number");
    }
    this.spawn = options.spawn ?? defaultCursorSpawn;
    this.interpret = options.interpreter ?? unverifiedCursorResultInterpreter;
  }

  get activeJobCount(): number {
    return this.running.size;
  }

  async dispatch(request: DispatchRequest): Promise<DispatchAccepted> {
    if (this.seen.has(request.jobId)) {
      throw new Error(`Job ${request.jobId} was already dispatched`);
    }
    const command = buildCursorHeadlessCommand(request.request, this.options.headless);
    this.seen.add(request.jobId);
    const handle = this.spawn(command);
    const entry: RunningJob = {
      handle,
      settled: false,
      cancelled: false,
      timedOut: false,
    };
    this.running.set(request.jobId, entry);

    const decoder = new CursorStreamDecoder();
    const frames: CursorStreamFrame[] = [];
    let stderr = "";
    handle.onStdout((chunk) => frames.push(...decoder.push(chunk)));
    handle.onStderr((chunk) => {
      stderr += chunk.toString("utf8");
    });
    handle.onError((error) => {
      this.finish(request, entry, {
        result: failedResult(`Cursor process error: ${error.message}`),
      });
    });
    handle.onExit((code, signal) => {
      frames.push(...decoder.flush());
      if (entry.cancelled) {
        this.finish(request, entry, {
          result: {
            outcome: "cancelled",
            ...(entry.cancelReason !== undefined ? { reason: entry.cancelReason } : {}),
          },
        });
        return;
      }
      if (entry.timedOut) {
        this.finish(request, entry, { result: { outcome: "timedOut" } });
        return;
      }
      if (signal !== null) {
        this.finish(request, entry, {
          result: failedResult(`Cursor process exited from signal ${signal}`),
        });
        return;
      }
      if (code !== 0) {
        const detail = stderr.trim() === "" ? "" : `: ${stderr.trim()}`;
        this.finish(request, entry, {
          result: failedResult(`Cursor process exited with code ${String(code)}${detail}`),
        });
        return;
      }
      if (frames.some((frame) => frame.kind === "malformed")) {
        this.finish(request, entry, {
          result: failedResult("Cursor stream-json output contained a malformed or truncated frame"),
        });
        return;
      }
      this.finish(request, entry, this.interpret({ frames, stderr, exitCode: 0 }));
    });

    if (this.options.timeoutMs !== undefined) {
      entry.timer = setTimeout(() => {
        if (entry.settled) return;
        entry.timedOut = true;
        entry.handle.kill("SIGTERM");
      }, this.options.timeoutMs);
      entry.timer.unref();
    }
    handle.endStdin();

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
    entry.cancelled = true;
    if (request.reason !== undefined) entry.cancelReason = request.reason;
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    entry.handle.kill("SIGTERM");
    return CancellationResultSchema.parse({ accepted: true, jobId: request.jobId });
  }

  onReport(listener: (report: JobReport) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private finish(
    request: DispatchRequest,
    entry: RunningJob,
    interpretation: CursorInterpretation,
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

function failedResult(message: string): JobResult {
  return {
    outcome: "failed",
    error: { code: "DISPATCH_REJECTED", message },
    artifacts: [],
  };
}

/** Real executable path. Every automated test injects a fixture spawn instead. */
const defaultCursorSpawn: CursorSpawn = (command) => {
  const child = spawnChildProcess(command.executable, command.args, {
    cwd: command.cwd,
    env: command.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return {
    onStdout: (listener) => child.stdout?.on("data", listener),
    onStderr: (listener) => child.stderr?.on("data", listener),
    onExit: (listener) => child.on("exit", listener),
    onError: (listener) => child.on("error", listener),
    endStdin: () => child.stdin?.end(),
    kill: (signal) => {
      child.kill(signal);
    },
  };
};
