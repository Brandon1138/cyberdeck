import { mkdtemp, mkdir, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { composeStrigoiEvidence } from "../../src/persistence/strigoi-evidence-runtime.js";
import { ThreadTranscriptStore } from "../../src/persistence/thread-transcript-store.js";
import { ExecutionTranscriptStore } from "../../src/persistence/execution-transcript-store.js";
import { ContainerNativeSource } from "../../src/runtime/activity/container-native-source.js";
import { SessionStore } from "../../src/persistence/session-store.js";
import { CodexConversationBindingStore } from "../../src/persistence/codex-conversation-bindings.js";
import { retainStartupThreads } from "../../src/orchestration/startup-thread-retention.js";
import { StrigoiContinuity } from "../../src/orchestration/strigoi-continuity.js";
import { StrigoiAdmission } from "../../src/orchestration/strigoi-admission.js";
import { SessionRegistry } from "../../src/broker/session-registry.js";
import { WorkerTurnObservationAdapter } from "../../src/runtime/worker-turn-observation-adapter.js";
import { BrokerRuntimeConfigSchema } from "../../src/config.js";
import { SessionRecordSchema } from "../../src/domain/session.js";
import { attentionHarness, cleanupAttentionHarnesses } from "../support/attention-harness.js";
import { fixture, identity, actor, target, at } from "../orchestration/strigoi-admission-fixture.js";
const roots: string[] = [];
afterEach(async () => { await cleanupAttentionHarnesses(); vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "strigoi-sources-")); roots.push(root);
  const f = fixture(), evidence = composeStrigoiEvidence(root), sessions = new SessionStore(root);
  await evidence.orchestratorStore.strigoi.compareAndSwap(0, "activate", f.state());
  const record = SessionRecordSchema.parse({ ...f.registry.get(actor), executionState: "exited", exitCode: 0,
    createdAt: "2020-01-01T00:00:00.000Z", updatedAt: "2020-01-01T00:00:00.000Z" });
  await sessions.put(record);
  const native = join(root, "native"); await mkdir(native);
  const bindings = new CodexConversationBindingStore(root);
  const options = { codexSessionsDirectory: native, codexConversations: bindings, continuity: evidence.transcriptContinuity, maxBytes: 1500, retainedFiles: 1 };
  const transcripts = new ThreadTranscriptStore(root, options);
  await evidence.startup(transcripts, sessions);
  const continuity = new StrigoiContinuity({ repository: evidence.orchestratorStore.strigoi, bindings: evidence.orchestratorStore,
    admission: new StrigoiAdmission(evidence.orchestratorStore.strigoi, evidence.orchestratorStore, f.registry), packets: evidence.packets, sources: evidence.sources });
  return { root, f, record, evidence, transcripts, options, sessions, native, bindings, continuity };
}
it("captures full original operator turns before rotation, without a model checkpoint", async () => {
  const f = await setup(), original = "Do not publish. ș😀".repeat(2000);
  await f.transcripts.append({ sessionId: actor, kind: "prompt", source: "human", text: original });
  for (let i = 0; i < 12; i++) await f.transcripts.append({ sessionId: actor, kind: "turn", source: "provider", text: `reply-${i}`.repeat(70) });
  expect((await f.evidence.orchestratorStore.strigoi.read()).latestPacket).toBeUndefined();
  const reopened = composeStrigoiEvidence(f.root), transcripts = new ThreadTranscriptStore(f.root, { ...f.options, continuity: reopened.transcriptContinuity });
  const retention = await reopened.startup(transcripts, f.sessions);
  expect(retention.skipDestructiveRetention).toBe(false); expect(retention.protectedSessionIds.has(actor)).toBe(true);
  const sources = await reopened.archive.list(); await reopened.packets.verify(sources);
  const packet = await reopened.packets.write(identity, "", sources, at);
  let cursor: string | undefined, text = "";
  do { const page = await reopened.packets.read(packet, cursor); text += page.sources.map((s) => s.text).join(""); cursor = page.nextCursor; } while (cursor);
  expect(text).toContain(JSON.stringify(original).slice(1, -1));
  const cleanup = vi.fn();
  expect(await retainStartupThreads({ ...retention, catalog: f.sessions, scoutReports: { remove: cleanup }, claudeBindings: { dropClaudeBinding: cleanup, dropCodexBinding: cleanup, dropTurnLedger: cleanup } },
    { maxAgeDays: 1, maxThreads: 0, keepPinned: false }, Date.now())).toHaveLength(1);
  expect(cleanup).not.toHaveBeenCalled();
});
it("captures native operator messages beyond the preview window and survives loss of the original", async () => {
  const f = await setup(), path = join(f.native, "rollout.jsonl");
  const nativeId = "44444444-4444-4444-8444-444444444444";
  await f.bindings.record({ sessionId: actor, nativeSessionId: nativeId, transcriptPath: path, cwd: "/repo" });
  await writeFile(path, [JSON.stringify({ type: "session_meta", payload: { id: nativeId, timestamp: at, cwd: "/repo", originator: "codex-tui" } }),
    ...Array.from({ length: 35 }, (_, i) => JSON.stringify({ type: "response_item", timestamp: at,
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: `Original constraint ${i}` }] } }))].join("\n") + "\n");
  const pins = await f.evidence.startup(f.transcripts, f.sessions); expect(pins.skipDestructiveRetention).toBe(false);
  const nativeCopies = (await f.evidence.archive.list()).filter((s) => s.id.startsWith("native:")); expect(nativeCopies).toHaveLength(35);
  await rm(path);
  const reopened = composeStrigoiEvidence(f.root);
  const retention = await reopened.startup(new ThreadTranscriptStore(f.root, { ...f.options, continuity: reopened.transcriptContinuity }), f.sessions);
  expect(retention.skipDestructiveRetention).toBe(false); await reopened.packets.verify(await reopened.archive.list());
  expect((await stat(reopened.archive.path)).mode & 0o777).toBe(0o600);
});
it("holds on a missing bound original without any private copy", async () => {
  const f = await setup(); vi.spyOn(console, "error").mockImplementation(() => {});
  await f.bindings.record({ sessionId: actor, nativeSessionId: target, transcriptPath: join(f.native, "missing.jsonl"), cwd: "/repo" });
  expect((await f.evidence.startup(f.transcripts, f.sessions)).skipDestructiveRetention).toBe(true);
  expect((await f.evidence.orchestratorStore.strigoi.read()).hold?.code).toBe("continuity-evidence-unavailable");
});
it.each(["pins", "missing-index", "copy", "authority"])("corrupt %s skips all destructive startup retention and exposes a hold", async (kind) => {
  const f = await setup(); vi.spyOn(console, "error").mockImplementation(() => {});
  await f.transcripts.append({ sessionId: actor, kind: "prompt", source: "human", text: "Keep me" });
  if (kind === "pins") await writeFile(f.evidence.archive.path, "broken");
  if (kind === "missing-index") await rm(f.evidence.archive.path);
  if (kind === "authority") await writeFile(f.evidence.orchestratorStore.strigoi.path, "broken\n");
  if (kind === "copy") {
    const ref = (await f.evidence.archive.list())[0]!.copy!;
    const artifact = await f.evidence.artifactStore.read(ref.artifactId);
    if (artifact.descriptor.content.kind !== "file") throw new Error("file required");
    await writeFile(artifact.descriptor.content.path, "corrupt");
  }
  const reopened = composeStrigoiEvidence(f.root), retention = await reopened.startup(f.transcripts, f.sessions);
  expect(retention.skipDestructiveRetention).toBe(true);
  const cleanup = vi.fn(), compact = vi.fn();
  await retainStartupThreads({ ...retention, catalog: { load: () => f.sessions.load(), compact }, scoutReports: { remove: cleanup }, claudeBindings: { dropClaudeBinding: cleanup } },
    { maxAgeDays: 1, maxThreads: 0, keepPinned: false });
  expect(compact).not.toHaveBeenCalled(); expect(cleanup).not.toHaveBeenCalled();
  if (kind === "authority") await expect(reopened.orchestratorStore.strigoi.read()).rejects.toMatchObject({ code: "STRIGOI_CORRUPT_STATE" });
  else expect((await reopened.orchestratorStore.strigoi.read()).hold?.code).toBe("continuity-evidence-unavailable");
  await expect(reopened.beforeDelete(target)).rejects.toThrow();
});
it("captures instruction revisions and workflow obligations through production stores; pins sources without retiring workers", async () => {
  const f = await setup();
  await f.sessions.put(SessionRecordSchema.parse({ ...f.f.registry.get(target), executionState: "exited", exitCode: 0 }));
  await f.evidence.instructionStore.put(f.f.record);
  await f.evidence.instructionStore.put({ ...f.f.record, status: "submitted" });
  const run = { id: target, ownerSessionId: actor, name: "Unfinished reply", participantSessionIds: [actor, target], status: "active" as const,
    limits: { maxMessages: 100, maxTurns: 20, maxHops: 8 }, messageCount: 1, turnCount: 0, createdAt: at, updatedAt: at };
  await f.evidence.workflowStore.putRun(run);
  await f.evidence.workflowStore.putMessage({ id: actor, cursor: 1, runId: target, messageId: actor, fromSessionId: target, toSessionId: actor, text: "Pending question", wake: false, hop: 0, createdAt: at });
  const refs = await f.evidence.sources.capture(await f.evidence.orchestratorStore.strigoi.read());
  expect(refs.filter((s) => s.kind === "instruction" && s.id === f.f.record.id)).toHaveLength(2);
  expect(refs.filter((s) => s.kind === "workflow")).toHaveLength(2);
  const packet = await f.continuity.checkpoint(identity, "Remember pending question", [], "checkpoint");
  expect(packet.coverageId).toBeTruthy(); expect((await f.evidence.orchestratorStore.strigoi.retentionPins()).has(target)).toBe(false);
  expect((await f.evidence.archive.pins()).has(target)).toBe(true);
  await expect(f.evidence.beforeDelete(target)).rejects.toThrow("STRIGOI_EVIDENCE_REFERENCED");
});
it("rejects explicit deletion before retiring execution or dropping native/turn evidence", async () => {
  const f = await setup(), retire = vi.fn();
  for (const drop of [() => f.transcripts.dropCodexBinding(actor), () => f.transcripts.dropClaudeBinding(actor), () => f.transcripts.dropTurnLedger(actor)]) await expect(drop()).rejects.toThrow();
  const registry = new SessionRegistry({ adapters: {}, sessionRuntimeFactory: () => { throw new Error("No launch"); }, journal: { append: async () => {} },
    workerTurnObservation: new WorkerTurnObservationAdapter(), recoveredSessions: [f.record], config: BrokerRuntimeConfigSchema.parse({}),
    store: f.sessions });
  await registry.ready();
  // The lifecycle guard must run before the existing deletion callback (which can remove artifacts).
  registry.setResidentLifecycle({ validateReservation: async () => {}, beforeStop: async () => {}, beforeResume: async () => {}, beforeDelete: f.evidence.beforeDelete });
  await expect(registry.delete(actor, retire)).rejects.toThrow("STRIGOI_EVIDENCE_REFERENCED");
  expect(retire).not.toHaveBeenCalled(); expect(registry.get(actor).id).toBe(actor);
  await registry.stopAll();
});
it("replays checkpoint and adoption mutations after reopening canonical authority", async () => {
  const f = await setup();
  await f.transcripts.append({ sessionId: actor, kind: "prompt", source: "human", text: "Original" });
  const packet = await f.continuity.checkpoint(identity, "Intent", [], "checkpoint-a");
  const page = await f.continuity.read(identity, packet);
  const adoption = { identity, packetHash: packet.sha256, coverageId: packet.coverageId, handledSourceIds: page.sources.map((s) => s.coverageSourceId!), account: "Keep intent; check new results" };
  await f.continuity.acknowledge(adoption, "adopt-a");
  const revision = (await f.evidence.orchestratorStore.strigoi.read()).revision;
  const reopened = composeStrigoiEvidence(f.root);
  reopened.sources.attach(f.transcripts, () => f.sessions.load());
  const service = new StrigoiContinuity({ repository: reopened.orchestratorStore.strigoi, bindings: reopened.orchestratorStore,
    admission: new StrigoiAdmission(reopened.orchestratorStore.strigoi, reopened.orchestratorStore, f.f.registry), packets: reopened.packets, sources: reopened.sources });
  expect(await service.checkpoint(identity, "Intent", [], "checkpoint-a")).toEqual(packet);
  await service.acknowledge(adoption, "adopt-a");
  expect((await reopened.orchestratorStore.strigoi.read()).revision).toBe(revision);
});

it("captures real worker receipts and exact wait revisions, including cancellation after capture", async () => {
  const h = await attentionHarness(), evidence = composeStrigoiEvidence(h.directory), state = fixture().state();
  await evidence.orchestratorStore.strigoi.compareAndSwap(0, "activate", state);
  const sessions = new SessionStore(h.directory);
  for (const id of [actor, target]) await sessions.put(h.registry.get(id));
  const transcripts = new ThreadTranscriptStore(h.directory, { codexSessionsDirectory: join(h.directory, "native"), continuity: evidence.transcriptContinuity });
  evidence.sources.attach(transcripts, () => sessions.load());
  const control = h.makeControl(evidence.attentionStore).attention;
  const armed = await control.arm(h.request());
  const firstEvent = await h.report("First worker result");
  const continuity = new StrigoiContinuity({ repository: evidence.orchestratorStore.strigoi, bindings: evidence.orchestratorStore,
    admission: new StrigoiAdmission(evidence.orchestratorStore.strigoi, evidence.orchestratorStore, h.registry), packets: evidence.packets, sources: evidence.sources });
  const packet = await continuity.checkpoint(identity, "Wait for worker", [], "checkpoint-wait");
  const refs = await evidence.archive.list();
  expect(refs.some((s) => s.kind === "attention" && s.id === armed.epoch)).toBe(true);
  expect(refs.some((s) => s.kind === "worker-event" && s.id.endsWith(firstEvent.eventId))).toBe(true);
  await control.cancel({ actorSessionId: actor, epoch: armed.epoch, reason: "Operator cancelled" });
  const later = await h.report("Later worker result");
  await continuity.acknowledge({ identity, packetHash: packet.sha256, coverageId: packet.coverageId,
    handledSourceIds: refs.map((s) => s.coverageSourceId!), account: "Read first result and recorded wait" }, "adopt-wait");
  const pending = await continuity.pending(identity);
  expect(pending.some((s) => s.kind === "attention" && s.id === armed.epoch)).toBe(true);
  expect(pending.some((s) => s.kind === "worker-event" && s.id.endsWith(later.eventId))).toBe(true);
  expect(pending.some((s) => s.id.endsWith(firstEvent.eventId) && refs.some((r) => r.coverageSourceId === s.coverageSourceId))).toBe(false);
});

it("captures every container operator message at startup before the live registry exists", async () => {
  const f = await setup();
  const session = SessionRecordSchema.parse({ ...f.record, executor: "orbstack-container",
    execution: { brokerId: actor, executionId: target, workerId: actor, sessionId: actor, generation: 1,
      executor: "orbstack-container", workspaceId: "/repo" } });
  await f.sessions.put(session);
  const source = new ContainerNativeSource(join(f.root, "containers"), f.evidence.transcriptContinuity.native);
  const directory = join(source.stateRoot(actor), ".codex", "sessions", "2026", "11", "14"); await mkdir(directory, { recursive: true });
  const path = join(directory, "rollout.jsonl");
  await writeFile(path, [JSON.stringify({ type: "session_meta", payload: { id: target, cwd: "/workspace", originator: "codex-tui" } }),
    ...Array.from({ length: 26 }, (_, i) => JSON.stringify({ type: "response_item", payload: { type: "message", role: "user",
      content: [{ type: "input_text", text: `Container constraint ${i}` }] } }))].join("\n") + "\n");
  const transcripts = new ExecutionTranscriptStore(f.root, { ...f.options, continuity: f.evidence.transcriptContinuity }, source, () => undefined);
  expect((await f.evidence.startup(transcripts, f.sessions)).skipDestructiveRetention).toBe(false);
  expect((await f.evidence.archive.list()).filter((s) => s.id.startsWith("native:"))).toHaveLength(26);
  await rm(path);
  expect((await f.evidence.startup(transcripts, f.sessions)).skipDestructiveRetention).toBe(false);
});
