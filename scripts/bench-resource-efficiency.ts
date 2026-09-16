import { mkdtemp, mkdir, writeFile, appendFile, readFile, rm } from "node:fs/promises";
import { tmpdir, release, cpus, totalmem } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { ContainerNativeSource } from "../src/runtime/activity/container-native-source.js";
import { ExecutionTranscriptStore } from "../src/persistence/execution-transcript-store.js";
import { collectFleetSnapshot, createFleetState } from "../src/client/fleet/transport.js";
import { renderFleet } from "../src/client/fleet/render-frame.js";
import * as frameModule from "../src/client/fleet/runtime-frame.js";
import type { SessionRecord } from "../src/domain/session.js";

// Synthetic fixtures only. Run the exact same script on each candidate; stdout is JSON.
const root = await mkdtemp(join(tmpdir(), "cyberdeck-efficiency-"));
const startedAt = new Date().toISOString();
const timestamp = "2026-09-16T10:00:00.000Z";
const record: SessionRecord = { id: randomUUID(), provider: "codex", cwd: "/workspace", detached: true,
  sandbox: "workspace-write", createdAt: timestamp, updatedAt: timestamp, executionState: "active",
  attachmentState: "detached", pid: 0, exitCode: null, childIds: [], generation: 1, executor: "orbstack-container" };
const frame = (type: string, payload: unknown) => JSON.stringify({ timestamp, type, payload }) + "\n";
const turn = (index: number) => frame("turn_context", { turn_id: `turn-${index}`, model: "fixture-model" })
  + frame("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "x".repeat(1024) }] })
  + frame("event_msg", { type: "task_complete", turn_id: `turn-${index}`, last_agent_message: `answer-${index}` });
const results: Record<string, unknown> = {};
async function measure(name: string, count: number, operation: () => Promise<void>) {
  const cpu = process.cpuUsage(), start = performance.now();
  for (let i = 0; i < count; i++) await operation();
  const elapsed = performance.now() - start, used = process.cpuUsage(cpu);
  results[name] = { operations: count, wallMs: elapsed, cpuMs: (used.user + used.system) / 1000,
    rssBytes: process.memoryUsage().rss, maxRssBytes: process.resourceUsage().maxRSS * 1024 };
}
try {
  const source = new ContainerNativeSource(root);
  const directory = join(source.stateRoot(record.id), ".codex", "sessions");
  await mkdir(directory, { recursive: true });
  const path = join(directory, "fixture.jsonl");
  const contents = frame("session_meta", { id: randomUUID(), originator: "codex-tui", cwd: "/workspace" })
    + Array.from({ length: 2000 }, (_, i) => turn(i)).join("");
  await writeFile(path, contents);
  await measure("nativeCold", 1, async () => { await source.read(record); });
  await measure("nativeIdle", 20, async () => { await source.read(record); });
  let index = 2000;
  await measure("nativeAppend", 20, async () => { await appendFile(path, turn(index++)); await source.read(record); });
  await mkdir(join(root, "threads"));
  await writeFile(join(root, "threads", "semantic-transcript.jsonl"), Array.from({ length: index }, (_, i) => JSON.stringify({
    id: randomUUID(), cursor: i + 1, sessionId: record.id, occurredAt: timestamp, kind: "turn", source: "provider",
    text: `answer-${i}`, data: { semanticTurnId: `codex:turn-${i}`, turnNumber: i + 1 },
  })).join("\n") + "\n");
  const transcripts = new ExecutionTranscriptStore(root, {}, source, () => record);
  const observation = { sessionId: record.id, provider: record.provider, cwd: record.cwd, createdAt: timestamp, turnNumber: index + 1 };
  await transcripts.observeProviderTurns(observation);
  await measure("semanticIdle", 20, async () => {
    const result = await transcripts.observeProviderTurns(observation);
    if (result.turns.length) throw new Error("unexpected duplicate semantic turns");
  });
  let requests = 0;
  const sessions = Array.from({ length: 64 }, (_, i) => ({ ...record, id: `fixture-${i}` }));
  const client = { request: async <T>(method: string): Promise<T> => {
    requests++; return (method === "session.list" ? sessions : []) as T;
  } };
  const state = createFleetState(await collectFleetSnapshot(client));
  // Namespace lookup also runs this exact benchmark against revisions preceding the frame cache.
  const renderer = typeof frameModule.FleetFrameCache === "function" ? new frameModule.FleetFrameCache() : undefined;
  const options = { width: 120, height: 32, now: Date.parse(timestamp), color: false, home: "/fixture", pullRequests: new Map(), background: undefined };
  const uncachedFleet = process.argv.includes("--uncached-fleet");
  await measure("fleet64Idle", 1000, async () => {
    const snapshot = await collectFleetSnapshot(client);
    if (uncachedFleet || !renderer) { renderFleet(snapshot, state, options); frameModule.fleetFrameLayout(snapshot, state, options); }
    else renderer.render(snapshot, state, options);
  });
  const sourceFiles = ["src/runtime/activity/container-native-source.ts", "src/runtime/activity/native-source-lines.ts",
    "src/persistence/execution-transcript-store.ts", "src/persistence/thread-transcript-store.ts",
    "src/client/fleet/runtime-frame.ts", "src/client/fleet/runtime.ts", "src/client/fleet/transport.ts",
    "scripts/bench-resource-efficiency.ts"];
  const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async (path) =>
    [path, createHash("sha256").update(await readFile(path)).digest("hex")])));
  console.log(JSON.stringify({ schemaVersion: 1, node: process.version, platform: process.platform, arch: process.arch,
    host: { osRelease: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem() },
    startedAt, endedAt: new Date().toISOString(), sourceHashes,
    fixture: { nativeBytes: Buffer.byteLength(contents), turns: 2000, fleetRows: 64 }, uncachedFleet, requests, results }, null, 2));
} finally { await rm(root, { recursive: true, force: true }); }
