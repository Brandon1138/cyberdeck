import { spawn as spawnChildProcess } from "node:child_process";
import { isAbsolute } from "node:path";
import { CONTROL_PLANE_SCHEMA_VERSION } from "../domain/control-plane.js";
import {
  CancellationResultSchema,
  DispatchAcceptedSchema,
  DispatchRequestSchema,
  type CancellationRequest,
  type CancellationResult,
  type DispatchAccepted,
  type DispatchRequest,
  type JobDispatchAdapter,
} from "../domain/dispatch.js";
import { JobReportSchema, type JobReport, type JobResult } from "../domain/job.js";
import type { ProviderId } from "../domain/provider-registration.js";
import type { UsageReport } from "../domain/usage.js";
import type { LeaseGrant, WorktreeLeaseManager } from "../control-plane/worktree-lease-manager.js";
import type { ArtifactStore } from "../persistence/artifact-store.js";
import {
  AppServerJsonDecoder,
  AppServerProtocolError,
  requireObject,
  requireString,
} from "./protocol.js";

export const APP_SERVER_PROTOCOL_FAMILY = "v2";
export const APP_SERVER_COMPATIBLE_CODEX_MINOR = "0.144";

export interface AppServerCommand {
  executable: "codex";
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface AppServerProcessHandle {
  onStdout(listener: (chunk: Buffer) => void): void;
  onStderr(listener: (chunk: Buffer) => void): void;
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  onError(listener: (error: Error) => void): void;
  write(data: string): void;
  endStdin(): void;
  kill(signal?: NodeJS.Signals): void;
}

export type AppServerSpawn = (command: AppServerCommand) => AppServerProcessHandle;

export interface AppServerProgress {
  jobId: string;
  correlationId: string;
  method: "turn/started" | "item/completed" | "thread/tokenUsage/updated";
  occurredAt: string;
}

export interface AppServerJobDispatchAdapterOptions {
  spawn?: AppServerSpawn;
  now?: () => string;
  timeoutMs?: number;
  requestTimeoutMs?: number;
  maxFrameBytes?: number;
  maxOutputBytes?: number;
  compatibleCodexMinor?: string;
  leaseManager?: WorktreeLeaseManager;
  /** Persist the validated terminal agent message as a job artifact when the runtime supplies one. */
  artifactStore?: ArtifactStore;
  leaseTtlMs?: number;
}

interface PendingRequest {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface RunningJob {
  request: DispatchRequest;
  process: AppServerProcessHandle;
  decoder: AppServerJsonDecoder;
  pending: Map<number, PendingRequest>;
  nextRequestId: number;
  stdoutBytes: number;
  stderr: string;
  stderrBytes: number;
  threadId?: string;
  turnId?: string;
  summaries: string[];
  usage?: UsageReport;
  accepted: boolean;
  settled: boolean;
  cancelled: boolean;
  timedOut: boolean;
  cancelReason?: string;
  timer?: NodeJS.Timeout;
  leaseRenewTimer?: NodeJS.Timeout;
  cancellationTimer?: NodeJS.Timeout;
  lease?: LeaseGrant;
  leaseReleased: boolean;
}

/**
 * One supervised stdio App Server process per bounded Codex job. The adapter is selected explicitly
 * as the `codex` adapter and contains no provider fallback or terminal-mode fallback.
 */
export class AppServerJobDispatchAdapter implements JobDispatchAdapter {
  readonly provider: ProviderId = "codex";
  private readonly running = new Map<string, RunningJob>();
  private readonly seen = new Set<string>();
  private readonly listeners = new Set<(report: JobReport) => void>();
  private readonly progressListeners = new Set<(progress: AppServerProgress) => void>();
  private readonly spawn: AppServerSpawn;

  constructor(private readonly options: AppServerJobDispatchAdapterOptions = {}) {
    for (const [name, value] of [
      ["timeoutMs", options.timeoutMs],
      ["requestTimeoutMs", options.requestTimeoutMs],
      ["maxFrameBytes", options.maxFrameBytes],
      ["maxOutputBytes", options.maxOutputBytes],
      ["leaseTtlMs", options.leaseTtlMs],
    ] as const) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
        throw new Error(`${name} must be a positive safe integer`);
      }
    }
    this.spawn = options.spawn ?? defaultAppServerSpawn;
  }

  get activeJobCount(): number { return this.running.size; }

  async dispatch(input: DispatchRequest): Promise<DispatchAccepted> {
    const request = DispatchRequestSchema.parse(input);
    if (request.request.provider !== "codex") throw new Error("App Server transport accepts only explicit provider codex");
    if (!isAbsolute(request.request.cwd)) throw new Error("App Server cwd must be absolute");
    if (this.seen.has(request.jobId)) throw new Error(`Job ${request.jobId} was already dispatched`);
    this.seen.add(request.jobId);

    let lease: LeaseGrant | undefined;
    if (request.request.sandbox === "workspace-write" && this.options.leaseManager !== undefined) {
      lease = await this.options.leaseManager.acquire({
        repositoryPath: request.request.cwd,
        worktreePath: request.request.cwd,
        access: "workspace-write",
        holderJobId: request.jobId,
        ...(this.options.leaseTtlMs !== undefined ? { ttlMs: this.options.leaseTtlMs } : {}),
      });
    }

    const command = buildAppServerCommand(request);
    let process: AppServerProcessHandle;
    try {
      process = this.spawn(command);
    } catch (error) {
      if (lease !== undefined) await this.options.leaseManager?.release(lease);
      throw error;
    }
    const entry: RunningJob = {
      request,
      process,
      decoder: new AppServerJsonDecoder(
        this.options.maxFrameBytes === undefined
          ? {}
          : { maxFrameBytes: this.options.maxFrameBytes },
      ),
      pending: new Map(),
      nextRequestId: 1,
      stdoutBytes: 0,
      stderr: "",
      stderrBytes: 0,
      summaries: [],
      accepted: false,
      settled: false,
      cancelled: false,
      timedOut: false,
      ...(lease !== undefined ? { lease } : {}),
      leaseReleased: false,
    };
    this.running.set(request.jobId, entry);
    this.attach(entry);
    if (entry.lease !== undefined && this.options.leaseManager !== undefined) {
      const ttlMs = this.options.leaseTtlMs ?? 30_000;
      entry.leaseRenewTimer = setInterval(() => {
        if (entry.settled || entry.lease === undefined) return;
        void this.options.leaseManager
          ?.renew(entry.lease, ttlMs)
          .then((renewed) => { entry.lease = renewed; })
          .catch((error: unknown) => {
            this.fatal(
              entry,
              new Error(`App Server write lease heartbeat failed: ${error instanceof Error ? error.message : "unknown error"}`),
              true,
            );
          });
      }, Math.max(1, Math.floor(ttlMs / 2)));
      entry.leaseRenewTimer.unref();
    }

    try {
      const initialize = requireObject(
        await this.rpc(entry, "initialize", {
          clientInfo: { name: "cyberdeck", title: "Cyberdeck", version: "0.1.0" },
          capabilities: { experimentalApi: false },
        }),
        "initialize result",
      );
      this.validateInitialize(initialize);
      this.notify(entry, "initialized");

      const thread = requireObject(
        await this.rpc(entry, "thread/start", {
          cwd: request.request.cwd,
          sandbox: request.request.sandbox,
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          ephemeral: true,
          ...(request.request.model !== undefined ? { model: request.request.model } : {}),
        }),
        "thread/start result",
      );
      this.validateThreadSettings(thread, request);
      entry.threadId = requireString(requireObject(thread.thread, "thread/start thread").id, "thread id");

      const turn = requireObject(
        await this.rpc(entry, "turn/start", {
          threadId: entry.threadId,
          input: [{ type: "text", text: request.request.instruction }],
          cwd: request.request.cwd,
          approvalPolicy: "on-request",
        }),
        "turn/start result",
      );
      entry.turnId = requireString(requireObject(turn.turn, "turn/start turn").id, "turn id");
      entry.accepted = true;
      if (this.options.timeoutMs !== undefined) {
        entry.timer = setTimeout(() => {
          if (entry.settled) return;
          entry.timedOut = true;
          this.interrupt(entry);
          void this.finish(entry, { outcome: "timedOut" });
        }, this.options.timeoutMs);
        entry.timer.unref();
      }
      return DispatchAcceptedSchema.parse({
        schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
        jobId: request.jobId,
        acceptedAt: this.now(),
      });
    } catch (error) {
      await this.cleanup(entry);
      throw error;
    }
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
    this.interrupt(entry);
    entry.cancellationTimer = setTimeout(() => {
      if (entry.settled) return;
      entry.process.kill("SIGTERM");
      void this.finish(entry, {
        outcome: "cancelled",
        ...(entry.cancelReason !== undefined ? { reason: entry.cancelReason } : {}),
      });
    }, 1_000);
    entry.cancellationTimer.unref();
    return CancellationResultSchema.parse({ accepted: true, jobId: request.jobId });
  }

  onReport(listener: (report: JobReport) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onProgress(listener: (progress: AppServerProgress) => void): () => void {
    this.progressListeners.add(listener);
    return () => this.progressListeners.delete(listener);
  }

  private attach(entry: RunningJob): void {
    entry.process.onStdout((chunk) => {
      if (entry.settled) return;
      entry.stdoutBytes += chunk.length;
      if (entry.stdoutBytes > (this.options.maxOutputBytes ?? 1024 * 1024)) {
        this.fatal(entry, new AppServerProtocolError("OUTPUT_LIMIT_EXCEEDED", "App Server stdout exceeded the bounded output limit"));
        return;
      }
      try {
        for (const frame of entry.decoder.push(chunk)) this.frame(entry, frame);
      } catch (error) {
        this.fatal(entry, error instanceof Error ? error : new Error("App Server decode failed"));
      }
    });
    entry.process.onStderr((chunk) => {
      if (entry.settled) return;
      entry.stderrBytes += chunk.length;
      if (entry.stderrBytes > (this.options.maxOutputBytes ?? 1024 * 1024)) {
        this.fatal(entry, new AppServerProtocolError("OUTPUT_LIMIT_EXCEEDED", "App Server stderr exceeded the bounded output limit"));
        return;
      }
      entry.stderr += chunk.toString("utf8");
    });
    entry.process.onError((error) =>
      this.fatal(entry, new Error(`App Server process error: ${error.message}`), true),
    );
    entry.process.onExit((code, signal) => {
      if (entry.settled) return;
      try { entry.decoder.flush(); } catch (error) {
        this.fatal(entry, error instanceof Error ? error : new Error("App Server partial frame"), true);
        return;
      }
      const suffix = entry.stderr.trim() === "" ? "" : `; stderr: ${entry.stderr.trim()}`;
      this.fatal(
        entry,
        new AppServerProtocolError(
          "DISCONNECTED",
          `App Server disconnected before terminal completion (exit=${String(code)}, signal=${String(signal)})${suffix}`,
        ),
        true,
      );
    });
  }

  private frame(entry: RunningJob, frame: Record<string, unknown>): void {
    if (typeof frame.id === "number" && ("result" in frame || "error" in frame)) {
      const pending = entry.pending.get(frame.id);
      if (pending === undefined) return;
      entry.pending.delete(frame.id);
      clearTimeout(pending.timer);
      if (frame.error !== undefined) {
        const error = requireObject(frame.error, `${pending.method} error`);
        pending.reject(new Error(`App Server ${pending.method} failed: ${String(error.message ?? "unknown error")}`));
      } else {
        pending.resolve(frame.result);
      }
      return;
    }
    if (typeof frame.method === "string") this.notification(entry, frame.method, frame.params);
  }

  private notification(entry: RunningJob, method: string, rawParams: unknown): void {
    if (entry.settled) return;
    if (method === "turn/started") {
      this.progress(entry, method);
      return;
    }
    if (method === "item/completed") {
      const params = requireObject(rawParams, "item/completed params");
      const item = requireObject(params.item, "item/completed item");
      if (item.type === "agentMessage" && typeof item.text === "string") entry.summaries.push(item.text);
      this.progress(entry, method);
      return;
    }
    if (method === "thread/tokenUsage/updated") {
      const params = requireObject(rawParams, "token usage params");
      const usage = requireObject(requireObject(params.tokenUsage, "tokenUsage").last, "last token usage");
      const mapped: UsageReport = {
        schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
        ...(isNonnegativeInteger(usage.inputTokens) ? { inputTokens: usage.inputTokens } : {}),
        ...(isNonnegativeInteger(usage.outputTokens) ? { outputTokens: usage.outputTokens } : {}),
        ...(isNonnegativeInteger(usage.totalTokens) ? { totalTokens: usage.totalTokens } : {}),
      };
      if (Object.keys(mapped).length > 1) entry.usage = mapped;
      this.progress(entry, method);
      return;
    }
    if (method !== "turn/completed") return;
    const params = requireObject(rawParams, "turn/completed params");
    const turn = requireObject(params.turn, "turn/completed turn");
    const turnId = requireString(turn.id, "completed turn id");
    if (entry.turnId !== undefined && turnId !== entry.turnId) return;
    const status = requireString(turn.status, "completed turn status");
    if (status === "completed") {
      void this.finish(entry, {
        outcome: "completed",
        ...(entry.summaries.length > 0 ? { summary: entry.summaries.join("\n") } : {}),
        artifacts: [],
      });
    } else if (status === "interrupted" && entry.cancelled) {
      void this.finish(entry, {
        outcome: "cancelled",
        ...(entry.cancelReason !== undefined ? { reason: entry.cancelReason } : {}),
      });
    } else {
      const detail = typeof turn.error === "object" && turn.error !== null && "message" in turn.error
        ? String((turn.error as { message?: unknown }).message)
        : `turn completed with status ${status}`;
      void this.finish(entry, failed(`App Server ${detail}; reconciliation may be required`));
    }
  }

  private rpc(entry: RunningJob, method: string, params: Record<string, unknown>): Promise<unknown> {
    if (entry.settled) return Promise.reject(new Error("App Server job is already settled"));
    const id = entry.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        entry.pending.delete(id);
        reject(new AppServerProtocolError("REQUEST_TIMEOUT", `App Server ${method} request timed out`));
      }, this.options.requestTimeoutMs ?? 5_000);
      timer.unref();
      entry.pending.set(id, { method, resolve, reject, timer });
      entry.process.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  private notify(entry: RunningJob, method: string): void {
    entry.process.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  }

  private interrupt(entry: RunningJob): void {
    if (entry.threadId !== undefined && entry.turnId !== undefined && !entry.settled) {
      void this.rpc(entry, "turn/interrupt", { threadId: entry.threadId, turnId: entry.turnId }).catch(() => undefined);
    }
  }

  private validateInitialize(result: Record<string, unknown>): void {
    const userAgent = requireString(result.userAgent, "initialize userAgent");
    requireString(result.codexHome, "initialize codexHome");
    requireString(result.platformFamily, "initialize platformFamily");
    requireString(result.platformOs, "initialize platformOs");
    const expected = this.options.compatibleCodexMinor ?? APP_SERVER_COMPATIBLE_CODEX_MINOR;
    if (!userAgent.includes(expected)) {
      throw new AppServerProtocolError(
        "PROTOCOL_MISMATCH",
        `Incompatible App Server user agent ${userAgent}; Cyberdeck is pinned to v2 schemas from Codex ${expected}.x`,
      );
    }
  }

  private validateThreadSettings(result: Record<string, unknown>, request: DispatchRequest): void {
    if (requireString(result.cwd, "thread/start cwd") !== request.request.cwd) {
      throw new AppServerProtocolError("PROTOCOL_MISMATCH", "App Server returned a different cwd");
    }
    if (result.approvalPolicy !== "on-request" || result.approvalsReviewer !== "user") {
      throw new AppServerProtocolError(
        "PROTOCOL_MISMATCH",
        "App Server did not retain user-routed on-request approvals",
      );
    }
    if (
      request.request.model !== undefined &&
      requireString(result.model, "thread/start model") !== request.request.model
    ) {
      throw new AppServerProtocolError("PROTOCOL_MISMATCH", "App Server returned a different explicit model");
    }
    const sandbox = requireObject(result.sandbox, "thread/start sandbox");
    const expectedSandbox = request.request.sandbox === "read-only" ? "readOnly" : "workspaceWrite";
    if (sandbox.type !== expectedSandbox) {
      throw new AppServerProtocolError(
        "PROTOCOL_MISMATCH",
        `App Server returned sandbox ${String(sandbox.type)} instead of ${expectedSandbox}`,
      );
    }
  }

  private progress(entry: RunningJob, method: AppServerProgress["method"]): void {
    const progress: AppServerProgress = {
      jobId: entry.request.jobId,
      correlationId: entry.request.correlationId,
      method,
      occurredAt: this.now(),
    };
    for (const listener of [...this.progressListeners]) listener(progress);
  }

  private fatal(entry: RunningJob, error: Error, runtimeInterrupted = false): void {
    if (entry.settled) return;
    for (const pending of entry.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    entry.pending.clear();
    if (entry.accepted) {
      if (entry.cancelled) {
        void this.finish(entry, {
          outcome: "cancelled",
          ...(entry.cancelReason !== undefined ? { reason: entry.cancelReason } : {}),
        });
        return;
      }
      const message = `${error.message}; correlationId=${entry.request.correlationId}`;
      void this.finish(entry, runtimeInterrupted ? interrupted(message) : failed(message));
    }
  }

  private async finish(entry: RunningJob, result: JobResult): Promise<void> {
    if (entry.settled) return;
    entry.settled = true;
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    if (entry.cancellationTimer !== undefined) clearTimeout(entry.cancellationTimer);
    for (const pending of entry.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("App Server job reached terminal state"));
    }
    entry.pending.clear();
    await this.cleanup(entry);
    let terminalResult = result;
    if (
      result.outcome === "completed" &&
      result.summary !== undefined &&
      this.options.artifactStore !== undefined
    ) {
      try {
        const stored = await this.options.artifactStore.write({
          name: "codex-result.txt",
          logicalKind: "provider-result",
          mediaType: "text/plain",
          content: result.summary,
          producedByJobId: entry.request.jobId,
        });
        terminalResult = { ...result, artifacts: [stored.descriptor] };
      } catch (error) {
        terminalResult = failed(
          `Codex result artifact persistence failed: ${error instanceof Error ? error.message : "unknown error"}; correlationId=${entry.request.correlationId}`,
        );
      }
    }
    const report = JobReportSchema.parse({
      schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
      jobId: entry.request.jobId,
      correlationId: entry.request.correlationId,
      reportedAt: this.now(),
      result: terminalResult,
      ...(entry.usage !== undefined ? { usage: entry.usage } : {}),
    });
    for (const listener of [...this.listeners]) listener(report);
  }

  private async cleanup(entry: RunningJob): Promise<void> {
    if (!entry.settled) entry.settled = true;
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    if (entry.leaseRenewTimer !== undefined) clearInterval(entry.leaseRenewTimer);
    if (entry.cancellationTimer !== undefined) clearTimeout(entry.cancellationTimer);
    for (const pending of entry.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("App Server transport closed"));
    }
    entry.pending.clear();
    entry.process.endStdin();
    entry.process.kill("SIGTERM");
    if (entry.lease !== undefined && !entry.leaseReleased) {
      entry.leaseReleased = true;
      await this.options.leaseManager?.release(entry.lease);
    }
    this.running.delete(entry.request.jobId);
  }

  private now(): string { return this.options.now?.() ?? new Date().toISOString(); }
}

export function buildAppServerCommand(request: DispatchRequest): AppServerCommand {
  return {
    executable: "codex",
    args: ["app-server", "--stdio", "--strict-config"],
    cwd: request.request.cwd,
    env: { ...process.env },
  };
}

function failed(message: string): JobResult {
  return { outcome: "failed", error: { code: "DISPATCH_REJECTED", message }, artifacts: [] };
}

function interrupted(message: string): JobResult {
  return {
    outcome: "failed",
    error: { code: "RUNTIME_INTERRUPTED", message },
    artifacts: [],
  };
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

const defaultAppServerSpawn: AppServerSpawn = (command) => {
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
    write: (data) => { child.stdin?.write(data); },
    endStdin: () => { child.stdin?.end(); },
    kill: (signal) => { child.kill(signal); },
  };
};
