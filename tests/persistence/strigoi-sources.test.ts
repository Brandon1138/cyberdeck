import * as fs from "node:fs/promises";
import { evidenceSafety } from "../../src/persistence/strigoi-evidence-deletion.js";
import { OrchestratorManager } from "../../src/orchestration/orchestrator-manager.js";
import { OrchestratorSessionLiveness } from "../../src/orchestration/orchestrator-session-liveness.js";
import { OrchestratorControllerDirectory } from "../../src/orchestration/orchestrator-controller-directory.js";
import { ClaudeConversationBindingStore } from "../../src/persistence/claude-conversation-bindings.js";
import * as privateFiles from "../../src/persistence/private-files.js";
import * as atomic from "../../src/persistence/atomic-private-file.js";
import { StrigoiLifecycle } from "../../src/orchestration/strigoi-lifecycle.js";
import { mkdtemp, mkdir, rm, writeFile, stat, readFile, cp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
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
import { fixture, identity, actor, target, at, deferred } from "../orchestration/strigoi-admission-fixture.js";
// Forward real filesystem I/O, retaining one injectable seam for post-rename directory fsync.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: (...args: Parameters<typeof actual.open>) => actual.open(...args) };
});
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
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: i === 0 ? "<user_instructions>Never publish</user_instructions>" : `Original constraint ${i}` }] } }))].join("\n") + "\n");
  const pins = await f.evidence.startup(f.transcripts, f.sessions); expect(pins.skipDestructiveRetention).toBe(false);
  const nativeCopies = (await f.evidence.archive.list()).filter((s) => s.id.startsWith("native:")); expect(nativeCopies).toHaveLength(35);
  expect((await f.evidence.packets.read(await f.continuity.checkpoint(identity, "", [], "native-cp"))).sources.some((s) => s.text?.includes("<user_instructions>Never publish</user_instructions>"))).toBe(true);
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
      content: [{ type: "input_text", text: i === 0 ? "<user_instructions>Never publish</user_instructions>" : `Container constraint ${i}` }] } }))].join("\n") + "\n");
  const transcripts = new ExecutionTranscriptStore(f.root, { ...f.options, continuity: f.evidence.transcriptContinuity }, source, () => undefined);
  expect((await f.evidence.startup(transcripts, f.sessions)).skipDestructiveRetention).toBe(false);
  const refs = (await f.evidence.archive.list()).filter((s) => s.id.startsWith("native:"));
  expect(refs).toHaveLength(26);
  const packet = await f.evidence.packets.write(identity, "", refs, at);
  expect((await f.evidence.packets.read(packet)).sources.some((s) => s.text?.includes("<user_instructions>Never publish</user_instructions>"))).toBe(true);
  await rm(path);
  expect((await f.evidence.startup(transcripts, f.sessions)).skipDestructiveRetention).toBe(false);
});


it("captures historical native context when an already observed worker becomes referenced", async () => {
  const f = await setup(), path = join(f.native, "worker.jsonl");
  const record = SessionRecordSchema.parse({ ...f.record, id: target, kind: "worker" });
  await f.sessions.put(record);
  await f.bindings.record({ sessionId: target, nativeSessionId: target, transcriptPath: path, cwd: "/repo" });
  await writeFile(path, [JSON.stringify({ type: "session_meta", payload: { id: target, timestamp: at, cwd: "/repo", originator: "codex-tui" } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Historical constraint" }] } }),
    JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "old-turn", last_agent_message: "Historical result" }, timestamp: at })].join("\n") + "\n");
  const input = { sessionId: target, provider: "codex" as const, cwd: "/repo", createdAt: record.createdAt, turnNumber: 0 };
  await f.transcripts.observeProviderTurns(input); await f.transcripts.readTranscriptMessages(input);
  expect((await f.evidence.archive.list()).some((s) => s.id.startsWith(`native:${target}:`))).toBe(false);
  await f.evidence.instructionStore.put(f.f.record);
  const packet = await f.continuity.checkpoint(identity, "", [], "historical");
  const sources = (await f.continuity.read(identity, packet)).sources;
  expect(sources.some((s) => s.id.startsWith(`native:${target}:`) && s.text?.includes("Historical constraint"))).toBe(true);
  expect(sources.some((s) => s.id.startsWith(`native:${target}:`) && s.text?.includes("Historical result"))).toBe(true);
  const count = (await f.evidence.archive.list()).length;
  await f.evidence.sources.capture(await f.evidence.orchestratorStore.strigoi.read());
  expect((await f.evidence.archive.list()).length).toBe(count);
});

it("keeps resume held until required missing evidence is restored and captured", async () => {
  const f = await setup(), path = join(f.native, "restore.jsonl");
  vi.spyOn(console, "error").mockImplementation(() => {});
  await f.bindings.record({ sessionId: actor, nativeSessionId: actor, transcriptPath: path, cwd: "/repo" });
  expect((await f.evidence.startup(f.transcripts, f.sessions)).skipDestructiveRetention).toBe(true);
  const freeze = vi.fn(async () => {}), reopen = vi.fn(async () => {}), start = vi.fn();
  const lifecycle = new StrigoiLifecycle({ repository: f.evidence.orchestratorStore.strigoi, bindings: f.evidence.orchestratorStore,
    admission: { ...f.f.admission, freeze, reopen, run: vi.fn(), instruction: vi.fn() }, verifyContinuity: f.evidence.verify,
    manager: { prepareResident: vi.fn(), observeResident: vi.fn() },
    registry: { ...f.f.registry, start, launchOutcome: vi.fn(), ownsProcess: () => false,
      stopResidentProcess: vi.fn(), workerTruth: () => ({ modalOpen: false }) } });
  try {
    await expect(lifecycle.setDesired("enabled", "resume-missing")).rejects.toThrow("STRIGOI_NATIVE_SOURCE_UNAVAILABLE");
    expect((await f.evidence.orchestratorStore.strigoi.read()).hold?.code).toBe("continuity-evidence-unavailable");
    expect(reopen).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
    await writeFile(path, [JSON.stringify({ type: "session_meta", payload: { id: actor, timestamp: at, cwd: "/repo", originator: "codex-tui" } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<user_instructions>Restored constraint</user_instructions>" }] } })].join("\n") + "\n");
    await lifecycle.setDesired("enabled", "resume-restored");
    expect((await f.evidence.orchestratorStore.strigoi.read()).hold).toBeUndefined();
    expect((await f.evidence.archive.list()).some((s) => s.id.startsWith(`native:${actor}:`))).toBe(true);
    await rm(path); await f.evidence.verify(); // verified private coverage now permits loss of original
  } finally { lifecycle.dispose(); }
});

it.each(["checkpoint", "adoption"])("resyncs an append-visible/fsync-failed %s on every retry before returning success", async (kind) => {
  const f = await setup();
  await f.transcripts.append({ sessionId: actor, kind: "prompt", source: "human", text: "Original" });
  const packet = await f.continuity.checkpoint(identity, "base", [], "base");
  const adoption = { identity, packetHash: packet.sha256, coverageId: packet.coverageId,
    handledSourceIds: (await f.continuity.read(identity, packet)).sources.map((s) => s.coverageSourceId!), account: "Read exact evidence" };
  const invoke = (service: StrigoiContinuity) => kind === "checkpoint" ? service.checkpoint(identity, "retry", [], "retry") : service.acknowledge(adoption, "retry");
  const open = privateFiles.openPrivateAppendFile;
  const append = vi.spyOn(privateFiles, "openPrivateAppendFile").mockImplementation(async (path) => {
    const file = await open(path);
    if (path === f.evidence.orchestratorStore.strigoi.path) vi.spyOn(file, "sync").mockRejectedValueOnce(new Error("injected append fsync failure"));
    return file;
  });
  await expect(invoke(f.continuity)).rejects.toThrow("Resident journal write or sync failed"); append.mockRestore();
  const revision = (await f.evidence.orchestratorStore.strigoi.read()).revision;
  expect((await f.evidence.orchestratorStore.strigoi.read()).continuityReceipts?.some((r) => r.mutationId === "retry")).toBe(true);
  const reopened = composeStrigoiEvidence(f.root);
  const capture = vi.fn(async () => { throw new Error("replay must not recapture"); });
  const write = vi.spyOn(reopened.packets, "write");
  const service = new StrigoiContinuity({ repository: reopened.orchestratorStore.strigoi, bindings: reopened.orchestratorStore,
    admission: f.f.admission, packets: reopened.packets, sources: { capture } });
  const sync = vi.spyOn(atomic, "syncPrivateFile").mockRejectedValueOnce(new Error("retry sync still failed"));
  await expect(invoke(service)).rejects.toThrow("Resident journal sync failed");
  expect(sync).toHaveBeenCalledWith(reopened.orchestratorStore.strigoi.path);
  sync.mockRestore(); const successfulSync = vi.spyOn(atomic, "syncPrivateFile");
  await invoke(service);
  expect(successfulSync).toHaveBeenCalledWith(reopened.orchestratorStore.strigoi.path);
  expect(capture).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
  expect((await reopened.orchestratorStore.strigoi.read()).revision).toBe(revision);
});

async function deletionRegistry(f: Awaited<ReturnType<typeof setup>>, retire = async (_id: string) => {}) {
  const record = SessionRecordSchema.parse({ ...f.record, id: target, kind: "worker" }); await f.sessions.put(record);
  const registry = new SessionRegistry({ adapters: {}, sessionRuntimeFactory: () => { throw new Error("No launch"); }, journal: { append: async () => {} },
    workerTurnObservation: new WorkerTurnObservationAdapter(), recoveredSessions: [record], config: BrokerRuntimeConfigSchema.parse({}),
    transcripts: f.transcripts, store: f.sessions, executions: { start: vi.fn(), retire } });
  await registry.ready();
  registry.setResidentLifecycle({ validateReservation: async () => {}, beforeStop: async () => {}, beforeResume: async () => {},
    beforeDelete: f.evidence.beforeDelete, withDeletion: f.evidence.withDeletion });
  return registry;
}
it("rechecks references acquired during retirement before any destructive deletion", async () => {
  const f = await setup(), entered = deferred(), release = deferred();
  const registry = await deletionRegistry(f, async () => { entered.resolve(); await release.promise; });
  const drop = vi.spyOn(f.transcripts, "dropClaudeBinding"), erase = vi.spyOn(f.sessions, "delete");
  const deletion = registry.delete(target); const result = expect(deletion).rejects.toThrow("STRIGOI_EVIDENCE_REFERENCED");
  await entered.promise;
  await f.evidence.instructionStore.put(f.f.record);
  expect((await f.evidence.archive.pins()).has(target)).toBe(true);
  release.resolve(); await result;
  expect(drop).not.toHaveBeenCalled(); expect(erase).not.toHaveBeenCalled(); expect(registry.get(target).id).toBe(target);
  expect((await evidenceSafety(f.root)).deletions).toEqual([]);
  await registry.stopAll();
});
it("fences source and resident reference acquisition through the final session-store deletion", async () => {
  const f = await setup(), registry = await deletionRegistry(f), entered = deferred(), release = deferred();
  const erase = f.sessions.delete.bind(f.sessions);
  vi.spyOn(f.sessions, "delete").mockImplementationOnce(async (id) => { entered.resolve(); await release.promise; await erase(id); });
  const deletion = registry.delete(target); await entered.promise;
  try {
    await expect(f.evidence.archive.capture("instruction", "too-late", "keep", [actor, target])).rejects.toThrow("STRIGOI_EVIDENCE_DELETING");
    await expect(f.evidence.instructionStore.put(f.f.record)).rejects.toThrow("STRIGOI_EVIDENCE_DELETING");
    expect(await f.evidence.instructionStore.list()).toEqual([]);
    const state = await f.evidence.orchestratorStore.strigoi.read();
    await expect(f.evidence.orchestratorStore.strigoi.compareAndSwap(state.revision, "late-pin", { ...state,
      revision: state.revision + 1, retainedSessionIds: [...state.retainedSessionIds, target] })).rejects.toThrow("STRIGOI_EVIDENCE_DELETING");
  } finally { release.resolve(); }
  await deletion;
  expect((await f.sessions.load()).some((r) => r.id === target)).toBe(false);
  await expect(f.evidence.archive.capture("instruction", "after-delete", "keep", [target])).rejects.toThrow("STRIGOI_EVIDENCE_DELETING");
  await registry.stopAll();
});
it("propagates continuity cleanup refusals instead of deleting the session record", async () => {
  const f = await setup(), registry = await deletionRegistry(f);
  vi.spyOn(f.transcripts, "dropClaudeBinding").mockRejectedValueOnce(new Error("STRIGOI_EVIDENCE_REFERENCED"));
  await expect(registry.delete(target)).rejects.toThrow("STRIGOI_EVIDENCE_REFERENCED");
  expect(registry.get(target).id).toBe(target); expect((await f.sessions.load()).some((r) => r.id === target)).toBe(true);
  // A cleanup refusal can follow earlier destructive work; its durable intent stays fenced.
  await expect(f.evidence.archive.capture("instruction", "after-refusal", "keep", [target])).rejects.toThrow("STRIGOI_EVIDENCE_DELETING");
  await registry.stopAll();
});

it("revalidates a bound Claude original during resume and captures restored instruction envelopes", async () => {
  const f = await setup(), path = join(f.native, "claude.jsonl");
  const bindings = new ClaudeConversationBindingStore(f.root);
  await f.sessions.put(SessionRecordSchema.parse({ ...f.record, provider: "claude" }));
  await bindings.record({ sessionId: actor, payload: { session_id: actor, transcript_path: path, cwd: "/repo" } });
  const transcripts = new ThreadTranscriptStore(f.root, { ...f.options, claudeConversations: bindings });
  vi.spyOn(console, "error").mockImplementation(() => {});
  expect((await f.evidence.startup(transcripts, f.sessions)).skipDestructiveRetention).toBe(true);
  await expect(f.evidence.verify()).rejects.toThrow("STRIGOI_NATIVE_SOURCE_UNAVAILABLE");
  await writeFile(path, JSON.stringify({ type: "user", message: { role: "user", content: "<user_instructions>Never publish</user_instructions>" } }) + "\n");
  await f.evidence.verify();
  const refs = (await f.evidence.archive.list()).filter((s) => s.id.startsWith(`native:${actor}:`));
  expect(refs).toHaveLength(1);
  await rm(path); await f.evidence.verify();
});


it.each(["instruction", "workflow-run", "workflow-message", "attention"] as const)(
  "%s references remain durably protected after publication fsync and capture failures", async (kind) => {
    const h = await attentionHarness(); const armed = await h.attention.arm(h.request()); h.attention.stop(); await h.attention.flush();
    for (const failure of ["fsync", "capture"] as const) {
      const f = await setup(), registry = await deletionRegistry(f);
      const run = { id: target, ownerSessionId: actor, name: "Keep worker", participantSessionIds: [actor, target], status: "active" as const,
        limits: { maxMessages: 100, maxTurns: 20, maxHops: 8 }, messageCount: 0, turnCount: 0, createdAt: at, updatedAt: at };
      const message = { id: target, cursor: 1, runId: target, messageId: target, fromSessionId: actor, toSessionId: target,
        text: "Keep worker", wake: false, hop: 0, createdAt: at };
      const canonicalPath = kind === "instruction" ? f.evidence.instructionStore.path
        : kind === "attention" ? f.evidence.attentionStore.path(armed.controllerId)
          : join(f.root, "orchestration", kind === "workflow-run" ? "workflow-runs.jsonl" : "workflow-messages.jsonl");
      const open = privateFiles.openPrivateAppendFile, fileOpen = fs.open;
      const append = vi.spyOn(privateFiles, "openPrivateAppendFile").mockImplementation(async (path) => {
        const file = await open(path);
        if (failure === "fsync" && path === canonicalPath) vi.spyOn(file, "sync").mockRejectedValueOnce(new Error("canonical fsync failed"));
        return file;
      });
      // Fail the directory fsync after attention's atomic rename has made the record visible.
      const atomicOpen = vi.spyOn(fs, "open").mockImplementation(async (path, flags, mode) => {
        const file = await fileOpen(path, flags, mode);
        if (failure === "fsync" && kind === "attention" && path === dirname(canonicalPath) && flags === "r") {
          vi.spyOn(file, "sync").mockRejectedValueOnce(new Error("canonical fsync failed"));
        }
        return file;
      });
      const evidence = composeStrigoiEvidence(f.root);
      const capture = vi.spyOn(evidence.archive, "capture");
      if (failure === "capture") capture.mockRejectedValueOnce(new Error("private capture failed"));
      const publish = () => kind === "instruction" ? evidence.instructionStore.put(f.f.record)
        : kind === "workflow-run" ? evidence.workflowStore.putRun(run)
          : kind === "workflow-message" ? evidence.workflowStore.putMessage(message)
            : evidence.attentionStore.update(armed.controllerId, async () => armed);
      await expect(publish()).rejects.toThrow(failure === "fsync" ? "canonical fsync failed" : "private capture failed");
      expect(await readFile(canonicalPath, "utf8")).toContain(target);
      expect((await evidence.archive.list()).some((ref) => ref.sessionIds?.includes(target))).toBe(false);
      expect((await evidenceSafety(f.root)).retainedSessionIds).toContain(target);
      await expect(registry.delete(target)).rejects.toThrow("STRIGOI_EVIDENCE_REFERENCED");
      expect(registry.get(target).id).toBe(target);
      append.mockRestore(); atomicOpen.mockRestore(); capture.mockRestore();
      const reopened = composeStrigoiEvidence(f.root);
      const transcripts = new ThreadTranscriptStore(f.root, { ...f.options, continuity: reopened.transcriptContinuity });
      const retention = await reopened.startup(transcripts, new SessionStore(f.root));
      expect(retention.skipDestructiveRetention).toBe(false); expect(retention.protectedSessionIds.has(target)).toBe(true);
      await expect(reopened.beforeDelete(target)).rejects.toThrow("STRIGOI_EVIDENCE_REFERENCED");
      await registry.stopAll();
    }
  });

it("does not publish a canonical reference until conservative pin durability is confirmed", async () => {
  const f = await setup(); const write = atomic.writeAtomicPrivateFile;
  const safetyPath = join(f.root, "orchestration", "strigoi", "evidence-safety.json");
  const injected = vi.spyOn(atomic, "writeAtomicPrivateFile").mockImplementation(async (path, body) => {
    await write(path, body); if (path === safetyPath) throw new Error("pin rename visible, sync uncertain");
  });
  await expect(f.evidence.instructionStore.put(f.f.record)).rejects.toThrow("pin rename visible");
  expect(await f.evidence.instructionStore.list()).toEqual([]); injected.mockRestore();
  const sync = vi.spyOn(atomic, "syncPrivateFile").mockRejectedValueOnce(new Error("pin replay sync failed"));
  await expect(f.evidence.instructionStore.put(f.f.record)).rejects.toThrow("pin replay sync failed");
  expect(await f.evidence.instructionStore.list()).toEqual([]); sync.mockRestore();
  await f.evidence.instructionStore.put(f.f.record);
  expect(await f.evidence.instructionStore.list()).toHaveLength(1);
});

it("deletes an ordinary Orc and cancels its armed wait through binding removal while Strigoi is disabled", async () => {
  const h = await attentionHarness(); h.attention.stop(); await h.attention.flush();
  const evidence = composeStrigoiEvidence(h.directory), sessions = new SessionStore(h.directory);
  await evidence.orchestratorStore.put(h.bound);
  const record = SessionRecordSchema.parse({ ...h.registry.get(actor), executionState: "exited", exitCode: 0 }); await sessions.put(record);
  const transcripts = new ThreadTranscriptStore(h.directory, { continuity: evidence.transcriptContinuity });
  await evidence.startup(transcripts, sessions);
  const control = h.makeControl(evidence.attentionStore).attention;
  const armed = await control.arm(h.request());
  await evidence.attentionStore.update(armed.controllerId, async (current) => ({ ...current!,
    pendingIntent: { epoch: current!.epoch, messageId: target, coverage: current!.coverage.captured, createdAt: at },
    lastWake: { epoch: current!.epoch, messageId: target, intendedAt: at } }));
  const registry = new SessionRegistry({ adapters: {}, sessionRuntimeFactory: vi.fn(), journal: { append: async () => {} },
    workerTurnObservation: new WorkerTurnObservationAdapter(), transcripts, store: sessions, recoveredSessions: [record], config: BrokerRuntimeConfigSchema.parse({}) });
  await registry.ready();
  registry.setResidentLifecycle({ validateReservation: async () => {}, beforeStop: async () => {}, beforeResume: async () => {},
    beforeDelete: evidence.beforeDelete, withDeletion: evidence.withDeletion });
  const errors = vi.fn(), liveness = new OrchestratorSessionLiveness({ directory: new OrchestratorControllerDirectory(evidence.orchestratorStore),
    registry, coordination: h.coordination, onError: errors });
  const removed = vi.spyOn(liveness, "bindingRemoved");
  const manager = new OrchestratorManager(registry, evidence.orchestratorStore, undefined, undefined, undefined, undefined,
    async (binding) => { await control.bindingRemoved(binding); await liveness.bindingRemoved(binding); });
  try {
    expect((await evidence.orchestratorStore.strigoi.read()).desired).toBe("disabled");
    await registry.delete(actor, async () => { await manager.resetSessionBinding(actor); });
    expect(await evidence.orchestratorStore.findBySessionId(actor)).toBeUndefined();
    expect(await evidence.attentionStore.get(armed.controllerId)).toMatchObject({ status: "cancelled", cancelReason: "Orchestrator binding reset" });
    expect((await evidence.attentionStore.get(armed.controllerId))?.pendingIntent).toBeUndefined();
    expect(removed).toHaveBeenCalledOnce(); expect(errors).not.toHaveBeenCalled();
    expect(h.coordination.listControllerLiveness()).toContainEqual(expect.objectContaining({ state: "disconnected" }));
    expect(await sessions.load()).toEqual([]); expect(() => registry.get(actor)).toThrow();
    expect((await evidenceSafety(h.directory)).deletions).toEqual([{ sessionId: actor, phase: "complete" }]);
    // Cancelling with a new epoch is not a release and must remain fenced.
    await expect(evidence.attentionStore.update(armed.controllerId, async (current) => ({ ...current!, epoch: target }))).rejects.toThrow("STRIGOI_EVIDENCE_DELETING");
  } finally { liveness.dispose(); await registry.stopAll(); }
});

it.each(["partial-cleanup", "catalog-before-append", "catalog-visible-fsync"] as const)(
  "keeps a durable deletion fence after %s, including reopen and restarted startup", async (failure) => {
    const f = await setup(), registry = await deletionRegistry(f);
    const native = join(f.native, "worker.jsonl");
    await f.bindings.record({ sessionId: target, nativeSessionId: target, transcriptPath: native, cwd: "/repo" });
    await f.transcripts.commitProviderTurns({ sessionId: target, provider: "codex", turnNumber: 1,
      turns: [{ providerTurnId: "before-delete", providerOccurredAt: at, text: "Result", transport: "provider-native" }] });
    const open = privateFiles.openPrivateAppendFile;
    const append = vi.spyOn(privateFiles, "openPrivateAppendFile").mockImplementation(async (path) => {
      const file = await open(path);
      if (failure === "catalog-visible-fsync" && path === f.sessions.path) vi.spyOn(file, "sync").mockRejectedValueOnce(new Error("catalog fsync failed"));
      return file;
    });
    if (failure === "partial-cleanup") vi.spyOn(f.transcripts, "dropTurnLedger").mockRejectedValueOnce(new Error("STRIGOI_EVIDENCE_CLEANUP_UNCERTAIN"));
    if (failure === "catalog-before-append") vi.spyOn(f.sessions, "delete").mockRejectedValueOnce(new Error("catalog unavailable"));
    await expect(registry.delete(target)).rejects.toThrow(); append.mockRestore();
    expect(await f.bindings.read(target)).toBeUndefined(); expect(registry.get(target).id).toBe(target);
    expect((await evidenceSafety(f.root)).deletions).toEqual([{ sessionId: target, phase: "pending" }]);
    await expect(f.evidence.instructionStore.put(f.f.record)).rejects.toThrow("STRIGOI_EVIDENCE_DELETING");
    const reopened = composeStrigoiEvidence(f.root);
    await expect(reopened.archive.capture("instruction", "late", "late", [actor, target])).rejects.toThrow("STRIGOI_EVIDENCE_DELETING");
    // A copied state directory has a new canonical key: this exercises disk state with no process-local reservation.
    const restartRoot = await mkdtemp(join(tmpdir(), "strigoi-deletion-restart-")); roots.push(restartRoot);
    await cp(f.root, restartRoot, { recursive: true });
    // Artifact metadata owns absolute paths. Relocate only those descriptors; safety/catalog
    // bytes and immutable source content remain exactly as they were at the failed deletion.
    const metadata = join(restartRoot, "artifacts", "metadata");
    for (const name of await readdir(metadata)) {
      const path = join(metadata, name), value = JSON.parse(await readFile(path, "utf8"));
      value.descriptor.content.path = value.descriptor.content.path.replace(f.root, restartRoot);
      await writeFile(path, JSON.stringify(value) + "\n");
    }
    const restarted = composeStrigoiEvidence(restartRoot), catalog = new SessionStore(restartRoot);
    const transcripts = new ThreadTranscriptStore(restartRoot, { codexSessionsDirectory: join(restartRoot, "native"), continuity: restarted.transcriptContinuity });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const retention = await restarted.startup(transcripts, catalog);
    expect(retention.skipDestructiveRetention, errors.mock.calls.map((call) => call.map(String).join(" ")).join("\n")).toBe(false);
    expect((await evidenceSafety(restartRoot)).deletions).toEqual([{ sessionId: target, phase: failure === "catalog-visible-fsync" ? "complete" : "pending" }]);
    await expect(restarted.instructionStore.put(f.f.record)).rejects.toThrow("STRIGOI_EVIDENCE_DELETING");
    const retained = await retainStartupThreads({ ...retention, catalog, scoutReports: { remove: vi.fn() }, claudeBindings: transcripts },
      { maxAgeDays: 1, maxThreads: 0, keepPinned: false });
    expect(retained.some((s) => s.id === target)).toBe(failure !== "catalog-visible-fsync");
    if (failure !== "catalog-visible-fsync") {
      expect(errors).toHaveBeenCalled();
      const retry = new SessionRegistry({ adapters: {}, sessionRuntimeFactory: vi.fn(), journal: { append: async () => {} },
        workerTurnObservation: new WorkerTurnObservationAdapter(), transcripts, store: catalog, recoveredSessions: retained, config: BrokerRuntimeConfigSchema.parse({}) });
      await retry.ready(); retry.setResidentLifecycle({ validateReservation: async () => {}, beforeStop: async () => {}, beforeResume: async () => {},
        beforeDelete: restarted.beforeDelete, withDeletion: restarted.withDeletion });
      await retry.delete(target);
      expect((await catalog.load()).some((s) => s.id === target)).toBe(false);
      expect((await evidenceSafety(restartRoot)).deletions).toEqual([{ sessionId: target, phase: "complete" }]);
      await retry.stopAll();
    }
    errors.mockRestore(); await registry.stopAll();
  });

it("never enters destructive cleanup until its deletion intent is durable", async () => {
  const f = await setup(), registry = await deletionRegistry(f);
  const write = atomic.writeAtomicPrivateFile, commit = vi.fn(async () => {});
  const injected = vi.spyOn(atomic, "writeAtomicPrivateFile").mockImplementation(async (path, body) => {
    await write(path, body); if (path.endsWith("evidence-safety.json")) throw new Error("intent sync uncertain");
  });
  await expect(registry.delete(target, commit)).rejects.toThrow("intent sync uncertain"); expect(commit).not.toHaveBeenCalled();
  injected.mockRestore(); const sync = vi.spyOn(atomic, "syncPrivateFile").mockRejectedValueOnce(new Error("intent resync failed"));
  await expect(registry.delete(target, commit)).rejects.toThrow("intent resync failed"); expect(commit).not.toHaveBeenCalled(); sync.mockRestore();
  await registry.delete(target, commit); expect(commit).toHaveBeenCalledOnce(); await registry.stopAll();
});

it.each(["missing", "corrupt"])("fails closed when durable safety state is %s at restart", async (damage) => {
  const f = await setup(); await f.evidence.instructionStore.put(f.f.record);
  const path = join(f.root, "orchestration", "strigoi", "evidence-safety.json");
  if (damage === "missing") await rm(path); else await writeFile(path, "broken");
  vi.spyOn(console, "error").mockImplementation(() => {});
  const reopened = composeStrigoiEvidence(f.root);
  const result = await reopened.startup(new ThreadTranscriptStore(f.root, { ...f.options, continuity: reopened.transcriptContinuity }), f.sessions);
  expect(result.skipDestructiveRetention).toBe(true);
  await expect(reopened.beforeDelete(target)).rejects.toThrow();
  await expect(reopened.instructionStore.put(f.f.record)).rejects.toThrow();
});
