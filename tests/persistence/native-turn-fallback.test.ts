import { appendFile, mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ThreadTranscriptStore } from "../../src/persistence/thread-transcript-store.js";
import { codexSessionMarker } from "../../src/providers/codex/native-session-identity.js";

const sessionId = "11111111-1111-4111-8111-111111111111";
const cwd = "/tmp/repo", createdAt = "2026-07-25T10:00:00.000Z";
async function fixture(provider: "claude" | "codex") {
  const root = await mkdtemp(join(tmpdir(), "cyberdeck-native-fallback-"));
  const claudeProjectsDirectory = join(root, "claude-projects"), codexSessionsDirectory = join(root, "codex-sessions");
  const directory = provider === "claude" ? join(claudeProjectsDirectory, "-tmp-repo") : join(codexSessionsDirectory, "2026", "07", "25");
  await mkdir(directory, { recursive: true });
  const path = join(directory, provider === "claude" ? `${sessionId}.jsonl` : "rollout.jsonl");
  const lines = provider === "claude"
    ? [{ type: "assistant", timestamp: createdAt, message: { id: "native-turn", role: "assistant", stop_reason: "end_turn",
      content: [{ type: "text", text: "native completion" }] } },
      { type: "system", subtype: "turn_duration", timestamp: createdAt }]
    : [{ type: "session_meta", payload: { id: "rollout", timestamp: createdAt, cwd, originator: "codex-tui" } },
      { type: "response_item", payload: { type: "message", role: "developer",
        content: [{ type: "input_text", text: codexSessionMarker(sessionId) }] } },
      { type: "event_msg", timestamp: createdAt, payload: { type: "task_complete", turn_id: "native-turn", last_agent_message: "native completion" } }];
  await writeFile(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  const options = { claudeProjectsDirectory, codexSessionsDirectory };
  return { root, path, options, store: new ThreadTranscriptStore(root, options),
    input: { sessionId, provider, cwd, createdAt, turnNumber: 1, allowFallback: true, fallbackText: "duplicate fallback" } };
}

it.each(["claude", "codex"] as const)("does not manufacture a fallback receipt after an identical %s native capture", async (provider) => {
  const { root, store, input } = await fixture(provider);
  try {
    await expect(store.captureProviderTurns(input)).resolves.toMatchObject([{ data: { semanticTurnId: `${provider}:native-turn`, turnNumber: 1 } }]);
    await expect(store.captureProviderTurns(input)).resolves.toEqual([]);
    // A fully committed native log remains available even when there are no unseen turns.
    await expect(store.captureProviderTurns({ ...input, turnNumber: 2 })).resolves.toEqual([]);
    expect((await store.read(sessionId)).events).toHaveLength(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.each(["claude", "codex"] as const)("fences fallback against a durable %s native ordinal after restart and log disappearance", async (provider) => {
  const { root, path, store, options, input } = await fixture(provider);
  try {
    await store.captureProviderTurns(input);
    await unlink(path);
    const restarted = new ThreadTranscriptStore(root, options);
    await expect(restarted.captureProviderTurns(input)).resolves.toEqual([]);
    expect((await restarted.read(sessionId)).events).toHaveLength(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("observes in-flight Claude prompts and end_turn candidates before authoritative turn_duration", async () => {
  const { root, path, store, options, input } = await fixture("claude");
  try {
    const userAt = "2026-07-25T10:00:00.000Z", assistantAt = "2026-07-25T10:00:01.000Z";
    await writeFile(path, JSON.stringify({ type: "user", uuid: "prompt-frame", timestamp: userAt,
      message: { role: "user", content: [{ type: "text", text: "do the task" }] } }) + "\n");
    const working = await store.observeProviderTurns(input);
    expect(working).toMatchObject({ nativeSourceAvailable: true, nativeActivity: "working", turns: [],
      nativeActivityEvidence: { id: "prompt-frame", kind: "user", occurredAt: userAt } });
    expect(working.activityVersion).toBeDefined();
    await appendFile(path, JSON.stringify({ type: "assistant", uuid: "candidate-frame", timestamp: assistantAt,
      message: { id: "native-turn", role: "assistant", stop_reason: "end_turn",
        content: [{ type: "text", text: "candidate final" }] } }) + "\n");
    const candidate = await store.observeProviderTurns(input);
    expect(candidate).toMatchObject({ nativeSourceAvailable: true, nativeActivity: "working", turns: [],
      nativeActivityEvidence: { id: "candidate-frame", kind: "assistant", occurredAt: assistantAt } });
    expect(candidate.activityVersion).not.toBe(working.activityVersion);
    expect(await store.captureProviderTurns(input)).toEqual([]);
    const reopened = new ThreadTranscriptStore(root, options);
    expect(await reopened.observeProviderTurns(input)).toMatchObject({ nativeSourceAvailable: true,
      nativeActivity: "working", nativeActivityEvidence: { id: "candidate-frame" }, turns: [] });
    await appendFile(path, JSON.stringify({ type: "system", subtype: "turn_duration", uuid: "stop-frame",
      timestamp: "2026-07-25T10:00:02.000Z" }) + "\n");
    expect(await reopened.observeProviderTurns(input)).toMatchObject({ nativeSourceAvailable: true,
      nativeActivity: "idle", nativeActivityEvidence: { kind: "turn_duration", id: "native-turn" },
      turns: [{ providerTurnId: "native-turn", transport: "provider-native", text: "candidate final" }] });
    expect(await reopened.captureProviderTurns(input)).toMatchObject([{ data: { turnNumber: 1 } }]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("keeps an exact empty Claude source available with unknown activity before its first complete frame", async () => {
  const { root, path, store, input } = await fixture("claude");
  try {
    await writeFile(path, "");
    const empty = await store.observeProviderTurns(input);
    expect(empty).toMatchObject({ nativeSourceAvailable: true, nativeActivity: "unknown", turns: [] });
    expect(empty.activityVersion).toBeDefined();
    await writeFile(path, JSON.stringify({ type: "assistant", uuid: "incomplete", timestamp: createdAt,
      message: { role: "assistant", content: [] } }));
    expect(await store.observeProviderTurns(input)).toMatchObject({ nativeSourceAvailable: true,
      nativeActivity: "unknown", activityVersion: empty.activityVersion, turns: [] });
  } finally { await rm(root, { recursive: true, force: true }); }
});
