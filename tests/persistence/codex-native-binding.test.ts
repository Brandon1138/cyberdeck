import { appendFile, mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ThreadTranscriptStore } from "../../src/persistence/thread-transcript-store.js";
import { CodexConversationBindingStore } from "../../src/persistence/codex-conversation-bindings.js";
import { codexSessionMarker } from "../../src/providers/codex/native-session-identity.js";
import { CodexProviderAdapter } from "../../src/providers/codex.js";
import type { SessionRecord } from "../../src/domain/session.js";
import { NativeTurnActivity } from "../../src/orchestration/session/worker-turn-native-state.js";
import { codexLaunchFixture } from "../fixtures/codex-launch.js";

const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";
const cwd = "/tmp/repo", T = "2026-10-13T10:00:00.000Z";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const jsonl = (frames: unknown[]) => frames.map((frame) => JSON.stringify(frame)).join("\n") + "\n";
const marker = (id: string, role = "developer") => ({ type: "response_item", payload: {
  type: "message", role, content: [{ type: "input_text", text: codexSessionMarker(id) }],
} });
const started = (id: string) => ({ type: "event_msg", timestamp: "2026-10-13T10:00:03.000Z",
  payload: { type: "task_started", turn_id: id } });
const completed = (id: string, text?: string | null) => ({ type: "event_msg", timestamp: "2026-10-13T10:00:04.000Z",
  payload: { type: "task_complete", turn_id: id, ...(text === undefined ? {} : { last_agent_message: text }) } });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cyberdeck-exact-codex-")); roots.push(root);
  const sessions = join(root, "sessions"), day = join(sessions, "2026", "10", "13");
  await mkdir(day, { recursive: true });
  const bindings = new CodexConversationBindingStore(root);
  const options = { codexSessionsDirectory: sessions, codexConversations: bindings };
  const store = new ThreadTranscriptStore(root, options);
  const input = (sessionId = A, createdAt = T) => ({ sessionId, provider: "codex", cwd, createdAt, turnNumber: 1 });
  async function rollout(nativeId: string, owner: string | undefined, timestamp = T, frames: unknown[] = []) {
    const path = join(day, `rollout-${nativeId}.jsonl`);
    await writeFile(path, jsonl([{ type: "session_meta", payload: { id: nativeId, timestamp, cwd, originator: "codex-tui" } },
      ...(owner === undefined ? [] : [marker(owner)]), ...frames]));
    return path;
  }
  return { root, sessions, day, bindings, options, store, input, rollout };
}

describe("exact Codex native binding", () => {
  it("does not bind or commit a two-hour-old markerless same-brief rollout on a live read", async () => {
    const h = await codexLaunchFixture(); roots.push(h.root);
    await h.metadata("LEGACY X", "2026-10-13T08:00:00.000Z");
    await h.complete("LEGACY X", "A BRIEF");
    const observation = await h.store.observeProviderTurns(h.input(h.a));
    expect(observation).toMatchObject({ nativeSourceAvailable: false, nativeSourceStatus: "unbound", turns: [] });
    await h.store.commitProviderTurns(observation);
    expect(await new CodexConversationBindingStore(h.root).read(h.a.id)).toBeUndefined();
    expect(await h.store.readCompletionLedger(h.a.id)).toMatchObject({ completedTurns: 0, canonicalTurns: 0, turns: [] });
  });

  it.each([-30_001, -30_000, 30_000, 30_001])("bounds legacy markerless launch matching to 30 seconds (%s ms)", async offset => {
    const f = await fixture();
    const instructionId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    await f.store.append({ sessionId: A, kind: "prompt", source: "orchestrator", text: "FIRST BRIEF",
      data: { initial: true, instructionId, expectedTurn: 1 } });
    await f.rollout("legacy", undefined, new Date(Date.parse(T) + offset).toISOString(), [
      { type: "event_msg", payload: { type: "user_message", message: "FIRST BRIEF" } }, completed("first", "answer"),
    ]);
    expect((await f.store.observeProviderTurns({ ...f.input(), initialInstructionId: instructionId })).nativeSourceAvailable)
      .toBe(Math.abs(offset) <= 30_000);
  });

  it("requires the own marker for a marker-injected launch even inside the legacy window", async () => {
    const f = await fixture();
    const instructionId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    await f.store.append({ sessionId: A, kind: "prompt", source: "orchestrator", text: "FIRST BRIEF",
      data: { initial: true, instructionId, expectedTurn: 1 } });
    await f.rollout("legacy", undefined, T, [
      { type: "event_msg", payload: { type: "user_message", message: "FIRST BRIEF" } }, completed("first", "foreign"),
    ]);
    expect(await f.store.observeProviderTurns({ ...f.input(), initialInstructionId: instructionId, codexMarkerRequired: true }))
      .toMatchObject({ nativeSourceAvailable: false, nativeSourceStatus: "unbound", turns: [] });
    expect(await f.bindings.read(A)).toBeUndefined();
  });

  it("keeps a bound worker and its three-hour-later same-brief retry on their own marked rollouts", async () => {
    const f = await fixture();
    const retryAt = "2026-10-13T13:00:00.000Z";
    const instructionIds = ["dddddddd-dddd-4ddd-8ddd-dddddddddddd", "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"];
    const prompt = { type: "event_msg", payload: { type: "user_message", message: "SAME BRIEF" } };
    for (const [index, sessionId] of [A, B].entries()) await f.store.append({ sessionId, kind: "prompt", source: "orchestrator", text: "SAME BRIEF",
      data: { initial: true, instructionId: instructionIds[index], expectedTurn: 1 } });
    const inputs = [T, retryAt].map((at, index) => ({ ...f.input(index === 0 ? A : B, at),
      initialInstructionId: instructionIds[index], codexMarkerRequired: true }));
    const own = await f.rollout("native-x", A, T, [prompt, completed("x", "X ANSWER")]);
    expect(await f.store.observeProviderTurns(inputs[0]!)).toMatchObject({ nativeSourceAvailable: true, nativeSessionId: "native-x" });
    await f.rollout("native-y", B, retryAt, [prompt, { type: "event_msg", timestamp: "2026-10-13T13:00:04.000Z",
      payload: { type: "task_complete", turn_id: "y", last_agent_message: "Y ANSWER" } }]);
    for (const store of [f.store, new ThreadTranscriptStore(f.root, f.options)]) {
      for (const [index, input] of inputs.entries()) {
        const observation = await store.observeProviderTurns(input);
        expect(observation).toMatchObject({ nativeSourceAvailable: true, nativeSourceStatus: "available",
          nativeSessionId: index === 0 ? "native-x" : "native-y", turns: [{ text: index === 0 ? "X ANSWER" : "Y ANSWER" }] });
        const native = new NativeTurnActivity(input.createdAt);
        native.observeScreen(0, "awaiting-input");
        native.observe(observation, 0, 0);
        expect(native.refused).toBe(false);
        expect(native.activity("awaiting-input", 0)).toBe("awaiting-input");
      }
    }
    expect(await f.bindings.read(A)).toMatchObject({ transcriptPath: own, nativeSessionId: "native-x" });
    expect(await f.bindings.read(B)).toMatchObject({ nativeSessionId: "native-y" });
    const noScan = new ThreadTranscriptStore(f.root, { ...f.options, codexSessionsDirectory: join(f.root, "missing") });
    for (const input of inputs) expect(await noScan.observeProviderTurns(input)).toMatchObject({ nativeSourceAvailable: true });
  });

  it("refuses two matching rollouts with the same actor marker before binding", async () => {
    const f = await fixture();
    const instructionId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    await f.store.append({ sessionId: A, kind: "prompt", source: "orchestrator", text: "FIRST BRIEF",
      data: { initial: true, instructionId, expectedTurn: 1 } });
    for (const nativeId of ["one", "two"]) await f.rollout(nativeId, A, T, [
      { type: "event_msg", payload: { type: "user_message", message: "FIRST BRIEF" } }, completed(nativeId, "answer"),
    ]);
    expect(await f.store.observeProviderTurns({ ...f.input(), initialInstructionId: instructionId, codexMarkerRequired: true }))
      .toMatchObject({ nativeSourceAvailable: false, nativeSourceStatus: "conflict", turns: [] });
    expect(await f.bindings.read(A)).toBeUndefined();
  });

  it("keeps duplicate exact launch identities ambiguous after a binding has been persisted", async () => {
    const f = await fixture();
    const instructionId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    await f.store.append({ sessionId: A, kind: "prompt", source: "orchestrator", text: "FIRST BRIEF",
      data: { initial: true, instructionId, expectedTurn: 1 } });
    const input = { ...f.input(), initialInstructionId: instructionId, allowFallback: false };
    const frames = [{ type: "event_msg", payload: { type: "user_message", message: "FIRST BRIEF" } }, completed("first", "answer")];
    await f.rollout("one", undefined, T, frames);
    expect(await f.store.observeProviderTurns(input)).toMatchObject({ nativeSourceAvailable: true });
    expect(await f.bindings.read(A)).toMatchObject({ nativeSessionId: "one" });
    await f.rollout("two", undefined, T, frames);
    expect(await new ThreadTranscriptStore(f.root, f.options).observeProviderTurns(input))
      .toMatchObject({ nativeSourceAvailable: false, nativeSourceStatus: "conflict", turns: [] });
  });

  it("retains the launch match through semantic journal rotation without storing the brief in its binding", async () => {
    const f = await fixture();
    const options = { ...f.options, maxBytes: 1024, retainedFiles: 1 };
    const store = new ThreadTranscriptStore(f.root, options);
    const instructionId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    await store.append({ sessionId: A, kind: "prompt", source: "orchestrator", text: "FIRST BRIEF",
      data: { initial: true, instructionId, expectedTurn: 1 } });
    const input = { ...f.input(), initialInstructionId: instructionId, allowFallback: false };
    const path = await f.rollout("rotated-launch", undefined, T, [
      { type: "event_msg", payload: { type: "user_message", message: "FIRST BRIEF" } }, completed("first", "first answer"),
    ]);
    expect(await store.captureProviderTurns(input)).toHaveLength(1);
    for (let index = 0; index < 5; index++) await store.append({ sessionId: A, kind: "lifecycle", source: "broker", text: "rotate ".repeat(130) });
    const restarted = new ThreadTranscriptStore(f.root, options);
    const binding = await f.bindings.read(A);
    expect(binding).toMatchObject({ nativeSessionId: "rotated-launch", launchIdentity: { id: instructionId, textHash: expect.any(String) } });
    expect(JSON.stringify(binding)).not.toContain("FIRST BRIEF");
    await appendFile(path, jsonl([completed("next", "next answer")]));
    expect(await restarted.captureProviderTurns({ ...input, turnNumber: 2 })).toMatchObject([{ text: "next answer", data: { turnNumber: 2, canonicalTurns: 2 } }]);
  });

  it("requires the matching launch brief even when the actor marker and durable binding are exact", async () => {
    const f = await fixture();
    const instructionId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    await f.store.append({ sessionId: A, kind: "prompt", source: "orchestrator", text: "FIRST BRIEF",
      data: { initial: true, instructionId, expectedTurn: 1 } });
    const input = { ...f.input(), initialInstructionId: instructionId, allowFallback: false };
    const prompt = (message: string) => ({ type: "event_msg", payload: { type: "user_message", message } });
    const path = await f.rollout("launch", A, T, [prompt("OTHER BRIEF"), completed("first", "foreign")]);
    expect(await f.store.observeProviderTurns(input)).toMatchObject({ nativeSourceAvailable: false, turns: [] });
    expect(await f.bindings.read(A)).toBeUndefined();
    expect(await f.store.readTranscriptMessages(input)).toEqual([]);
    expect(await f.store.readProviderBudgetTelemetry(input, "session")).toEqual({});
    await f.rollout("launch", A, T, [prompt("FIRST BRIEF"), completed("first", "own")]);
    expect(await f.store.observeProviderTurns(input)).toMatchObject({ nativeSourceAvailable: true, turns: [{ text: "own" }] });
    expect(await f.bindings.read(A)).toMatchObject({ transcriptPath: path, nativeSessionId: "launch" });
    await f.rollout("launch", A, T, [prompt("OTHER BRIEF"), completed("second", "foreign after replacement")]);
    expect(await new ThreadTranscriptStore(f.root, f.options).observeProviderTurns(input))
      .toMatchObject({ nativeSourceAvailable: false, turns: [] });
  });

  it("refuses duplicate markerless launch identities but skips foreign actors before persisting a binding", async () => {
    for (const duplicate of [false, true]) {
      const f = await fixture();
      const instructionId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
      await f.store.append({ sessionId: A, kind: "prompt", source: "orchestrator", text: "FIRST BRIEF",
        data: { initial: true, instructionId, expectedTurn: 1 } });
      const frames = [{ type: "event_msg", payload: { type: "user_message", message: "FIRST BRIEF" } }, completed("first", "answer")];
      await f.rollout("one", duplicate ? undefined : B, T, frames);
      if (duplicate) await f.rollout("two", undefined, T, frames);
      expect(await f.store.observeProviderTurns({ ...f.input(), initialInstructionId: instructionId, allowFallback: false }))
        .toMatchObject({ nativeSourceAvailable: false, nativeSourceStatus: duplicate ? "conflict" : "unbound", turns: [] });
      expect(await f.bindings.read(A)).toBeUndefined();
    }
  });

  it.each([false, true])("does not swap same-cwd launches with inverted native start times (reverse=%s)", async (reverse) => {
    const f = await fixture();
    await f.rollout("native-a", A, "2026-10-13T10:00:02.000Z", [completed("turn-a", "answer a"),
      { type: "turn_context", payload: { model: "model-a", effort: "high" } }]);
    await f.rollout("native-b", B, "2026-10-13T10:00:01.100Z", [completed("turn-b", "answer b"),
      { type: "turn_context", payload: { model: "model-b", effort: "low" } }]);
    const inputs = [f.input(A), f.input(B, "2026-10-13T10:00:01.000Z")];
    if (reverse) inputs.reverse();
    const results = await Promise.all(inputs.map((input) => f.store.observeProviderTurns(input)));
    for (const result of results) {
      expect(result).toMatchObject({ nativeSourceAvailable: true, nativeSessionId: result.sessionId === A ? "native-a" : "native-b",
        turns: [{ providerTurnId: result.sessionId === A ? "turn-a" : "turn-b" }] });
    }
    expect((await f.bindings.read(A))?.nativeSessionId).toBe("native-a");
    expect((await f.bindings.read(B))?.nativeSessionId).toBe("native-b");
    expect(await f.store.readObservedModel(f.input(A))).toMatchObject({ model: "model-a", effort: "high" });
    expect(await f.store.readObservedModel(f.input(B))).toMatchObject({ model: "model-b", effort: "low" });
  });

  it("captures a delayed native launch beyond the old 30-second window", async () => {
    const f = await fixture();
    await f.rollout("delayed", A, "2026-10-13T10:03:00.000Z", [completed("late-turn", "late result")]);
    expect(await f.store.observeProviderTurns(f.input())).toMatchObject({ nativeSourceAvailable: true,
      turns: [{ providerTurnId: "late-turn", text: "late result" }] });
    expect(new CodexProviderAdapter({ sessionsDirectory: f.sessions }).buildResumeSpec({
      ...f.input(), id: A, sandbox: "read-only",
    } as unknown as SessionRecord).args.at(-1)).toBe("delayed");
  });

  it("recovers durable exact identity after restart without a launch-time search", async () => {
    const f = await fixture();
    const path = await f.rollout("native-a", A, T, [completed("turn-a", "first")]);
    await f.store.captureProviderTurns(f.input());
    const restarted = new ThreadTranscriptStore(f.root, { ...f.options, codexSessionsDirectory: join(f.root, "missing") });
    await appendFile(path, jsonl([{ type: "event_msg", timestamp: "2026-10-13T10:05:00.000Z",
      payload: { type: "task_complete", turn_id: "turn-next", last_agent_message: "next" } }]));
    const input = { ...f.input(), turnNumber: 2 };
    expect(await restarted.observeProviderTurns(input)).toMatchObject({ nativeSessionId: "native-a",
      turns: [{ providerTurnId: "turn-next" }] });
    expect(new CodexProviderAdapter({ sessionsDirectory: join(f.root, "missing"), codexConversations: f.bindings })
      .buildResumeSpec({ ...f.input(), id: A, sandbox: "read-only" } as unknown as SessionRecord).args.at(-1)).toBe("native-a");
  });

  it("recovers completion ordinals and canonical count after semantic journal rotation", async () => {
    const f = await fixture();
    const options = { ...f.options, maxBytes: 1024, retainedFiles: 1 };
    const store = new ThreadTranscriptStore(f.root, options);
    const path = await f.rollout("rotated", A);
    for (let turn = 1; turn <= 8; turn++) {
      await appendFile(path, jsonl([{ type: "event_msg", timestamp: T,
        payload: { type: "task_complete", turn_id: `turn-${turn}`, last_agent_message: "result ".repeat(70) } }]));
      expect(await store.captureProviderTurns({ ...f.input(), turnNumber: turn })).toHaveLength(1);
    }
    const restarted = new ThreadTranscriptStore(f.root, options);
    expect(await restarted.readCompletionLedger(A)).toMatchObject({ completedTurns: 8, canonicalTurns: 8,
      providerOccurredThrough: T });
    expect(await restarted.captureProviderTurns({ ...f.input(), turnNumber: 9 })).toEqual([]);
    await appendFile(path, jsonl([{ type: "event_msg", timestamp: T,
      payload: { type: "task_complete", turn_id: "turn-9" } }]));
    expect(await restarted.captureProviderTurns({ ...f.input(), turnNumber: 9 })).toMatchObject([{
      text: "", data: { semanticTurnId: "codex:turn-9", turnNumber: 9, canonicalTurns: 9 },
    }]);
  });

  it("refuses cwd/time-only discovery and user/assistant quotations of a marker", async () => {
    const f = await fixture();
    await f.rollout("unbound", undefined, T, [marker(A, "user"), marker(A, "assistant"), completed("foreign", "foreign answer")]);
    expect(await f.store.observeProviderTurns(f.input())).toMatchObject({ nativeSourceAvailable: false, nativeActivity: "unknown", turns: [] });
    expect(await f.store.readTranscriptMessages(f.input())).toEqual([]);
    expect(() => new CodexProviderAdapter({ sessionsDirectory: f.sessions }).buildResumeSpec({
      ...f.input(), id: A, sandbox: "read-only",
    } as unknown as SessionRecord)).toThrow("one exact");
  });

  it("ignores built-in subagent rollouts that inherit the launch marker", async () => {
    const f = await fixture();
    await f.rollout("primary", A, T, [completed("primary-turn", "parent answer")]);
    await writeFile(join(f.day, "rollout-child.jsonl"), jsonl([{ type: "session_meta", payload: {
      id: "child", timestamp: T, cwd, originator: "codex-tui",
      source: { subagent: { thread_spawn: { parent_thread_id: "primary", depth: 1 } } },
    } }, marker(A), completed("child-turn", "child answer")]));
    expect(await f.store.observeProviderTurns(f.input())).toMatchObject({ nativeSessionId: "primary",
      turns: [{ providerTurnId: "primary-turn" }] });
    expect(new CodexProviderAdapter({ sessionsDirectory: f.sessions }).buildResumeSpec({
      ...f.input(), id: A, sandbox: "read-only",
    } as unknown as SessionRecord).args.at(-1)).toBe("primary");
  });

  it("refuses multiple native conversations claiming the same actor", async () => {
    const f = await fixture();
    for (const nativeId of ["one", "two"]) await f.rollout(nativeId, A, T, [completed(nativeId, "result")]);
    expect(await f.store.observeProviderTurns(f.input())).toMatchObject({ nativeSourceAvailable: false, turns: [] });
    expect(await f.bindings.read(A)).toBeUndefined();
    expect(() => new CodexProviderAdapter({ sessionsDirectory: f.sessions }).buildResumeSpec({
      ...f.input(), id: A, sandbox: "read-only",
    } as unknown as SessionRecord)).toThrow("one exact");
  });

  it("refuses every durable claimant of one native identity after restart", async () => {
    const f = await fixture();
    const path = await f.rollout("shared", undefined, T, [completed("shared-turn", "foreign")]);
    for (const sessionId of [A, B]) await f.bindings.record({ sessionId, nativeSessionId: "shared", cwd, transcriptPath: path });
    for (const sessionId of [B, A]) expect(await f.store.observeProviderTurns(f.input(sessionId)))
      .toMatchObject({ nativeSourceAvailable: false, turns: [] });
    expect(() => new CodexProviderAdapter({ codexConversations: f.bindings }).buildResumeSpec({
      ...f.input(), id: A, sandbox: "read-only",
    } as unknown as SessionRecord)).toThrow("exact Codex conversation binding");
  });

  it("drops a retired exact claimant without deleting its provider transcript", async () => {
    const f = await fixture();
    const path = await f.rollout("owned", undefined, T, [completed("turn", "answer")]);
    for (const sessionId of [A, B]) await f.bindings.record({ sessionId, nativeSessionId: "owned", cwd, transcriptPath: path });
    await f.store.dropCodexBinding(B);
    expect(await f.bindings.read(B)).toBeUndefined();
    expect(await f.store.observeProviderTurns(f.input())).toMatchObject({ nativeSourceAvailable: true,
      turns: [{ providerTurnId: "turn" }] });
  });

  it("refuses one native identity whose serialized launch records name different actors", async () => {
    const f = await fixture();
    const path = await f.rollout("shared-id", A, T, [completed("turn", "first")]);
    await writeFile(join(f.day, "rollout-copy.jsonl"), jsonl([{ type: "session_meta",
      payload: { id: "shared-id", timestamp: T, cwd, originator: "codex-tui" } }, marker(B)]));
    for (const sessionId of [A, B]) expect(await f.store.observeProviderTurns(f.input(sessionId)))
      .toMatchObject({ nativeSourceAvailable: false, turns: [] });
    expect(await f.bindings.read(A)).toBeUndefined();
    expect(path).toContain("shared-id");
  });

  it("waits for a complete developer marker instead of claiming an unfinished header", async () => {
    const f = await fixture();
    const path = await f.rollout("partial", undefined);
    const frame = JSON.stringify(marker(A));
    await appendFile(path, frame.slice(0, -8));
    expect(await f.store.observeProviderTurns(f.input())).toMatchObject({ nativeSourceAvailable: false, turns: [] });
    await appendFile(path, frame.slice(-8) + "\n" + jsonl([started("first-turn")]));
    expect(await f.store.observeProviderTurns(f.input())).toMatchObject({ nativeSourceAvailable: true, nativeActivity: "working", turns: [] });
  });

  it("marks an inflight native source available and working without fabricating fallback:1", async () => {
    const f = await fixture();
    const path = await f.rollout("inflight", A, T, [started("working-turn"),
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "working" }] } }]);
    const input = { ...f.input(), allowFallback: true, fallbackText: "fabricated completion" };
    const first = await f.store.observeProviderTurns(input);
    expect(first).toMatchObject({ nativeSourceAvailable: true, nativeActivity: "working", turns: [],
      nativeActivityEvidence: { id: "task_started:working-turn", kind: "task_started", providerTurnId: "working-turn" } });
    expect(await f.store.captureProviderTurns(input)).toEqual([]);
    await appendFile(path, jsonl([completed("working-turn", "actual final")]));
    const next = await f.store.observeProviderTurns(input);
    expect(next.activityVersion).not.toBe(first.activityVersion);
    expect(next).toMatchObject({ nativeSourceAvailable: true, nativeActivity: "idle",
      turns: [{ providerTurnId: "working-turn", transport: "provider-native" }] });
  });

  it("keeps idle completion distinct from a newer running native turn", async () => {
    const f = await fixture();
    await f.rollout("overlap", A, T, [started("new-turn"), completed("old-turn", "old answer")]);
    expect(await f.store.observeProviderTurns(f.input())).toMatchObject({ nativeActivity: "working",
      nativeActivityEvidence: { providerTurnId: "new-turn" }, turns: [{ providerTurnId: "old-turn" }] });
  });

  it("observes an aborted turn as idle with a negative source receipt", async () => {
    const f = await fixture();
    await f.rollout("aborted", A, T, [started("interrupted-turn"), {
      type: "event_msg", timestamp: "2026-10-13T10:00:04.000Z", payload: { type: "turn_aborted", turn_id: "interrupted-turn" },
    }]);
    expect(await f.store.observeProviderTurns({ ...f.input(), allowFallback: true })).toMatchObject({
      nativeSourceAvailable: true, nativeActivity: "idle", nativeActivityEvidence: { kind: "turn_aborted" }, turns: [expect.objectContaining({ data: expect.objectContaining({ outcome: "cancelled" }) })],
    });
  });

  it("recovers the exact abort frame boundary when the engine banks a negative native closure", async () => {
    const f = await fixture();
    const path = await f.rollout("aborted-ordinal", A, T, [started("cancelled-turn"), {
      type: "event_msg", timestamp: "2026-10-13T10:00:04.000Z", payload: { type: "turn_aborted", turn_id: "cancelled-turn" },
    }]);
    const aborted = await f.store.observeProviderTurns(f.input());
    expect(aborted.turns).toMatchObject([{ data: { outcome: "cancelled" } }]);
    await f.store.commitProviderTurns({ ...aborted, turns: [{ providerTurnId: "cancelled-turn",
      providerOccurredAt: aborted.nativeActivityEvidence!.occurredAt!, text: "cancelled", transport: "provider-native",
      data: { ...aborted.nativeActivityEvidence!.receiptData, outcome: "cancelled", nativeActivityId: aborted.nativeActivityEvidence!.id } }] });
    await appendFile(path, jsonl([{ type: "event_msg", timestamp: "2026-10-13T10:00:05.000Z",
      payload: { type: "task_complete", turn_id: "next-turn", last_agent_message: "next" } }]));
    const restarted = new ThreadTranscriptStore(f.root, f.options);
    expect(await restarted.captureProviderTurns({ ...f.input(), turnNumber: 2 })).toMatchObject([{
      text: "next", data: { turnNumber: 2, semanticTurnId: "codex:next-turn" },
    }]);
  });

  it("acks the original ordinal/outcome when a late abort repeats an already completed native turn ID", async () => {
    const f = await fixture();
    const path = await f.rollout("late-abort", A, T, [completed("already-done", "actual answer")]);
    await f.store.captureProviderTurns(f.input());
    await appendFile(path, jsonl([{ type: "event_msg", timestamp: "2026-10-13T10:00:05.000Z",
      payload: { type: "turn_aborted", turn_id: "already-done" } }]));
    const late = await f.store.observeProviderTurns({ ...f.input(), turnNumber: 2 });
    const receipts = await f.store.commitProviderTurns({ ...late, turns: [{ providerTurnId: "already-done",
      providerOccurredAt: late.nativeActivityEvidence!.occurredAt!, text: "cancelled", transport: "provider-native",
      data: { ...late.nativeActivityEvidence!.receiptData, outcome: "cancelled", nativeActivityId: late.nativeActivityEvidence!.id } }] });
    expect(receipts).toMatchObject([{ text: "actual answer", data: { turnNumber: 1, semanticTurnId: "codex:already-done" } }]);
    expect(receipts[0]!.data?.outcome).toBeUndefined();
    expect(await f.store.readCompletionLedger(A)).toMatchObject({ completedTurns: 1, canonicalTurns: 1 });
    expect((await f.store.read(A)).events).toHaveLength(1);
  });

  it.each([undefined, null, "", "   "])("retains authoritative textless task_complete with last_agent_message=%s", async (text) => {
    const f = await fixture();
    await f.rollout("textless", A, T, [started("empty-turn"), completed("empty-turn", text)]);
    expect(await f.store.captureProviderTurns(f.input())).toMatchObject([{ text: text ?? "", data: {
      semanticTurnId: "codex:empty-turn", turnNumber: 1, transport: "provider-native",
    } }]);
    expect(await f.store.captureProviderTurns({ ...f.input(), turnNumber: 2, allowFallback: true })).toEqual([]);
    const restarted = new ThreadTranscriptStore(f.root, f.options);
    expect(await restarted.captureProviderTurns({ ...f.input(), turnNumber: 2 })).toEqual([]);
    expect(await restarted.readCompletionLedger(A)).toMatchObject({ completedTurns: 1, canonicalTurns: 1 });
  });

  it("reports missing or replaced bound sources as unavailable instead of reading cached turns/model/preview", async () => {
    const f = await fixture();
    const path = await f.rollout("source", A, T, [completed("turn", "done"),
      { type: "turn_context", payload: { model: "gpt-observed", effort: "high" } }]);
    await f.store.observeProviderTurns(f.input());
    expect(await f.store.readObservedModel(f.input())).toMatchObject({ model: "gpt-observed" });
    await unlink(path);
    expect(await f.store.observeProviderTurns(f.input())).toMatchObject({ nativeSourceAvailable: false, nativeActivity: "unknown", turns: [] });
    expect(await f.store.readObservedModel(f.input())).toBeUndefined();
    expect(await f.store.readTranscriptMessages(f.input())).toEqual([]);
    await f.rollout("source", undefined, T, [completed("foreign-turn", "foreign")]);
    await writeFile(path, jsonl([{ type: "session_meta", payload: { id: "replaced", timestamp: T, cwd, originator: "codex-tui" } }]));
    expect(await f.store.observeProviderTurns(f.input())).toMatchObject({ nativeSourceAvailable: false, turns: [] });
  });
});
