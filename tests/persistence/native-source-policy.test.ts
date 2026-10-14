import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadTranscriptStore } from "../../src/persistence/thread-transcript-store.js";
import { CodexConversationBindingStore } from "../../src/persistence/codex-conversation-bindings.js";
import { ClaudeConversationBindingStore } from "../../src/persistence/claude-conversation-bindings.js";
import { JsonlOffsetReader } from "../../src/persistence/jsonl-offset-reader.js";
import { codexSessionMarker } from "../../src/providers/codex/native-session-identity.js";

const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";
const cwd = "/tmp/repo", createdAt = "2026-10-13T10:00:00.000Z";
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const lines = (frames: unknown[]) => frames.map((frame) => JSON.stringify(frame)).join("\n") + "\n";
const codexMeta = (id = "native-a") => ({ type: "session_meta", payload: { id, cwd, timestamp: createdAt, originator: "codex-tui" } });
const marker = { type: "response_item", payload: { type: "message", role: "developer",
  content: [{ type: "input_text", text: codexSessionMarker(A) }] } };
async function fixture(provider: "codex" | "claude") {
  const root = await mkdtemp(join(tmpdir(), "native-source-policy-")); roots.push(root);
  const codexSessionsDirectory = join(root, "sessions"), claudeProjectsDirectory = join(root, "projects");
  const directory = provider === "codex" ? join(codexSessionsDirectory, "2026", "10", "13") : join(claudeProjectsDirectory, "-tmp-repo");
  await mkdir(directory, { recursive: true });
  const path = join(directory, provider === "codex" ? "rollout.jsonl" : `${A}.jsonl`);
  const codexConversations = new CodexConversationBindingStore(root), claudeConversations = new ClaudeConversationBindingStore(root);
  const options = { codexSessionsDirectory, claudeProjectsDirectory, codexConversations, claudeConversations };
  const store = new ThreadTranscriptStore(root, options);
  const input = { sessionId: A, provider, cwd, createdAt, turnNumber: 1, allowFallback: true, fallbackText: "own terminal final" };
  return { root, path, directory, options, store, input, codexConversations, claudeConversations };
}

describe("host native source fallback policy", () => {
  it.each(["codex", "claude"] as const)("preserves explicitly authorized absent-source %s fallback and durable ordinal dedupe", async (provider) => {
    const f = await fixture(provider);
    expect(await f.store.observeProviderTurns({ ...f.input, allowFallback: false })).toMatchObject({
      nativeSourceAvailable: false, nativeSourceStatus: "missing", nativeFallbackAllowed: false, nativeActivity: "unknown", turns: [],
    });
    expect(await f.store.observeProviderTurns(f.input)).toMatchObject({ nativeSourceAvailable: false,
      nativeSourceStatus: "missing", nativeSourceReason: "NATIVE_SOURCE_MISSING", nativeFallbackAllowed: true,
      turns: [{ providerTurnId: "fallback:1", transport: "terminal-replay-fallback", text: "own terminal final" }] });
    await f.store.captureProviderTurns(f.input);
    const restarted = new ThreadTranscriptStore(f.root, f.options);
    expect(await restarted.observeProviderTurns(f.input)).toMatchObject({ nativeFallbackAllowed: false, turns: [] });
  });

  it("does not interpret a cwd-matching but unbound Codex rollout as absent", async () => {
    const f = await fixture("codex");
    await writeFile(f.path, lines([codexMeta(), { type: "event_msg", timestamp: createdAt,
      payload: { type: "task_complete", turn_id: "foreign-turn", last_agent_message: "foreign answer" } }]));
    expect(await f.store.observeProviderTurns(f.input)).toMatchObject({ nativeSourceAvailable: false,
      nativeSourceStatus: "unbound", nativeSourceReason: "NATIVE_CONVERSATION_UNBOUND", nativeFallbackAllowed: false, turns: [] });
    expect(await f.store.captureProviderTurns(f.input)).toEqual([]);
  });

  it("does not promote a date-window discovery miss to absence", async () => {
    const f = await fixture("codex"), late = join(f.options.codexSessionsDirectory, "2026", "10", "18");
    await mkdir(late, { recursive: true });
    const path = join(late, "late.jsonl");
    await writeFile(path, lines([codexMeta(), marker]));
    expect(await f.store.observeProviderTurns(f.input)).toMatchObject({ nativeSourceStatus: "unbound", nativeFallbackAllowed: false, turns: [] });
    await f.codexConversations.record({ sessionId: A, nativeSessionId: "native-a", cwd, transcriptPath: path });
    expect(await f.store.observeProviderTurns(f.input)).toMatchObject({ nativeSourceAvailable: true,
      nativeSourceStatus: "available", nativeFallbackAllowed: false, turns: [] });
  });

  it("refuses all Codex durable identity claimants even when fallback is explicitly requested", async () => {
    const f = await fixture("codex");
    await writeFile(f.path, lines([codexMeta(), marker]));
    for (const sessionId of [A, B]) await f.codexConversations.record({ sessionId, nativeSessionId: "native-a", cwd, transcriptPath: f.path });
    for (const sessionId of [B, A]) expect(await f.store.observeProviderTurns({ ...f.input, sessionId }))
      .toMatchObject({ nativeSourceAvailable: false, nativeSourceStatus: "conflict", nativeFallbackAllowed: false,
        nativeSourceReason: "NATIVE_BINDING_MULTIPLE_CLAIMANTS", turns: [] });
  });

  it.each(["codex", "claude"] as const)("does not treat a corrupt %s binding as a missing native source", async (provider) => {
    const f = await fixture(provider);
    const directory = provider === "codex" ? f.codexConversations.directory : f.claudeConversations.directory;
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${A}.json`), "invalid binding");
    expect(await f.store.observeProviderTurns(f.input)).toMatchObject({ nativeSourceAvailable: false,
      nativeSourceStatus: "source-error", nativeFallbackAllowed: false, turns: [] });
  });

  it("refuses a foreign-cwd Claude binding without fabricating fallback", async () => {
    const f = await fixture("claude");
    await f.claudeConversations.record({ sessionId: A, payload: { session_id: A, transcript_path: f.path, cwd: "/foreign", source: "startup" } });
    expect(await f.store.observeProviderTurns(f.input)).toMatchObject({ nativeSourceAvailable: false,
      nativeSourceStatus: "conflict", nativeSourceReason: "foreign-cwd", nativeFallbackAllowed: false, turns: [] });
  });

  it.each(["EACCES", "ENOENT"])("reports a bound native read error and forbids fallback receipts (%s)", async (code) => {
    const f = await fixture("claude");
    await writeFile(f.path, lines([{ type: "user", uuid: "prompt", timestamp: createdAt,
      message: { role: "user", content: "work" } }]));
    vi.spyOn(JsonlOffsetReader.prototype, "scan").mockRejectedValueOnce(Object.assign(new Error("read failed"), { code }));
    expect(await f.store.observeProviderTurns(f.input)).toMatchObject({ nativeSourceAvailable: false,
      nativeSourceStatus: "source-error", nativeSourceReason: code, nativeFallbackAllowed: false, nativeActivity: "unknown", turns: [] });
    expect((await f.store.read(A)).events).toEqual([]);
  });
});
