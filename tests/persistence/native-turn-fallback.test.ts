import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ThreadTranscriptStore } from "../../src/persistence/thread-transcript-store.js";

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
      content: [{ type: "text", text: "native completion" }] } }]
    : [{ type: "session_meta", payload: { id: "rollout", timestamp: createdAt, cwd, originator: "codex-tui" } },
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
