// Isolated synthetic history only. Never points a store at the operator's state directory.
import { randomUUID } from "node:crypto";
import { mkdtemp, open, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const source = resolve(process.argv[2] ?? ".");
const records = Number(process.argv[3] ?? 131_585);
const from = (path: string) => import(pathToFileURL(join(source, path)).href);
const { WorkerCoordinationStore } = await from("src/persistence/worker-coordination-store.ts");
const { WorkerCoordinationService } = await from("src/broker/worker-coordination.ts");
const { handleMcpRequest } = await from("src/mcp/server.ts");
const directory = await mkdtemp(join(tmpdir(), "cyberdeck-responsiveness-bench-"));
const samples: Array<{ stage: string; durationMs: number }> = [];
const elapsed = async (work: () => Promise<unknown>) => {
  const start = performance.now(); await work(); return performance.now() - start;
};
try {
  const actor = { controllerId: "bench", familyId: "bench", scope: { kind: "fleet", scopeId: "bench" } };
  const now = "2026-11-15T00:00:00.000Z", subjectId = randomUUID();
  const store = new WorkerCoordinationStore(directory);
  const service = new WorkerCoordinationService({ store, now: () => now });
  await service.initialize();
  await service.registerSubject({ mutationId: "register", actor, subjectId, controller: actor,
    origin: { creatorControllerId: "bench", taskId: subjectId, threadId: subjectId, createdAt: now },
    lifecycle: "working", resources: { sessionId: subjectId, eventStreamId: `worker:${subjectId}` }, reason: "benchmark fixture",
    budget: { resource: "weekly", allocation: { unit: "percent", amount: 20 } },
  });
  await service.observeBudget({ mutationId: "observe", subjectId, reason: "fixture",
    measurement: { status: "known", unit: "percent", amount: 5, source: "provider-telemetry", quality: "approximate", observedAt: now, staleAfterMs: 60_000 },
  });
  const seed = (await readFile(store.path, "utf8")).trim().split("\n");
  const template = JSON.parse(seed[1]!);
  const file = await open(store.path, "a");
  try {
    let batch = "";
    for (let index = 2; index < records; index++) {
      const entry = structuredClone(template);
      entry.transactionId = randomUUID();
      entry.subjects = []; // historical no-change observations dominate the reported journal
      for (const audit of entry.audits) audit.auditId = randomUUID();
      for (const receipt of entry.receipts) receipt.mutationId = `observe:${index}`;
      batch += JSON.stringify(entry) + "\n";
      if (batch.length >= 1_048_576) { await file.writeFile(batch); batch = ""; }
    }
    if (batch) await file.writeFile(batch);
    await file.sync();
  } finally { await file.close(); }
  const bytes = (await stat(store.path)).size;
  const replayStore = new WorkerCoordinationStore(directory, { onTiming: (sample: { stage: string; durationMs: number }) => samples.push(sample) });
  const restored = new WorkerCoordinationService({ store: replayStore, now: () => now });
  const initializationMs = await elapsed(() => restored.initialize());
  const warmReadMs = await elapsed(async () => { for (let n = 0; n < 100; n++) restored.getSubject(subjectId); });
  const appendMs = await elapsed(() => replayStore.append({}));
  const actorSessionId = randomUUID();
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  const start = performance.now();
  const result = await Promise.race([
    handleMcpRequest({ identity: { actorSessionId }, transport: { request: async (method: string) =>
      ["agent.notifications.notice", "agent.notifications.peek"].includes(method) ? new Promise(() => {}) : { threads: [] } } },
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "cyberdeck_threads_list", arguments: {} } }).then(() => "returned"),
    new Promise(resolve => { noticeTimer = setTimeout(() => resolve("still-pending-at-1100ms"), 1_100); }),
  ]);
  if (noticeTimer) clearTimeout(noticeTimer);
  console.log(JSON.stringify({ source, records, bytes, initializationMs, warm100ReadsMs: warmReadMs, appendMs,
    optionalNotice: { result, elapsedMs: performance.now() - start }, samples }, null, 2));
} finally { await rm(directory, { recursive: true, force: true }); }
