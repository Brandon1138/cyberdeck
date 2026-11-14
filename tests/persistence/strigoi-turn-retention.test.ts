import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { composeStrigoiEvidence } from "../../src/persistence/strigoi-evidence-runtime.js";
import { ThreadTranscriptStore } from "../../src/persistence/thread-transcript-store.js";
import { StrigoiTurns } from "../../src/orchestration/strigoi-turns.js";
import { fixture, actor, identity } from "../orchestration/strigoi-admission-fixture.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "strigoi-turn-retention-")); roots.push(root);
  const f = fixture(), evidence = composeStrigoiEvidence(root);
  await evidence.orchestratorStore.strigoi.compareAndSwap(0, "activate", f.state());
  const transcripts = new ThreadTranscriptStore(root, { continuity: evidence.transcriptContinuity, maxBytes: 1500, retainedFiles: 1 });
  const submitInstruction = vi.fn(async (_session: string, _text: string, _source: unknown, metadata: unknown, instructionId?: string) => {
    await transcripts.append({ sessionId: actor, kind: "instruction", source: "broker", data: {
      ...metadata as object, instructionId, instructionState: "rendered", expectedTurn: 1 } });
    return { state: "rendered" as const, expectedTurn: 1, at: new Date().toISOString() };
  });
  const registry = { ...f.registry, workerTruth: () => ({ state: "idle" as const } as never), submitInstruction };
  const makeTurns = () => {
    const reopened = composeStrigoiEvidence(root);
    return new StrigoiTurns(registry, new ThreadTranscriptStore(root, { maxBytes: 1500, retainedFiles: 1 }),
      async () => "internal instruction", sessionId => reopened.turnEvents(sessionId));
  };
  const turns = new StrigoiTurns(registry, transcripts, async () => "internal instruction", sessionId => evidence.turnEvents(sessionId));
  const rotate = async () => {
    for (let i = 0; i < 8; i++) await transcripts.append({ sessionId: randomUUID(), kind: "output", source: "provider", text: "unrelated".repeat(110) });
    expect((await transcripts.read(actor)).events).toEqual([]);
  };
  return { evidence, transcripts, turns, makeTurns, rotate, submitInstruction };
}

it.each(["checkpoint", "adoption"] as const)("recovers completed %s after unrelated rotation and reopen without submitting again", async kind => {
  const f = await setup(), id = randomUUID();
  await f.turns.submit(id, identity, kind, undefined, async apply => apply());
  const result = kind === "checkpoint" ? { checkpoint: "original context\n".repeat(1900) } : {
    identity, packetHash: "a".repeat(64), coverageId: randomUUID(), handledSourceIds: [], account: "Retained context" };
  const preview = await f.transcripts.append({ sessionId: actor, kind: "turn", source: "provider", text: JSON.stringify(result),
    data: { transport: "provider-native", turnNumber: 1 } });
  // Startup source inventory may recapture the bounded preview under the same event ID.
  await f.evidence.sources.event(preview);
  await f.rotate();
  const reopened = f.makeTurns();
  expect(await reopened.observe(id, identity)).toEqual({ outcome: "completed", ...(kind === "checkpoint" ? result : { adoption: result }) });
  await reopened.submit(id, identity, kind, undefined, async apply => apply());
  expect(f.submitInstruction).toHaveBeenCalledOnce();
  expect(await reopened.observe(id, { ...identity, generation: 2 })).toEqual({ outcome: "unknown" });
});

it.each(["missing", "identity"] as const)("fails closed on %s archived evidence without submitting again", async mode => {
  const f = await setup(), id = randomUUID();
  await f.turns.submit(id, identity, "checkpoint", undefined, async apply => apply());
  const refs = await f.evidence.archive.list();
  if (mode === "missing") {
    const artifact = await f.evidence.artifactStore.read(refs[0]!.copy!.artifactId);
    if (artifact.descriptor.content.kind !== "file") throw new Error("Expected file");
    await rm(artifact.descriptor.content.path);
  } else {
    const eventId = randomUUID();
    await f.evidence.archive.capture("instruction", `thread:${eventId}`, {
      id: eventId, cursor: 9, sessionId: randomUUID(), occurredAt: new Date().toISOString(), kind: "instruction", source: "broker",
      data: { instructionId: id, generation: 1 } }, [actor]);
  }
  await f.rotate();
  const reopened = f.makeTurns();
  await expect(reopened.observe(id, identity)).rejects.toThrow();
  await expect(reopened.submit(id, identity, "checkpoint", undefined, async apply => apply())).rejects.toThrow();
  expect(f.submitInstruction).toHaveBeenCalledOnce();
});

it("retains an ambiguous intent across rotation without inventing completion or resending", async () => {
  const f = await setup(), id = randomUUID();
  f.submitInstruction.mockRejectedValueOnce(new Error("lost write outcome"));
  await expect(f.turns.submit(id, identity, "checkpoint", undefined, async apply => apply())).rejects.toThrow("lost write outcome");
  await f.rotate();
  const reopened = f.makeTurns();
  expect(await reopened.observe(id, identity)).toEqual({ outcome: "unknown" });
  await reopened.submit(id, identity, "checkpoint", undefined, async apply => apply());
  expect(f.submitInstruction).toHaveBeenCalledOnce();
});
