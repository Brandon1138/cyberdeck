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
import type { ProviderId } from "../../domain/provider-registration.js";
import type { UsageReport } from "../../domain/usage.js";
import {
  buildClaudeHeadlessCommand,
  type ClaudeHeadlessCommand,
  type ClaudeHeadlessOptions,
} from "./headless-command.js";
import { ClaudeStreamDecoder, type ClaudeStreamFrame } from "./stream-codec.js";

/** The minimal process surface the adapter needs, so tests can inject B1's fixture. */
export interface ClaudeProcessHandle {
  onStdout(listener: (chunk: Buffer) => void): void;
  onStderr(listener: (chunk: Buffer) => void): void;
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  writeStdin(data: string): void;
  endStdin(): void;
  kill(signal?: NodeJS.Signals): void;
}

export type ClaudeSpawn = (command: ClaudeHeadlessCommand) => ClaudeProcessHandle;

/** Everything Cyberdeck can honestly observe about a finished headless run. */
export interface ClaudeHeadlessOutcome {
  readonly frames: readonly ClaudeStreamFrame[];
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface ClaudeInterpretation {
  result: JobResult;
  /** Present only when the provider actually reported usage; never fabricated as zero. */
  usage?: UsageReport;
}

export type ClaudeResultInterpreter = (outcome: ClaudeHeadlessOutcome) => ClaudeInterpretation;

/**
 * The default interpreter, which refuses to produce a terminal outcome.
 *
 * Turning a finished run into `completed` or `failed` requires reading Claude's `stream-json` frame
 * schema, or ascribing meaning to its exit codes. B1 recorded both as unverified: the frame fields
 * are undocumented in help, and no exit-code contract was established. Guessing either would
 * manufacture provenance the provider never gave, so this fails closed with an explicit capability
 * rejection. Supply an interpreter once the mechanics are verified against a real run.
 */
export const unverifiedClaudeResultInterpreter: ClaudeResultInterpreter = () => ({
  result: {
    outcome: "failed",
    error: {
      code: "DISPATCH_REJECTED",
      message:
        "Claude structured result interpretation is unverified: the stream-json frame schema and " +
        "exit semantics are not established, so no terminal outcome can be derived without " +
        "fabricating provider behaviour",
    },
    artifacts: [],
  },
});

export interface ClaudeJobDispatchAdapterOptions {
  spawn?: ClaudeSpawn;
  interpreter?: ClaudeResultInterpreter;
  headless?: ClaudeHeadlessOptions;
  now?: () => string;
}

interface RunningJob {
  handle: ClaudeProcessHandle;
  settled: boolean;
  /** Set once cancellation is accepted, independently of whether a reason was supplied. */
  cancelled: boolean;
  cancelReason?: string;
}

/**
 * Claude's bounded-job adapter behind A1's frozen {@link JobDispatchAdapter} port.
 *
 * One `dispatch` acknowledges one accepted job and starts one headless process. Completion is
 * asynchronous and arrives exactly once per job as a validated {@link JobReport}. No provider-native
 * frame ever crosses the port: stdout is decoded internally and only a neutral result leaves.
 */
export class ClaudeJobDispatchAdapter implements JobDispatchAdapter {
  readonly provider: ProviderId = "claude";

  private readonly running = new Map<string, RunningJob>();
  private readonly seen = new Set<string>();
  private readonly listeners = new Set<(report: JobReport) => void>();
  private readonly spawn: ClaudeSpawn;
  private readonly interpret: ClaudeResultInterpreter;

  constructor(private readonly options: ClaudeJobDispatchAdapterOptions = {}) {
    this.spawn = options.spawn ?? defaultClaudeSpawn;
    this.interpret = options.interpreter ?? unverifiedClaudeResultInterpreter;
  }

  async dispatch(request: DispatchRequest): Promise<DispatchAccepted> {
    if (this.seen.has(request.jobId)) {
      throw new Error(`Job ${request.jobId} was already dispatched`);
    }

    // Command construction runs the launch-safety gate, so an omitted model throws here before
    // anything is spawned. Delegated Fable authorization is checked before dispatch.
    const command = buildClaudeHeadlessCommand(request.request, this.options.headless ?? {});

    this.seen.add(request.jobId);
    const handle = this.spawn(command);
    const entry: RunningJob = { handle, settled: false, cancelled: false };
    this.running.set(request.jobId, entry);

    const decoder = new ClaudeStreamDecoder();
    const frames: ClaudeStreamFrame[] = [];
    let stderr = "";

    handle.onStdout((chunk) => {
      frames.push(...decoder.push(chunk));
    });
    handle.onStderr((chunk) => {
      stderr += chunk.toString("utf8");
    });
    handle.onExit((code, signal) => {
      frames.push(...decoder.flush());
      this.running.delete(request.jobId);
      if (entry.settled) return;
      entry.settled = true;

      if (entry.cancelled) {
        // Cancellation is Cyberdeck's own fact and needs no provider interpretation.
        this.emit(request, {
          result: {
            outcome: "cancelled",
            ...(entry.cancelReason !== undefined ? { reason: entry.cancelReason } : {}),
          },
        });
        return;
      }

      this.emit(
        request,
        this.interpret({ frames, stderr, exitCode: code, signal }),
      );
    });

    handle.writeStdin(command.stdin);
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

    // Mark before signalling so the exit handler cannot reinterpret a cancelled run.
    entry.cancelled = true;
    if (request.reason !== undefined) entry.cancelReason = request.reason;
    entry.handle.kill("SIGTERM");

    return CancellationResultSchema.parse({ accepted: true, jobId: request.jobId });
  }

  onReport(listener: (report: JobReport) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(request: DispatchRequest, interpretation: ClaudeInterpretation): void {
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

/** Spawns the real `claude` executable with piped stdio. Never used by this slice's tests. */
const defaultClaudeSpawn: ClaudeSpawn = (command) => {
  const child = spawnChildProcess(command.executable, command.args, {
    cwd: command.cwd,
    env: command.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  return {
    onStdout: (listener) => {
      child.stdout?.on("data", listener);
    },
    onStderr: (listener) => {
      child.stderr?.on("data", listener);
    },
    onExit: (listener) => {
      child.on("exit", listener);
    },
    writeStdin: (data) => {
      child.stdin?.write(data);
    },
    endStdin: () => {
      child.stdin?.end();
    },
    kill: (signal) => {
      child.kill(signal);
    },
  };
};
