import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { ResourceJobLaunch } from "../../src/orchestration/resource-job-launch.js";
import { resourceJobRecord, type JobDispatchContext } from "../../src/orchestration/resource-job-record.js";
import { ResourceExecutionGate } from "../../src/orchestration/resource-execution-gate.js";
import { ResourceAdmissionService } from "../../src/orchestration/resource-admission-service.js";
import { ResourceReservationStore } from "../../src/persistence/resource-reservation-store.js";
import { ResourceRuntimeBindingStore } from "../../src/persistence/resource-runtime-binding-store.js";
import { ResourcePolicySchema } from "../../src/domain/resource-budget.js";
import { DispatchRequestSchema, type DispatchRequest } from "../../src/domain/dispatch.js";
import type { ResourceRuntimeInspection } from "../../src/domain/resource-runtime.js";
import { AppServerJobDispatchAdapter } from "../../src/app-server/dispatch-adapter.js";
import { ClaudeJobDispatchAdapter } from "../../src/providers/claude/dispatch-adapter.js";
import { CursorJobDispatchAdapter } from "../../src/providers/cursor/dispatch-adapter.js";
import { AntigravityJobDispatchAdapter } from "../../src/providers/antigravity/dispatch-adapter.js";
import type { WorktreeLeaseManager } from "../../src/control-plane/worktree-lease-manager.js";

const NOW = "2026-09-16T00:00:00.000Z", GiB = 1024 ** 3;
function request(provider = "codex"): DispatchRequest {
  return DispatchRequestSchema.parse({ jobId: randomUUID(), correlationId: randomUUID(), request: {
    provider, cwd: "/tmp/repository", instruction: "inspect repository", sandbox: "read-only", model: provider === "claude" ? "opus" : "fixture-model",
  } });
}
function context(input: DispatchRequest): JobDispatchContext {
  return { attemptGeneration: 1, record: { schemaVersion: 1, id: input.jobId, correlationId: input.correlationId,
    request: input.request, lifecycle: { status: "queued", enqueuedAt: NOW }, createdAt: NOW, updatedAt: NOW } };
}
class FakeProcess extends EventEmitter {
  pid: number | undefined = 123;
  writes: string[] = []; kills: string[] = []; ended = false;
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void) { this.on("exit", listener); }
  onError(listener: (error: Error) => void) { this.on("processError", listener); }
  onStdout(listener: (chunk: Buffer) => void) { this.on("stdout", listener); }
  onStderr(listener: (chunk: Buffer) => void) { this.on("stderr", listener); }
  write(data: string) {
    this.writes.push(data);
    const frame = JSON.parse(data);
    if (frame.id) queueMicrotask(() => this.emit("stdout", Buffer.from(JSON.stringify({ id: frame.id, result:
      frame.method === "initialize" ? { userAgent: "codex-cli 0.144.6", codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "macos" }
        : frame.method === "thread/start" ? { cwd: "/tmp/repository", model: "fixture-model", approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: { type: "readOnly" }, thread: { id: "thread" } }
          : { turn: { id: "turn" } } }) + "\n")));
  }
  writeStdin(data: string) { this.writes.push(data); }
  endStdin() { this.ended = true; }
  kill(signal = "SIGTERM") { this.kills.push(signal); }
}
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn(); });
async function fixture(directory?: string) {
  const path = directory ?? await mkdtemp(join(tmpdir(), "resource-job-"));
  if (!directory) cleanup.push(() => rm(path, { recursive: true, force: true }));
  const store = await ResourceReservationStore.open(path, "test-installation"); cleanup.unshift(() => store.close());
  const bindings = await ResourceRuntimeBindingStore.open(path, () => store.assertOwner());
  let gate!: ResourceExecutionGate;
  const control = { available: true, inspection: { state: "unknown", inventoryComplete: false, identities: [] } as ResourceRuntimeInspection };
  const admission = new ResourceAdmissionService(store, ResourcePolicySchema.parse({ fixedBytes: GiB, uncertainBytes: GiB / 2, controlMarginBytes: GiB / 2, maxPids: 512 }),
    () => ({ observedAt: Date.now(), availableBytes: control.available ? 20 * GiB : 0, pressure: "normal", attributionComplete: true }),
    (reservation, evidence) => gate.verifyTermination(reservation, evidence));
  const capture = vi.fn(async (_binding, runtime) => [{ kind: "native" as const, pid: runtime.pid, startTime: "libproc:1234.000001" }]);
  gate = new ResourceExecutionGate({ installationId: "test-installation", admission, bindings, pollMs: 1,
    resolveFamily: () => "operator-job", resolveDemand: () => ({ memoryBytes: GiB, cpuWeight: 100, pidLimit: 64, profileId: "native-job", profileVersion: "1" }),
    capture, inspect: async () => control.inspection });
  return { path, store, bindings, admission, gate, capture, control };
}

test("durable gate admits before preparation, binds native identity, and holds unknown lifetime after exit/restart", async () => {
  const f = await fixture(), input = request(), canonical = context(input), child = new FakeProcess();
  await f.gate.reconcile();
  const launch = new ResourceJobLaunch({ gate: f.gate, resolveRecord: req => resourceJobRecord(canonical, req) });
  const process = await launch.start(input, () => {
    expect(f.admission.health().reservedBytes).toBe(GiB); expect(f.bindings.list()[0]?.phase).toBe("launching"); return child;
  });
  expect(process.pid).toBe(123); expect(f.bindings.list()[0]).toMatchObject({ phase: "bound", identities: [{ kind: "native", pid: 123 }] });
  child.emit("exit", 0, null);
  await expect(f.gate.release(f.bindings.list()[0]!.request.requestId)).rejects.toThrow("TERMINATION_UNCONFIRMED");
  expect(f.admission.health().reservedBytes).toBe(GiB);
  await f.store.close(); const recovered = await fixture(f.path);
  await expect(recovered.gate.reconcile()).rejects.toThrow("RECONCILIATION_REQUIRED");
  expect(recovered.admission.health().reservedBytes).toBe(GiB);
});

test("released attempt still cannot launch again through a new adapter/gate instance", async () => {
  const f = await fixture(), input = request(), canonical = context(input); await f.gate.reconcile();
  await new ResourceJobLaunch({ gate: f.gate, resolveRecord: req => resourceJobRecord(canonical, req) }).start(input, () => new FakeProcess());
  f.control.inspection = { state: "terminated", inventoryComplete: true, identities: [] };
  await f.gate.release(f.bindings.list()[0]!.request.requestId); await f.store.close();
  const next = await fixture(f.path); await next.gate.reconcile(); const prepare = vi.fn(() => new FakeProcess());
  await expect(new ResourceJobLaunch({ gate: next.gate, resolveRecord: req => resourceJobRecord(canonical, req) }).start(input, prepare)).rejects.toThrow("GENERATION_CONFLICT");
  expect(prepare).not.toHaveBeenCalled();
});

test("queued cancellation has no preparation side effects and releases only pre-spawn capacity", async () => {
  const f = await fixture(), input = request(), canonical = context(input); await f.gate.reconcile(); f.control.available = false;
  const launch = new ResourceJobLaunch({ gate: f.gate, resolveRecord: req => resourceJobRecord(canonical, req) }), prepare = vi.fn(() => new FakeProcess());
  const operation = launch.start(input, prepare), rejected = expect(operation).rejects.toThrow();
  await vi.waitFor(() => expect(f.admission.health().queue).toHaveLength(1));
  expect(launch.cancelStart(input.jobId)).toBe(true); await rejected;
  expect(prepare).not.toHaveBeenCalled(); expect(f.admission.health().reservedBytes).toBe(0);
});

test("canonical cancellation during capacity wait is rechecked before preparation", async () => {
  const f = await fixture(), input = request(), canonical = context(input); await f.gate.reconcile(); f.control.available = false;
  const launch = new ResourceJobLaunch({ gate: f.gate, resolveRecord: req => resourceJobRecord(canonical, req) }), prepare = vi.fn(() => new FakeProcess());
  const operation = launch.start(input, prepare), rejected = expect(operation).rejects.toThrow("CANONICAL_MISMATCH");
  await vi.waitFor(() => expect(f.admission.health().queue).toHaveLength(1));
  canonical.record.lifecycle = { status: "settled", finishedAt: NOW, result: { outcome: "cancelled" } }; f.control.available = true;
  await rejected; expect(prepare).not.toHaveBeenCalled();
});

test.each(["missing-pid", "capture-failure"])("%s signals exact child and retains launching debt", async mode => {
  const f = await fixture(), input = request(), canonical = context(input), child = new FakeProcess(); await f.gate.reconcile();
  if (mode === "missing-pid") child.pid = undefined; else f.capture.mockRejectedValue(new Error("capture unavailable"));
  await expect(new ResourceJobLaunch({ gate: f.gate, resolveRecord: req => resourceJobRecord(canonical, req) }).start(input, () => child)).rejects.toThrow();
  expect(child.kills).toContain("SIGTERM"); expect(f.admission.health().reservedBytes).toBe(GiB); expect(f.bindings.list()[0]?.phase).toBe("launching");
});

test("exit and error during capture replay to late subscribers without claiming native termination", async () => {
  const f = await fixture(), input = request(), canonical = context(input), child = new FakeProcess(); await f.gate.reconcile();
  f.capture.mockImplementation(async () => {
    child.emit("processError", new Error("child error")); child.emit("exit", 7, null);
    return [{ kind: "native", pid: 123, startTime: "libproc:1234.000001" }];
  });
  const process = await new ResourceJobLaunch({ gate: f.gate, resolveRecord: req => resourceJobRecord(canonical, req) }).start(input, () => child);
  const exit = vi.fn(), error = vi.fn(); process.onExit(exit); process.onError(error);
  expect(exit).toHaveBeenCalledWith(7, null); expect(error).toHaveBeenCalledWith(expect.objectContaining({ message: "child error" }));
  expect(f.admission.health().reservedBytes).toBe(GiB);
});

test.each(["codex", "claude", "cursor", "antigravity"])("%s adapter waits for identity capture before acknowledging its native launch", async provider => {
  const input = request(provider), canonical = context(input), child = new FakeProcess();
  let release!: () => void, capturing = false;
  const ready = new Promise<void>(resolve => { release = resolve; });
  const resourceLaunch = new ResourceJobLaunch({ resolveRecord: req => resourceJobRecord(canonical, req), gate: {
    async start(_record, prepare) { const runtime = await prepare(); capturing = true; await ready; return runtime; }, cancelStart: () => false,
  } });
  const commands: { executable: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const spawn = (command: { executable: string; args: string[]; env: NodeJS.ProcessEnv }) => { commands.push(command); return child; };
  const adapter = provider === "codex" ? new AppServerJobDispatchAdapter({ spawn, resourceLaunch })
    : provider === "claude" ? new ClaudeJobDispatchAdapter({ spawn, resourceLaunch })
      : provider === "cursor" ? new CursorJobDispatchAdapter({ spawn, resourceLaunch }) : new AntigravityJobDispatchAdapter({ spawn, resourceLaunch });
  let accepted = false;
  const dispatched = adapter.dispatch(input).then(result => { accepted = true; return result; }); await vi.waitFor(() => expect(capturing).toBe(true));
  expect(accepted).toBe(false);
  expect(child.writes).toEqual([]); expect(child.ended).toBe(false);
  release(); await dispatched;
  expect(commands).toHaveLength(1); expect(commands[0]!.env).not.toHaveProperty("OPENAI_API_KEY");
  if (provider === "codex") expect(commands[0]!.args).toEqual(["app-server", "--stdio", "--strict-config"]);
  child.emit("exit", 0, null);
});

test("Codex worktree preparation waits for the reservation and preserves job lease authority", async () => {
  const input = request(); input.request = { ...input.request, sandbox: "workspace-write" };
  const canonical = context(input), child = new FakeProcess(), acquire = vi.fn(async () => ({ leaseId: "lease" })), release = vi.fn(async () => {});
  let launch!: () => Promise<unknown>;
  const resourceLaunch = new ResourceJobLaunch({ resolveRecord: req => resourceJobRecord(canonical, req), gate: {
    start(_record, prepare) { return new Promise((_resolve, reject) => { launch = async () => { await prepare(); reject(new Error("capture-failed")); }; }); }, cancelStart: () => false,
  } });
  const spawn = vi.fn(() => child), adapter = new AppServerJobDispatchAdapter({ spawn, resourceLaunch,
    leaseManager: { acquire, release } as unknown as WorktreeLeaseManager });
  const dispatched = adapter.dispatch(input), rejected = expect(dispatched).rejects.toThrow("capture-failed");
  await vi.waitFor(() => expect(launch).toBeDefined()); expect(acquire).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled();
  await launch(); await rejected;
  expect(acquire).toHaveBeenCalledWith(expect.objectContaining({ holderJobId: input.jobId, worktreePath: input.request.cwd, access: "workspace-write" }));
  expect(release).toHaveBeenCalledTimes(1); expect(child.kills).toContain("SIGTERM");
});

test.each(["codex", "claude", "cursor", "antigravity"])("%s cancellation while admission waits never spawns a child", async provider => {
  const f = await fixture(), input = request(provider), canonical = context(input), spawn = vi.fn(() => new FakeProcess());
  await f.gate.reconcile(); f.control.available = false;
  const resourceLaunch = new ResourceJobLaunch({ gate: f.gate, resolveRecord: req => resourceJobRecord(canonical, req) });
  const adapter = provider === "codex" ? new AppServerJobDispatchAdapter({ spawn, resourceLaunch })
    : provider === "claude" ? new ClaudeJobDispatchAdapter({ spawn, resourceLaunch })
      : provider === "cursor" ? new CursorJobDispatchAdapter({ spawn, resourceLaunch }) : new AntigravityJobDispatchAdapter({ spawn, resourceLaunch });
  const dispatched = adapter.dispatch(input), rejected = expect(dispatched).rejects.toThrow();
  await vi.waitFor(() => expect(f.admission.health().queue).toHaveLength(1));
  expect((await adapter.cancel({ schemaVersion: 1, jobId: input.jobId, correlationId: input.correlationId })).accepted).toBe(true);
  await rejected; expect(spawn).not.toHaveBeenCalled(); expect(f.admission.health().reservedBytes).toBe(0);
});
