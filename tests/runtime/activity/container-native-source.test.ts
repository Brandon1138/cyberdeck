import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionRecord } from "../../../src/domain/session.js";
import { ContainerNativeSource } from "../../../src/runtime/activity/container-native-source.js";
import { ExecutionTranscriptStore } from "../../../src/persistence/execution-transcript-store.js";

const T = "2026-10-13T10:00:00.000Z", T1 = "2026-10-13T10:00:01.000Z", T2 = "2026-10-13T10:00:02.000Z";
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const lines = (frames: unknown[]) => frames.map((frame) => JSON.stringify(frame)).join("\n") + "\n";
const meta = (nativeId: string) => ({ type: "session_meta", timestamp: T,
  payload: { id: nativeId, cwd: "/workspace", originator: "codex-tui" } });
const start = (id = "turn", timestamp = T1) => ({ type: "event_msg", timestamp, payload: { type: "task_started", turn_id: id } });
const complete = (id = "turn", text?: string | null, timestamp = T2) => ({ type: "event_msg", timestamp,
  payload: { type: "task_complete", turn_id: id, ...(text === undefined ? {} : { last_agent_message: text }) } });
const assistant = (id = "candidate", content: unknown[] = [{ type: "text", text: "candidate final" }], timestamp = T1) => ({
  type: "assistant", uuid: `frame-${id}`, timestamp,
  message: { id, role: "assistant", stop_reason: "end_turn", content },
});
const duration = (id = "stop", timestamp = T2) => ({ type: "system", subtype: "turn_duration", uuid: id, timestamp });
async function fixture(provider: "claude" | "codex" = "codex", kind: "worker" | "orchestrator" = "worker") {
  const root = await mkdtemp(join(tmpdir(), "container-native-contract-")); roots.push(root);
  const id = randomUUID(), executionId = randomUUID(), nativeId = provider === "claude" ? id : randomUUID();
  const session: SessionRecord = { id, provider, kind, executor: "orbstack-container", cwd: "/host/private-clone",
    detached: true, sandbox: "workspace-write", generation: 2, createdAt: T, updatedAt: T,
    executionState: "active", attachmentState: "detached", pid: 0, exitCode: null, childIds: [],
    execution: { brokerId: randomUUID(), executionId, workerId: id, sessionId: id, generation: 2,
      executor: "orbstack-container", workspaceId: "/host/private-clone" } };
  const source = new ContainerNativeSource(join(root, "containers"));
  const directory = provider === "codex" ? join(source.stateRoot(id), ".codex", "sessions", "2026", "10", "13")
    : join(source.stateRoot(id), ".claude", "projects", "-workspace");
  await mkdir(directory, { recursive: true });
  const path = join(directory, provider === "codex" ? "rollout.jsonl" : `${id}.jsonl`);
  const store = new ExecutionTranscriptStore(root, {}, source, () => session);
  const input = { sessionId: id, provider, cwd: session.cwd, createdAt: T, turnNumber: 1,
    allowFallback: true, fallbackText: "own terminal boundary final" };
  return { root, nativeId, session, source, store, path, directory, input, executionId };
}

describe("container native activity/completion contract", () => {
  it.each(["worker", "orchestrator"] as const)("reports an in-flight Codex %s source without fallback completion", async (kind) => {
    const f = await fixture("codex", kind);
    await writeFile(f.path, lines([meta(f.nativeId), start()]));
    const observation = await f.store.observeProviderTurns(f.input);
    expect(observation).toMatchObject({ nativeSourceAvailable: true, nativeSourceStatus: "available", nativeFallbackAllowed: false,
      nativeSessionId: f.nativeId, nativeActivity: "working", turns: [],
      nativeActivityEvidence: { id: "task_started:turn", kind: "task_started", providerTurnId: "turn",
        occurredAt: T1, generation: 2, executionId: f.executionId, nativeSessionId: f.nativeId } });
    expect(observation.activityVersion).toBeDefined();
    expect(await f.store.observeProviderTurns(f.input)).toEqual(observation);
  });

  it.each([undefined, null, "", "   "])("counts textless Codex task_complete (%s) with stable identity and ordinal", async (text) => {
    const f = await fixture();
    await writeFile(f.path, lines([meta(f.nativeId), start(), complete("turn", text)]));
    expect(await f.store.observeProviderTurns(f.input)).toMatchObject({ nativeSourceAvailable: true, nativeActivity: "idle",
      nativeActivityEvidence: { kind: "task_complete", providerTurnId: "turn" },
      turns: [{ providerTurnId: "turn", text: text ?? "", transport: "provider-native", data: {
        nativeSessionId: f.nativeId, nativeActivity: { generation: 2, executionId: f.executionId },
      } }] });
    await f.store.captureProviderTurns(f.input);
    const reopened = new ExecutionTranscriptStore(f.root, {}, f.source, () => f.session);
    expect(await reopened.observeProviderTurns({ ...f.input, turnNumber: 2 })).toMatchObject({ nativeSourceAvailable: true,
      nativeFallbackAllowed: false, turns: [] });
    expect(await reopened.readCompletionLedger(f.session.id)).toMatchObject({ completedTurns: 1, canonicalTurns: 1 });
  });

  it.each(["worker", "orchestrator"] as const)("keeps Claude %s end_turn and Stop-hook work in flight until turn_duration", async (kind) => {
    const f = await fixture("claude", kind);
    await writeFile(f.path, lines([{ type: "user", timestamp: T, uuid: "prompt", message: { role: "user", content: "work" } }, assistant()]));
    expect(await f.store.observeProviderTurns(f.input)).toMatchObject({ nativeSourceAvailable: true,
      nativeFallbackAllowed: false, nativeActivity: "working", nativeActivityEvidence: { id: "frame-candidate", generation: 2 }, turns: [] });
    const reopened = new ExecutionTranscriptStore(f.root, {}, f.source, () => f.session);
    expect(await reopened.observeProviderTurns(f.input)).toMatchObject({ nativeActivity: "working", turns: [] });
    await appendFile(f.path, lines([{ type: "assistant", timestamp: "2026-10-13T10:00:01.100Z", uuid: "stop-tool",
      message: { role: "assistant", content: [{ type: "tool_use", id: "tool", name: "Read", input: {} }] } },
      assistant("after-hook", [{ type: "text", text: "actual final" }], "2026-10-13T10:00:01.200Z")]));
    expect(await reopened.observeProviderTurns(f.input)).toMatchObject({ nativeActivity: "working", turns: [] });
    await appendFile(f.path, lines([duration()]));
    const completed = await reopened.observeProviderTurns(f.input);
    expect(completed).toMatchObject({ nativeSourceAvailable: true, nativeActivity: "idle",
      nativeActivityEvidence: { kind: "turn_duration", id: "after-hook", occurredAt: T2 },
      turns: [{ providerTurnId: "after-hook", text: "actual final", data: {
        nativeActivity: { fromOffset: 0, throughOffset: Buffer.byteLength(await readFile(f.path)), generation: 2, executionId: f.executionId },
      } }] });
  });

  it("keeps an exact empty/partial Claude source available but unknown", async () => {
    const f = await fixture("claude");
    await writeFile(f.path, "");
    const empty = await f.store.observeProviderTurns(f.input);
    expect(empty).toMatchObject({ nativeSourceAvailable: true, nativeActivity: "unknown", nativeFallbackAllowed: false, turns: [] });
    await writeFile(f.path, JSON.stringify(assistant()));
    expect(await f.store.observeProviderTurns(f.input)).toMatchObject({ nativeSourceAvailable: true,
      nativeActivity: "unknown", activityVersion: empty.activityVersion, turns: [] });
  });

  it("retains stable Claude tool-only duration receipts and later completed turns", async () => {
    const f = await fixture("claude");
    await writeFile(f.path, lines([assistant("tool-only", [{ type: "tool_use", id: "tool", name: "Read", input: {} }]), duration("tool-stop")]));
    expect(await f.store.captureProviderTurns(f.input)).toMatchObject([{ text: "", data: { semanticTurnId: "claude:stop:tool-stop", turnNumber: 1 } }]);
    await appendFile(f.path, lines([assistant("next", [{ type: "text", text: "later" }], "2026-10-13T10:00:03.000Z"), duration("next-stop", "2026-10-13T10:00:04.000Z")]));
    const reopened = new ExecutionTranscriptStore(f.root, {}, f.source, () => f.session);
    expect(await reopened.captureProviderTurns({ ...f.input, turnNumber: 2 })).toMatchObject([{ text: "later", data: { semanticTurnId: "claude:next", turnNumber: 2 } }]);
  });

  it("treats an abort as idle with a negative source receipt", async () => {
    const f = await fixture();
    await writeFile(f.path, lines([meta(f.nativeId), start(), { type: "event_msg", timestamp: T2, payload: { type: "turn_aborted", turn_id: "turn" } }]));
    expect(await f.store.observeProviderTurns(f.input)).toMatchObject({ nativeSourceAvailable: true, nativeActivity: "idle",
      nativeActivityEvidence: { kind: "turn_aborted" }, nativeFallbackAllowed: false, turns: [expect.objectContaining({ data: expect.objectContaining({ outcome: "cancelled" }) })] });
  });

  it.each([false, true])("recovers an engine-banked negative abort closure without losing later receipts (source data=%s)", async (withData) => {
    const f = await fixture();
    await writeFile(f.path, lines([meta(f.nativeId), start("cancelled-turn"), {
      type: "event_msg", timestamp: T2, payload: { type: "turn_aborted", turn_id: "cancelled-turn" },
    }]));
    const aborted = await f.store.observeProviderTurns(f.input);
    expect(aborted.turns).toMatchObject([{ data: { outcome: "cancelled" } }]);
    expect(aborted.nativeActivityEvidence!.receiptData).toMatchObject({ nativeSessionId: f.nativeId,
      nativeActivity: { executionId: f.executionId, generation: 2, throughOffset: Buffer.byteLength(await readFile(f.path)) } });
    await f.store.commitProviderTurns({ ...aborted, turns: [{ providerTurnId: "cancelled-turn", providerOccurredAt: T2,
      text: "cancelled", transport: "provider-native", data: { ...(withData ? aborted.nativeActivityEvidence!.receiptData : {}),
        outcome: "cancelled", nativeActivityId: aborted.nativeActivityEvidence!.id } }] });
    await appendFile(f.path, lines([complete("next", "later", "2026-10-13T10:00:03.000Z")]));
    const reopened = new ExecutionTranscriptStore(f.root, {}, f.source, () => f.session);
    expect(await reopened.captureProviderTurns({ ...f.input, turnNumber: 2 })).toMatchObject([{ text: "later", data: { turnNumber: 2 } }]);
  });

  it("snapshots native evidence and intervals before a concurrent generation replacement", async () => {
    const f = await fixture();
    await writeFile(f.path, lines([meta(f.nativeId), start(), complete("turn", "done")]));
    const resolve = f.source.resolve.bind(f.source);
    vi.spyOn(f.source, "resolve").mockImplementation(async (record) => {
      const result = await resolve(record);
      f.session.generation = 3; f.session.execution!.generation = 3;
      return result;
    });
    const observation = await f.store.observeProviderTurns(f.input);
    expect(observation).toMatchObject({ nativeActivityEvidence: { generation: 2, executionId: f.executionId },
      turns: [{ data: { nativeActivity: { generation: 2, executionId: f.executionId } } }] });
    expect(f.session.generation).toBe(3);
  });

  it("preserves exact source-ID receipt recovery through semantic rotation and tied timestamps", async () => {
    const f = await fixture();
    const options = { maxBytes: 2048, retainedFiles: 1 };
    const store = new ExecutionTranscriptStore(f.root, options, f.source, () => f.session);
    await writeFile(f.path, lines([meta(f.nativeId)]));
    for (let ordinal = 1; ordinal <= 10; ordinal++) {
      await appendFile(f.path, lines([complete(`turn-${ordinal}`, "result ".repeat(45), T2)]));
      expect(await store.captureProviderTurns({ ...f.input, turnNumber: ordinal })).toHaveLength(1);
    }
    const reopened = new ExecutionTranscriptStore(f.root, options, f.source, () => f.session);
    expect(await reopened.readCompletionLedger(f.session.id)).toMatchObject({ completedTurns: 10, canonicalTurns: 10 });
    expect(await reopened.observeProviderTurns({ ...f.input, turnNumber: 11 })).toMatchObject({ turns: [] });
    await appendFile(f.path, lines([complete("turn-11", undefined, T2)]));
    expect(await reopened.captureProviderTurns({ ...f.input, turnNumber: 11 })).toMatchObject([{ text: "", data: { turnNumber: 11, canonicalTurns: 11 } }]);
  });

  it("refuses completion attribution when a replaced log lost its last durable native turn ID", async () => {
    const f = await fixture();
    await writeFile(f.path, lines([meta(f.nativeId), complete("first", "done")]));
    await f.store.captureProviderTurns(f.input);
    await writeFile(f.path, lines([meta(f.nativeId), complete("replacement", "different")]));
    expect(await f.store.observeProviderTurns({ ...f.input, turnNumber: 2 })).toMatchObject({ nativeSourceAvailable: true,
      nativeSourceReason: "NATIVE_COMPLETION_BOUNDARY_MISSING", nativeFallbackAllowed: false, turns: [] });
  });

  it.each(["claude", "codex"] as const)("deletion cleanup drops the exact %s claim without removing retained native evidence", async (provider) => {
    const f = await fixture(provider);
    const body = provider === "codex" ? lines([meta(f.nativeId)]) : lines([assistant(), duration()]);
    await writeFile(f.path, body);
    await f.source.read(f.session);
    expect(JSON.parse(await readFile(f.source.bindingPath(f.session.id), "utf8"))).toMatchObject({
      sessionId: f.session.id, nativeSessionId: f.nativeId, executionId: f.executionId,
    });
    if (provider === "codex") await f.store.dropCodexBinding(f.session.id);
    else await f.store.dropClaudeBinding(f.session.id);
    await expect(readFile(f.source.bindingPath(f.session.id))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(f.path, "utf8")).toBe(body);
  });
});

describe("container unavailable source safety", () => {
  it.each(["claude", "codex"] as const)("permits only explicitly authorized truly absent %s transcript fallback", async (provider) => {
    const f = await fixture(provider);
    expect(await f.store.observeProviderTurns({ ...f.input, allowFallback: false })).toMatchObject({ nativeSourceAvailable: false,
      nativeSourceStatus: "missing", nativeFallbackAllowed: false, turns: [] });
    expect(await f.store.observeProviderTurns(f.input)).toMatchObject({ nativeSourceAvailable: false, nativeSourceStatus: "missing",
      nativeFallbackAllowed: true, turns: [{ providerTurnId: "fallback:1", transport: "terminal-replay-fallback" }] });
  });

  it("does not fallback for an unbound/incomplete private Codex source", async () => {
    const f = await fixture();
    await writeFile(f.path, JSON.stringify(meta(f.nativeId)));
    expect(await f.store.observeProviderTurns(f.input)).toMatchObject({ nativeSourceAvailable: false,
      nativeSourceStatus: "unbound", nativeFallbackAllowed: false, turns: [] });
  });

  it("does not fallback for multiple private native identities", async () => {
    const f = await fixture();
    await writeFile(f.path, lines([meta(f.nativeId)]));
    await writeFile(join(f.directory, "foreign.jsonl"), lines([meta(randomUUID())]));
    expect(await f.store.observeProviderTurns(f.input)).toMatchObject({ nativeSourceAvailable: false,
      nativeSourceStatus: "conflict", nativeSourceReason: "NATIVE_CONVERSATION_UNBOUND", nativeFallbackAllowed: false, turns: [] });
  });

  it.each(["EACCES", "ENOENT"])("does not fallback after an unresolved native read error (%s)", async (code) => {
    const f = await fixture();
    vi.spyOn(f.source, "read").mockRejectedValueOnce(Object.assign(new Error("read failed"), { code }));
    expect(await f.store.observeProviderTurns(f.input)).toMatchObject({ nativeSourceAvailable: false,
      nativeSourceStatus: "source-error", nativeSourceReason: code, nativeFallbackAllowed: false, nativeActivity: "unknown", turns: [] });
    expect((await f.store.read(f.session.id)).events).toEqual([]);
  });

  it.each(["claude", "codex"] as const)("does not fallback for a corrupt %s binding", async (provider) => {
    const f = await fixture(provider);
    await mkdir(join(f.root, "containers", "native-bindings"), { recursive: true });
    await writeFile(f.source.bindingPath(f.session.id), "invalid binding");
    expect(await f.store.observeProviderTurns(f.input)).toMatchObject({ nativeSourceStatus: "source-error", nativeFallbackAllowed: false, turns: [] });
  });

  it("refuses a binding from a different execution even for the same worker/native IDs", async () => {
    const f = await fixture();
    await writeFile(f.path, lines([meta(f.nativeId)]));
    await f.source.resolve(f.session);
    f.session.execution!.executionId = randomUUID();
    expect(await f.store.observeProviderTurns(f.input)).toMatchObject({ nativeSourceStatus: "conflict", nativeFallbackAllowed: false, turns: [] });
  });

  it("requires the execution-owned actor identity before inspecting a provider-state directory", async () => {
    const f = await fixture();
    f.session.execution!.sessionId = randomUUID();
    expect(await f.store.observeProviderTurns(f.input)).toMatchObject({ nativeSourceStatus: "unbound",
      nativeSourceReason: "NATIVE_EXECUTION_UNBOUND", nativeFallbackAllowed: false, turns: [] });
  });

  it("refuses escaped/symlinked source files without fallback", async () => {
    const f = await fixture();
    const foreign = join(f.root, "outside.jsonl");
    await writeFile(foreign, lines([meta(f.nativeId), complete("foreign", "foreign answer")]));
    await symlink(foreign, f.path);
    expect(await f.store.observeProviderTurns(f.input)).toMatchObject({ nativeSourceStatus: "conflict", nativeFallbackAllowed: false, turns: [] });
  });

  it("retains the safe reader's size limit as source-error rather than fallback authority", async () => {
    const f = await fixture();
    await writeFile(f.path, lines([meta(f.nativeId)]));
    await truncate(f.path, 512 * 1024 * 1024 + 1);
    expect(await f.store.observeProviderTurns(f.input)).toMatchObject({ nativeSourceStatus: "source-error",
      nativeSourceReason: "ACTIVITY_SOURCE_LIMIT", nativeFallbackAllowed: false, turns: [] });
  });
});
