#!/usr/bin/env node
// Run the SAME script against base and candidate dist directories; fixtures never use live state.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";

const [major, minor] = process.versions.node.split(".").map(Number);
if (major !== 24 || minor < 18) throw new Error("Use supported Node >=24.18.0 <25 for both runs");
const root = resolve(process.argv[2] ?? "dist");
const load = (path) => import(pathToFileURL(join(root, "src", path)).href);
const optional = async (path) => { try { return await load(path); } catch (error) { if (error.code === "ERR_MODULE_NOT_FOUND") return undefined; throw error; } };
const bytes = (value) => Buffer.byteLength(JSON.stringify(value));
const result = { node: process.version, moduleRoot: root, workloads: {}, metrics: {} };
const measure = async (name, count, work) => {
  await work();
  const samples = [];
  for (let index = 0; index < count; index++) { const start = performance.now(); await work(); samples.push(performance.now() - start); }
  samples.sort((a, b) => a - b);
  result.metrics[name] = { iterations: count, meanMs: samples.reduce((a, b) => a + b, 0) / count,
    medianMs: samples[Math.floor(count / 2)], p95Ms: samples[Math.min(count - 1, Math.floor(count * 0.95))] };
  process.stderr.write(`${name}: ${result.metrics[name].meanMs.toFixed(3)} ms\n`);
};
const directory = await mkdtemp(join(tmpdir(), "cyberdeck-fleet-bench-"));
try {
  const uuid = (index) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
  const ids = Array.from({ length: 601 }, (_, index) => uuid(index + 1));
  const timestamp = "2026-10-07T00:00:00.000Z";
  const sessions = ids.slice(0, 71).map((id, index) => ({ id, provider: "claude", kind: index < 14 ? "orchestrator" : "worker",
    cwd: `/fixture/project-${index % 5}`, sandbox: "read-only", detached: true, createdAt: timestamp, updatedAt: timestamp,
    executionState: index % 3 === 0 ? "exited" : "active", attentionState: index % 3 === 0 ? "done" : "working",
    attachmentState: "detached", pid: index + 1, exitCode: index % 3 === 0 ? 0 : null, childIds: [],
    name: `Synthetic worker ${index} 漢字`, model: "fixture-model", latestPreview: `Preview ${index} é 👨‍👩‍👧‍👦`,
    launchRecord: { mode: "launch", transport: "pty", resolvedAt: timestamp, executable: "/fixture/agent", cwd: "/fixture",
      args: ["synthetic instructions ".repeat(240)], cyberdeckEnv: {}, inheritedEnvCount: 0, truncated: false } }));
  const binding = (index) => ({ key: `workspace:/fixture/project-${index}`, kind: "primary", sessionId: ids[index % ids.length],
    provider: "claude", model: "fixture-model", cwd: `/fixture/project-${index}`, sandbox: "read-only",
    scope: { kind: "workspace", cwd: `/fixture/project-${index}` },
    grant: { subjectSessionId: ids[index % ids.length], capabilities: ["thread.list", "thread.read"], scope: { kind: "workspace", cwd: `/fixture/project-${index}` } },
    createdAt: timestamp, updatedAt: timestamp });
  const subjects = ids.map((sessionId) => ({ subjectKind: "worker", subjectId: sessionId, resources: { sessionId }, lifecycle: "running",
    origin: { creatorControllerId: "fixture-controller", taskId: "fixture-task", threadId: sessionId, createdAt: timestamp },
    lease: { state: "orphaned" } }));
  const bindings = Array.from({ length: 176 }, (_, index) => binding(index));
  const projects = Array.from({ length: 5 }, (_, index) => `/fixture/project-${index}`);
  const views = await load("broker/worker-coordination-view.js");
  const transport = await load("client/fleet/transport.js");
  const legacy = { request: async (method) => ({ "session.list": sessions,
    "fleet.workerCoordination": views.fleetWorkerCoordinationView(subjects), "fleet.orchestratorOwnership": views.fleetOrchestratorOwnership(bindings),
    "fleet.projects": projects })[method] };
  const oldPayload = { sessions, coordination: await legacy.request("fleet.workerCoordination"), owners: await legacy.request("fleet.orchestratorOwnership"), projects };
  const compact = await optional("broker/fleet-projection.js");
  let snapshot;
  result.workloads.fleet = { sessions: 71, subjects: 601, bindings: 176, projects: 5, legacyRpcCalls: 4 };
  if (compact) {
    const projection = new compact.FleetProjection({ registry: { list: () => sessions }, workerCoordination: { listSubjects: () => subjects },
      orchestratorBindings: { list: async () => bindings }, fleetProjects: { list: async () => projects } });
    const initial = await projection.read(); snapshot = initial.retained.snapshot;
    result.metrics.fleetFullBytes = bytes(initial.reply);
    result.metrics.fleetIdleBytes = bytes((await projection.read(initial.retained.version, initial.retained)).reply);
    sessions[40] = { ...sessions[40], latestPreview: "changed synthetic preview" };
    result.metrics.fleetOneRowDeltaBytes = bytes((await projection.read(initial.retained.version, initial.retained)).reply);
    await measure("fleetProjection", 50, () => projection.read(initial.retained.version, initial.retained));
  } else {
    snapshot = await transport.collectFleetSnapshot(legacy);
    result.metrics.fleetFullBytes = bytes(oldPayload); result.metrics.fleetIdleBytes = bytes(oldPayload);
    await measure("fleetProjection", 50, () => transport.collectFleetSnapshot(legacy));
  }
  const frame = await load("client/fleet/render-frame.js"), cursor = await load("client/fleet/key-decoder.js"), layout = await load("client/fleet/runtime-frame.js");
  const prepared = await optional("client/fleet/prepare-frame.js");
  let state = { ...transport.createFleetState(snapshot, "/fixture"), draft: "Unicode 漢字 é 👨‍👩‍👧‍👦 composer", expandedCwds: projects };
  const options = { width: 86, height: 24, now: Date.parse(timestamp), color: true, home: "/fixture", pullRequests: new Map() };
  result.workloads.renderer = { width: 86, height: 24, sessions: 71, writesIncluded: false, changingDraft: true };
  let frameNumber = 0;
  await measure("framePreparation", 250, () => {
    state = { ...state, draft: `Unicode 漢字 é 👨‍👩‍👧‍👦 composer ${frameNumber++ % 10}` };
    if (prepared) prepared.prepareFleetFrame(snapshot, state, options);
    else { const normalized = frame.normalizeThreadListViewport(snapshot, state, options), body = frame.renderFleet(snapshot, normalized, options);
      cursor.composerCursor(body, normalized, 86); layout.fleetFrameLayout(snapshot, normalized, options); }
  });
  const { OrchestratorStore } = await load("persistence/orchestrator-store.js"), { FleetPreferenceStore } = await load("persistence/fleet-preference-store.js");
  const orcs = new OrchestratorStore(directory), prefs = new FleetPreferenceStore(directory);
  await mkdir(join(directory, "orchestration"), { recursive: true }); await mkdir(join(directory, "ui"), { recursive: true });
  await writeFile(orcs.path, Array.from({ length: 10000 }, (_, index) => JSON.stringify(binding(index))).join("\n") + "\n");
  await writeFile(prefs.path, Array.from({ length: 10000 }, (_, index) => JSON.stringify({ recordType: "fleet.project", eventId: uuid(index + 20000),
    persistedAt: timestamp, root: `/fixture/project-${index % 5}`, registered: true })).join("\n") + "\n");
  result.workloads.persistence = { bindingRecords: 10000, preferenceRecords: 10000, warmedReads: true };
  await measure("bindingLookup", 25, () => orcs.get("workspace:/fixture/project-9999"));
  await measure("projectProjection", 25, () => prefs.listProjects());
  const { ThreadTranscriptStore } = await load("persistence/thread-transcript-store.js");
  const transcripts = new ThreadTranscriptStore(directory, { claudeProjectsDirectory: join(directory, "native") });
  await mkdir(join(directory, "threads"), { recursive: true });
  const event = (index) => ({ id: uuid(index + 40000), cursor: index + 1, sessionId: ids[0], kind: "turn", source: "provider", occurredAt: timestamp,
    text: `Synthetic result ${index} 漢字 ${"x".repeat(200)}`, data: { semanticTurnId: `claude:turn-${index}` } });
  const events = Array.from({ length: 10000 }, (_, index) => event(index));
  await writeFile(transcripts.path, events.map(JSON.stringify).join("\n") + "\n"); await transcripts.init();
  result.workloads.transcript = { events: 10000, afterCursor: 9999, limit: 1, nativeLines: 10000, warmedReads: true };
  await measure("transcriptTailRead", 25, () => transcripts.read(ids[0], 9999, 1));
  await mkdir(join(directory, "native", "-fixture"), { recursive: true });
  await writeFile(join(directory, "native", "-fixture", `${ids[0]}.jsonl`), Array.from({ length: 10000 }, (_, index) => JSON.stringify({
    type: "assistant", timestamp, message: { id: `native-${index}`, role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: `Native ${index} ${"x".repeat(200)}` }] } })).join("\n") + "\n");
  const capture = { provider: "claude", sessionId: ids[0], cwd: "/fixture", createdAt: timestamp, turnNumber: 1, allowFallback: false };
  await measure("nativePreviewRead", 25, () => transcripts.readTranscriptMessages(capture));
  const large = { ...event(10000), text: '漢字 "escaped"\n'.repeat(12000), data: { nested: "detail".repeat(10000) } };
  await transcripts.append({ sessionId: ids[0], kind: "turn", source: "provider", text: large.text, data: large.data });
  const bounded = await optional("orchestration/thread-read-page.js");
  const mcp = await load("mcp/server.js");
  const allCapabilities = ["thread.list", "thread.read", "thread.enqueue", "worker.start", "worker.start.fable", "orchestrator.inspect", "orchestrator.stop", "workflow.run"];
  const context = { identity: { actorSessionId: ids[0] }, transport: { request: async (method, params) => {
    if (method === "agent.actor.describe") return { status: "bound", capabilities: allCapabilities };
    return bounded ? bounded.readThreadPage(transcripts, ids[0], params.afterCursor, params.limit, params) : transcripts.read(ids[0], params.afterCursor, params.limit);
  } } };
  const list = await mcp.handleMcpRequest(context, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  result.metrics.mcpFullSchemaBytes = bytes(list.result); result.metrics.mcpFullTools = list.result.tools.length;
  const restricted = { ...context, transport: { request: async () => ({ status: "bound", capabilities: ["thread.list"] }) } };
  const smaller = await mcp.handleMcpRequest(restricted, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  result.metrics.mcpScopedSchemaBytes = bytes(smaller.result); result.metrics.mcpScopedTools = smaller.result.tools.length;
  const workerContext = { ...context, transport: { request: async () => ({ status: "unbound", sessionKind: "worker" }) } };
  const workerTools = await mcp.handleMcpRequest(workerContext, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  result.metrics.mcpWorkerSchemaBytes = bytes(workerTools.result); result.metrics.mcpWorkerTools = workerTools.result.tools.length;
  let afterCursor = 10000, continuation, responseCount = 0, aggregate = 0, maximum = 0, reconstructed = "";
  do {
    const response = await mcp.handleMcpRequest(context, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "cyberdeck_thread_read",
      arguments: { sessionId: ids[0], afterCursor, ...(continuation ? { continuation } : {}) } } });
    const size = bytes(response), page = JSON.parse(response.result.content[0].text);
    responseCount++; aggregate += size; maximum = Math.max(maximum, size); afterCursor = page.nextCursor; continuation = page.continuation;
    if (page.fragment) reconstructed += page.fragment.json;
    else if (page.events[0]) reconstructed = JSON.stringify(page.events[0]);
  } while (continuation);
  if (JSON.parse(reconstructed).text !== large.text || JSON.parse(reconstructed).data.nested !== large.data.nested) throw new Error("Lossy continuation");
  result.workloads.mcpRead = { storedTextBytes: Buffer.byteLength(large.text), storedDataBytes: bytes(large.data), allContentConsumed: true };
  result.metrics.mcpRead = { responseCount, maximumWireBytes: maximum, aggregateWireBytes: aggregate };
  const { AgentActivityStore } = await load("persistence/agent-activity-store.js");
  const activityDirectory = join(directory, "activity"); await mkdir(activityDirectory);
  const activity = (index) => ({ schemaVersion: 1, eventId: uuid(index + 60000), sourceKey: `fixture:${index}`, runId: ids[0], workerId: ids[0], sessionId: ids[0],
    observedAt: timestamp, kind: "instruction.queued", operation: "instruction", provenance: "broker", coverage: "complete-for-source", outcome: "observed", sequence: index + 1 });
  await writeFile(join(activityDirectory, "activity.jsonl"), Array.from({ length: 5000 }, (_, index) => JSON.stringify(activity(index))).join("\n") + "\n");
  result.workloads.activity = { replayRows: 5000, appendedRows: 101, readPage: 100, fsyncEnabled: true };
  let store;
  const start = performance.now(); store = await AgentActivityStore.open(activityDirectory, { maxBytes: 2 * 1024 ** 3, maxAgeMs: 30 * 86400000, now: () => Date.parse(timestamp) }); result.metrics.activityOpenMs = performance.now() - start;
  await measure("activityPage", 25, () => store.read(ids[0], 0, 100));
  let next = 5000;
  await measure("activityAppend", 100, () => store.append(activity(next++)));
  await store.close();
  const startups = [], rss = [];
  for (let index = 0; index < 6; index++) {
    const start = performance.now();
    const child = spawnSync("/usr/bin/time", ["-l", process.execPath, join(root, "src/cli.js"), "mcp", "--help"], { encoding: "utf8" });
    if (child.status !== 0 || !child.stdout.includes("--actor-session")) throw new Error(child.stderr);
    startups.push(performance.now() - start);
    rss.push(Number(/(\d+)\s+maximum resident set size/u.exec(child.stderr)?.[1] ?? 0));
  }
  result.workloads.startup = { command: "node cli.js mcp --help", runs: 6, brokerConnected: false, providerLaunched: false };
  result.metrics.mcpHelpStartup = { meanMs: startups.reduce((a, b) => a + b, 0) / 6, meanPeakRssBytes: rss.reduce((a, b) => a + b, 0) / 6, samplesMs: startups };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally { await rm(directory, { recursive: true, force: true }); }
