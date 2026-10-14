import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SessionRecord } from "../../src/domain/session.js";
import { ThreadTranscriptStore } from "../../src/persistence/thread-transcript-store.js";

export async function codexLaunchFixture() {
  const root = await mkdtemp(join(tmpdir(), "cyberdeck-launch-attribution-"));
  const codexSessionsDirectory = join(root, "sessions");
  const day = join(codexSessionsDirectory, "2026", "10", "13");
  await mkdir(day, { recursive: true });
  const records = [0, 1].map((second) => ({ id: randomUUID(), initialInstructionId: randomUUID(), provider: "codex",
    cwd: root, createdAt: `2026-10-13T10:00:0${second}.000Z`, updatedAt: "2026-10-13T10:00:01.000Z",
    executionState: "active", attachmentState: "detached", detached: true, sandbox: "workspace-write", pid: 4242,
    exitCode: null, childIds: [], attentionState: "working" }) as SessionRecord);
  const [a, b] = records as [SessionRecord, SessionRecord];
  const options = { codexSessionsDirectory };
  const store = new ThreadTranscriptStore(root, options);
  for (const [index, record] of records.entries()) {
    await store.append({ sessionId: record.id, kind: "prompt", source: "orchestrator", text: `${index === 0 ? "A" : "B"} BRIEF`,
      data: { initial: true, instructionId: record.initialInstructionId, expectedTurn: 1 } });
  }
  const path = (label: string) => join(day, `${label}.jsonl`);
  const metadata = async (label: string, at: string) => writeFile(path(label), JSON.stringify({ type: "session_meta",
    payload: { id: label, timestamp: at, cwd: root, originator: "codex-tui" } }) + "\n");
  const complete = async (label: string, prompt: string, context = false) => appendFile(path(label), [
    context ? { type: "turn_context", payload: { developer_instructions: prompt } }
      : { type: "event_msg", payload: { type: "user_message", message: prompt } },
    { type: "event_msg", timestamp: "2026-10-13T10:00:05.000Z", payload: { type: "task_complete", turn_id: label, last_agent_message: `${label} ANSWER` } },
  ].map((frame) => JSON.stringify(frame)).join("\n") + "\n");
  const input = (record: SessionRecord) => ({ sessionId: record.id, provider: record.provider, cwd: record.cwd,
    createdAt: record.createdAt, initialInstructionId: record.initialInstructionId, turnNumber: 1, allowFallback: false });
  return { root, store, options, a, b, metadata, complete, input };
}
