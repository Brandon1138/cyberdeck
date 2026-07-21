import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { DispatchRequest } from "../../src/domain/dispatch.js";
import type { JobReport } from "../../src/domain/job.js";
import {
  AppServerJobDispatchAdapter,
  type AppServerProcessHandle,
  type AppServerSpawn,
} from "../../src/app-server/dispatch-adapter.js";
import { AppServerJsonDecoder } from "../../src/app-server/protocol.js";

const NOW = "2026-07-21T12:00:00.000Z";

function request(overrides: Record<string, unknown> = {}): DispatchRequest {
  return {
    schemaVersion: 1,
    jobId: crypto.randomUUID(),
    correlationId: crypto.randomUUID(),
    request: {
      schemaVersion: 1,
      provider: "codex",
      cwd: "/tmp/repo",
      sandbox: "read-only",
      instruction: "inspect the fake repository",
      model: "gpt-fixture",
      ...overrides,
    },
  } as DispatchRequest;
}

class FakeProcess extends EventEmitter implements AppServerProcessHandle {
  readonly writes: Array<Record<string, unknown>> = [];
  readonly kills: NodeJS.Signals[] = [];
  stdinEnded = false;

  onStdout(listener: (chunk: Buffer) => void): void { this.on("stdout", listener); }
  onStderr(listener: (chunk: Buffer) => void): void { this.on("stderr", listener); }
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.on("exit", listener);
  }
  onError(listener: (error: Error) => void): void { this.on("processError", listener); }
  write(data: string): void {
    for (const line of data.trim().split("\n")) this.writes.push(JSON.parse(line));
  }
  endStdin(): void { this.stdinEnded = true; }
  kill(signal: NodeJS.Signals = "SIGTERM"): void { this.kills.push(signal); }
  stdout(value: unknown, splitAt?: number): void {
    const frame = `${JSON.stringify(value)}\n`;
    if (splitAt === undefined) this.emit("stdout", Buffer.from(frame));
    else {
      this.emit("stdout", Buffer.from(frame.slice(0, splitAt)));
      this.emit("stdout", Buffer.from(frame.slice(splitAt)));
    }
  }
  raw(value: string): void { this.emit("stdout", Buffer.from(value)); }
  stderr(value: string): void { this.emit("stderr", Buffer.from(value)); }
  exit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.emit("exit", code, signal);
  }
  fail(error: Error): void { this.emit("processError", error); }
  take(method: string): Record<string, unknown> {
    const frame = this.writes.find((candidate) => candidate.method === method);
    if (frame === undefined) throw new Error(`No ${method} request`);
    return frame;
  }
}

function nextReport(adapter: AppServerJobDispatchAdapter): Promise<JobReport> {
  return new Promise((resolve) => {
    const unsubscribe = adapter.onReport((report) => {
      unsubscribe();
      resolve(report);
    });
  });
}

async function begin(adapter: AppServerJobDispatchAdapter, process: FakeProcess, input = request()) {
  const dispatched = adapter.dispatch(input);
  await vi.waitFor(() => expect(process.take("initialize")).toBeDefined());
  const initialize = process.take("initialize");
  process.stdout({
    jsonrpc: "2.0",
    id: initialize.id,
    result: {
      userAgent: "codex-cli 0.144.6",
      codexHome: "/tmp/fake-codex-home",
      platformFamily: "unix",
      platformOs: "macos",
    },
  });
  await vi.waitFor(() => expect(process.take("thread/start")).toBeDefined());
  const thread = process.take("thread/start");
  process.stdout({
    jsonrpc: "2.0",
    id: thread.id,
    result: {
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      cwd: input.request.cwd,
      model: input.request.model ?? "fixture-default",
      modelProvider: "openai",
      sandbox: { type: input.request.sandbox === "read-only" ? "readOnly" : "workspaceWrite" },
      thread: { id: "thread-1" },
    },
  });
  await vi.waitFor(() => expect(process.take("turn/start")).toBeDefined());
  const turn = process.take("turn/start");
  process.stdout({ jsonrpc: "2.0", id: turn.id, result: { turn: { id: "turn-1" } } });
  await dispatched;
  return input;
}

describe("AppServerJsonDecoder", () => {
  it("reassembles partial frames and rejects malformed or oversized frames", () => {
    const decoder = new AppServerJsonDecoder({ maxFrameBytes: 32 });
    expect(decoder.push(Buffer.from('{"jsonrpc":"2.0"'))).toEqual([]);
    expect(decoder.push(Buffer.from(',"id":1}\n'))).toEqual([{ jsonrpc: "2.0", id: 1 }]);
    expect(() => decoder.push(Buffer.from("not-json\n"))).toThrow(/malformed/i);
    expect(() => new AppServerJsonDecoder().push(Buffer.from('{"id":1}\n'))).toThrow(
      /JSON-RPC 2\.0/i,
    );
    expect(() => new AppServerJsonDecoder({ maxFrameBytes: 4 }).push(Buffer.from("12345"))).toThrow(
      /bounded/i,
    );
  });
});

describe("AppServerJobDispatchAdapter", () => {
  it("handshakes, validates settings, correlates responses, maps notifications and usage", async () => {
    const process = new FakeProcess();
    const spawn = vi.fn<AppServerSpawn>(() => process);
    const adapter = new AppServerJobDispatchAdapter({ spawn, now: () => NOW });
    const progress: unknown[] = [];
    adapter.onProgress((event) => progress.push(event));
    const report = nextReport(adapter);
    const input = await begin(adapter, process);

    expect(spawn).toHaveBeenCalledWith({
      executable: "codex",
      args: ["app-server", "--stdio", "--strict-config"],
      cwd: "/tmp/repo",
      env: expect.any(Object),
    });
    expect(process.writes[1]).toMatchObject({ method: "initialized" });
    expect(process.take("thread/start")).toMatchObject({
      params: {
        cwd: "/tmp/repo",
        sandbox: "read-only",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        ephemeral: true,
        model: "gpt-fixture",
      },
    });
    expect(process.take("turn/start")).toMatchObject({
      params: {
        threadId: "thread-1",
        input: [{ type: "text", text: "inspect the fake repository" }],
      },
    });
    process.stdout({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        completedAtMs: 1,
        item: { id: "item-1", type: "agentMessage", text: "fixture result" },
      },
    });
    process.stdout({
      jsonrpc: "2.0",
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        tokenUsage: {
          last: { inputTokens: 3, outputTokens: 5, totalTokens: 8 },
          total: { inputTokens: 3, outputTokens: 5, totalTokens: 8 },
        },
      },
    });
    process.stdout({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } },
    });

    expect(await report).toMatchObject({
      jobId: input.jobId,
      correlationId: input.correlationId,
      result: { outcome: "completed", summary: "fixture result", artifacts: [] },
      usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 },
    });
    expect(progress).toHaveLength(2);
    expect(process.stdinEnded).toBe(true);
    expect(process.kills).toContain("SIGTERM");
  });

  it("fails closed on a server-version mismatch before submitting a thread", async () => {
    const process = new FakeProcess();
    const adapter = new AppServerJobDispatchAdapter({ spawn: () => process, now: () => NOW });
    const dispatched = adapter.dispatch(request());
    await vi.waitFor(() => expect(process.take("initialize")).toBeDefined());
    const initialize = process.take("initialize");
    process.stdout({
      jsonrpc: "2.0",
      id: initialize.id,
      result: {
        userAgent: "codex-cli 0.145.0",
        codexHome: "/tmp/home",
        platformFamily: "unix",
        platformOs: "macos",
      },
    });
    await expect(dispatched).rejects.toThrow(/incompatible/i);
    expect(process.writes.some((frame) => frame.method === "thread/start")).toBe(false);
  });

  it("keeps an omitted model and opaque role out of protocol settings and emits no bypass flags", async () => {
    const process = new FakeProcess();
    const adapter = new AppServerJobDispatchAdapter({ spawn: () => process, now: () => NOW });
    const report = nextReport(adapter);
    await begin(adapter, process, request({ model: undefined, role: "reviewer" }));
    const thread = process.take("thread/start");
    expect(thread.params).not.toHaveProperty("model");
    expect(JSON.stringify(process.writes)).not.toContain("reviewer");
    for (const forbidden of ["danger-full-access", "never", "auto_review", "yolo", "force", "bypass"]) {
      expect(JSON.stringify(process.writes)).not.toContain(forbidden);
    }
    process.stdout({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } } });
    await report;
  });

  it("correlates out-of-order responses and tolerates notifications between them", async () => {
    const process = new FakeProcess();
    const adapter = new AppServerJobDispatchAdapter({ spawn: () => process, now: () => NOW });
    const progress: unknown[] = [];
    adapter.onProgress((event) => progress.push(event));
    const input = await begin(adapter, process);
    const report = nextReport(adapter);
    process.stdout({ jsonrpc: "2.0", method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress", items: [] } } });
    process.stdout({ jsonrpc: "2.0", id: 999, result: { ignored: true } });
    process.stdout({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } } });
    expect((await report).jobId).toBe(input.jobId);
    expect(progress).not.toHaveLength(0);
  });

  it.each([
    ["malformed frame", (process: FakeProcess) => process.raw("not-json\n")],
    ["EOF", (process: FakeProcess) => process.exit(0, null)],
    ["non-zero exit", (process: FakeProcess) => { process.stderr("fixture boom"); process.exit(3, null); }],
    ["process error", (process: FakeProcess) => process.fail(new Error("spawn failed"))],
  ])("reports one diagnostic failure on %s", async (_name, breakProcess) => {
    const process = new FakeProcess();
    const adapter = new AppServerJobDispatchAdapter({ spawn: () => process, now: () => NOW });
    const report = nextReport(adapter);
    await begin(adapter, process);
    breakProcess(process);
    const settled = await report;
    expect(settled.result.outcome).toBe("failed");
    if ((_name === "EOF" || _name === "non-zero exit" || _name === "process error") && settled.result.outcome === "failed") {
      expect(settled.result.error.code).toBe("RUNTIME_INTERRUPTED");
    }
    expect(adapter.activeJobCount).toBe(0);
    process.exit(1, null);
  });

  it("cancels with turn/interrupt, times out, and suppresses duplicate completion", async () => {
    vi.useFakeTimers();
    const cancelProcess = new FakeProcess();
    const cancelAdapter = new AppServerJobDispatchAdapter({ spawn: () => cancelProcess, now: () => NOW });
    let cancellationReports = 0;
    cancelAdapter.onReport(() => { cancellationReports += 1; });
    const cancelInput = await begin(cancelAdapter, cancelProcess);
    const cancelReport = nextReport(cancelAdapter);
    await expect(cancelAdapter.cancel({ schemaVersion: 1, jobId: cancelInput.jobId, correlationId: cancelInput.correlationId, reason: "operator" })).resolves.toMatchObject({ accepted: true });
    expect(cancelProcess.take("turn/interrupt")).toMatchObject({ params: { threadId: "thread-1", turnId: "turn-1" } });
    cancelProcess.stdout({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "interrupted", items: [] } } });
    expect((await cancelReport).result).toEqual({ outcome: "cancelled", reason: "operator" });
    cancelProcess.stdout({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } } });
    expect(cancellationReports).toBe(1);

    const timeoutProcess = new FakeProcess();
    const timeoutAdapter = new AppServerJobDispatchAdapter({ spawn: () => timeoutProcess, now: () => NOW, timeoutMs: 25 });
    const timeoutReport = nextReport(timeoutAdapter);
    await begin(timeoutAdapter, timeoutProcess);
    await vi.advanceTimersByTimeAsync(25);
    expect((await timeoutReport).result.outcome).toBe("timedOut");
    expect(timeoutProcess.kills).toContain("SIGTERM");
    vi.useRealTimers();
  });

  it("bounds stdout and stderr and rejects duplicate dispatch before spawning", async () => {
    const process = new FakeProcess();
    const spawn = vi.fn<AppServerSpawn>(() => process);
    const adapter = new AppServerJobDispatchAdapter({ spawn, now: () => NOW, maxOutputBytes: 64 });
    const input = request();
    const dispatching = adapter.dispatch(input);
    await expect(adapter.dispatch(input)).rejects.toThrow(/already dispatched/i);
    expect(spawn).toHaveBeenCalledTimes(1);
    process.stderr("x".repeat(65));
    await expect(dispatching).rejects.toThrow(/bounded/i);
  });
});
