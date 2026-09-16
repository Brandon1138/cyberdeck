import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ExecutionTranscriptStore } from "../../src/persistence/execution-transcript-store.js";
import { ContainerNativeSource } from "../../src/runtime/activity/container-native-source.js";
import type { SessionRecord } from "../../src/domain/session.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))); });

it("uses durable session-scoped dedupe after restart and preserves a pending turn's committed ordinal", async () => {
  const root = await mkdtemp(join(tmpdir(), "execution-projection-")); roots.push(root);
  const timestamp = "2026-09-16T10:00:00.000Z";
  const session: SessionRecord = { id: randomUUID(), provider: "codex", cwd: "/workspace", detached: true,
    sandbox: "workspace-write", createdAt: timestamp, updatedAt: timestamp, executionState: "active",
    attachmentState: "detached", pid: 0, exitCode: null, childIds: [], executor: "orbstack-container" };
  const source = new ContainerNativeSource(root);
  const projection = { turns: [{ providerTurnId: "turn-one", providerOccurredAt: timestamp, text: "answer", transport: "provider-native" as const }], messages: [], budget: {} };
  const read = vi.spyOn(source, "read").mockResolvedValue(projection);
  const input = { sessionId: session.id, provider: session.provider, cwd: session.cwd, createdAt: timestamp, turnNumber: 9 };
  let transcripts = new ExecutionTranscriptStore(root, {}, source, () => session);
  const receipt = await transcripts.commitProviderTurns(await transcripts.observeProviderTurns(input));
  expect(receipt).toHaveLength(1);
  transcripts = new ExecutionTranscriptStore(root, {}, source, () => session);
  expect((await transcripts.observeProviderTurns(input)).turns).toEqual([]);
  expect((await transcripts.read(session.id)).events).toHaveLength(1);
  const captureRunning = vi.fn(async () => undefined);
  transcripts.attachNativeCapture({ captureRunning, captureCompleted: async () => undefined });
  const pending = { sourceRoot: root, path: join(root, "native.jsonl"), fromOffset: 40, throughOffset: 80, generation: 1 };
  read.mockResolvedValue({ ...projection, pending });
  await transcripts.observeProviderTurns(input);
  expect(captureRunning).toHaveBeenCalledWith(session, pending, 10);
  const other = { ...session, id: randomUUID() };
  const otherStore = new ExecutionTranscriptStore(root, {}, source, () => other);
  expect((await otherStore.observeProviderTurns({ ...input, sessionId: other.id })).turns).toHaveLength(1);
});
