import { SessionRegistry } from "../src/broker/session-registry.js";
import { BrokerServer } from "../src/broker/server.js";
import { RpcClient } from "../src/client/rpc-client.js";
import { BrokerRuntimeConfigSchema } from "../src/config.js";
import { WorkerTurnObservationAdapter } from "../src/runtime/worker-turn-observation-adapter.js";
import { WorkerCoordinationStore } from "../src/persistence/worker-coordination-store.js";
import { WorkerCoordinationService } from "../src/broker/worker-coordination.js";
import { WorkerEventChannel } from "../src/broker/worker-event-channel.js";
import { SessionStore } from "../src/persistence/session-store.js";
import { Journal } from "../src/persistence/journal.js";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkerGateway } from "../src/broker/worker-gateway.js";
import { OrbStackClient } from "../src/runtime/execution/orbstack-client.js";
import { OrbStackExecutor } from "../src/runtime/execution/orbstack-executor.js";
import { PrivateCloneProvisioner } from "../src/runtime/execution/isolated-workspace.js";
import { trustedGit } from "../src/runtime/execution/trusted-git.js";
import { containerLaunchContext } from "../src/runtime/execution/container-launch-context.js";
import { createSessionRuntime } from "../src/runtime/session-runtime-adapter.js";
import { WorkerExecutionStore } from "../src/persistence/worker-execution-store.js";
import { WorkerExecutionService } from "../src/orchestration/worker-execution-service.js";
import type { SessionRecord } from "../src/domain/session.js";
import type { ExecutionRef } from "../src/domain/worker-execution.js";
import { reconcileExecutions } from "../src/orchestration/execution-reconciler.js";

/**
 * Two ordinary slots, three workers. Proves on real OrbStack that concurrent workers hold
 * distinct clones, provider homes and gateway grants; that a worker's grant cannot report as
 * another worker; that the third launch queues until a slot frees and then runs; and that
 * retirement of one worker leaves the others' containers, clones and evidence untouched.
 */
const evidence = await mkdtemp(join(tmpdir(), "cyberdeck-multi-worker-proof-"));
console.log(JSON.stringify({ evidence }));
const sourceCommit = (await trustedGit(process.cwd(), ["rev-parse", "HEAD"])).toString().trim();
const sourceDirty = Boolean((await trustedGit(process.cwd(), ["status", "--porcelain"])).toString().trim());
const client = new OrbStackClient(`unix://${process.env.HOME}/.orbstack/run/docker.sock`);
const image = (await client.command(["image", "inspect", "cyberdeck-worker:20260905", "--format", "{{.Id}}"])).trim();
const source = join(evidence, "source"); await mkdir(source);
await trustedGit(source, ["init", "-b", "main"]);
await trustedGit(source, ["config", "user.email", "fixture@example.invalid"]);
await trustedGit(source, ["config", "user.name", "Fixture"]);
await writeFile(join(source, "answer.txt"), "before");
await trustedGit(source, ["add", "."]); await trustedGit(source, ["commit", "-m", "fixture"]);
const baseCommit = (await trustedGit(source, ["rev-parse", "HEAD"])).toString().trim();
const workerIds: string[] = [];
const tokens = new Map<string, string>();
const contexts = new Map<string, ReturnType<typeof containerLaunchContext>>();
const reports: Array<{ workerId: string; code: string }> = [];
let channel: WorkerEventChannel; let registry: SessionRegistry;
const gateway = new WorkerGateway({ submit: async (event) => { const ack = await channel.submit(event); reports.push({ workerId: event.workerId, code: (ack as { code: string }).code }); return ack; } }, (binding) => {
  try {
    const session = registry?.get(binding.workerId), execution = store.get(binding.workerId);
    return session?.executionState === "active" && session.generation === binding.generation
      && execution?.ref.executionId === binding.executionId && execution.ref.generation === binding.generation;
  } catch { return false; }
});
const port = await gateway.listen();
const store = await WorkerExecutionStore.open(join(evidence, "broker-state"));
const failures: string[] = [];
const backend = new OrbStackExecutor({ client,
  profile: { image, cpus: 1, memoryBytes: 256 * 1024 * 1024, slots: 2, network: "egress" },
  attach: createSessionRuntime, evidenceDirectory: join(evidence, "collected"), onFailure: (error) => failures.push(String(error)),
  contexts: {
    prepare: async (input) => {
      const id = input.record.id;
      const workspace = await new PrivateCloneProvisioner(join(evidence, "clones")).provision({ executionId: input.identity.executionId, source, baseCommit, branch: `worker/${id}`, inputs: [] });
      const hostState = join(evidence, "worker-state", id), hostCredentials = join(evidence, "credentials", id);
      await mkdir(hostState, { recursive: true, mode: 0o700 }); await mkdir(hostCredentials, { recursive: true, mode: 0o700 });
      await writeFile(join(workspace.hostPath, "marker.txt"), id); await writeFile(join(hostState, "marker"), id, { mode: 0o600 });
      const token = gateway.issue({ workerId: id, executionId: input.identity.executionId, generation: input.identity.generation });
      tokens.set(id, token);
      await writeFile(join(hostCredentials, "reporting-token"), token, { mode: 0o600 });
      const context = containerLaunchContext({ workspace, hostState, hostCredentials, reportingUrl: `http://host.docker.internal:${port}/v1/report` });
      contexts.set(input.identity.executionId, context);
      return context;
    },
    get: async (ref) => { const context = contexts.get(ref.executionId); if (!context) throw new Error("CONTEXT_UNKNOWN"); return context; },
  },
});
const service = new WorkerExecutionService(store, { "orbstack-container": backend });
const guest = (id: string, other: string) => `
const fs = require('fs'); const cp = require('child_process');
const info = { marker: fs.readFileSync('/workspace/marker.txt','utf8').trim(), home: fs.readFileSync('/home/worker/marker','utf8').trim(), uid: process.getuid(),
  mounts: fs.readFileSync('/proc/mounts','utf8').split('\\n').filter(l => / \\/(workspace|home\\/worker|run\\/credentials) /.test(l)).length,
  foreign: ['/workspace/../clones', '/home/worker/../${other}', '/run/credentials/../${other}'].map(p => { try { return fs.readdirSync(p).length; } catch { return -1; } }) };
console.log('ISO:' + JSON.stringify(info));
const token = fs.readFileSync('/run/credentials/reporting-token','utf8').trim();
fetch(process.env.CYBERDECK_REPORT_URL, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
  body: JSON.stringify({ workerId: '${other}', eventId: 'cross-${id}', kind: 'PROGRESS', summary: 'cross-worker attempt' }) })
  .then(r => console.log('CROSS:' + r.status)).catch(() => console.log('CROSS:error'));
const report = cp.spawn('node', ['/opt/cyberdeck/report.mjs'], { stdio: ['pipe','inherit','inherit'] });
report.stdin.end(JSON.stringify({ workerId: '${id}', eventId: 'own-${id}', kind: 'PROGRESS', summary: 'own report' }));
report.on('exit', code => console.log('REPORT:' + code));
setInterval(() => {}, 1000);
`;
const state = join(evidence, "test-broker");
let server: BrokerServer | undefined, rpc: RpcClient | undefined, success = false;
const sessions: SessionRecord[] = [];
try {
  registry = new SessionRegistry({ adapters: { codex: { id: "codex",
      buildLaunchSpec: (session) => { workerIds.push(session.id); return { executable: "node", args: ["-e", guest(session.id, randomUUID())], cwd: "/workspace", env: {}, transport: "pty" }; },
      buildResumeSpec: (session) => ({ executable: "node", args: ["-e", guest(session.id, randomUUID())], cwd: "/workspace", env: {}, transport: "pty" }) } },
    executions: service, sessionRuntimeFactory: createSessionRuntime, journal: new Journal(state), store: new SessionStore(state),
    workerTurnObservation: new WorkerTurnObservationAdapter(), config: BrokerRuntimeConfigSchema.parse({}),
  });
  await registry.ready();
  const coordination = new WorkerCoordinationService({ store: new WorkerCoordinationStore(state) }); await coordination.initialize();
  channel = new WorkerEventChannel(coordination, registry, { findBySessionId: async () => undefined }, { enqueue: async () => { throw new Error("FIXTURE_NO_CHECKPOINTS"); } });
  const socketPath = join(evidence, "broker.sock");
  server = new BrokerServer({ registry, socketPath, workerEvents: channel }); await server.listen();
  rpc = await RpcClient.connect(socketPath);
  const template = (): SessionRecord => ({ id: randomUUID(), generation: 1, provider: "codex", model: "scripted-fixture", kind: "worker", cwd: source,
    executor: "orbstack-container", executionProfile: "ordinary", sandbox: "read-only", detached: true,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), executionState: "starting", attachmentState: "detached", pid: 0, exitCode: null, childIds: [] });
  const waitFor = async (id: string, marker: string, ms: number) => {
    const deadline = Date.now() + ms;
    while (!registry.snapshot(id).includes(marker) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    if (!registry.snapshot(id).includes(marker)) throw new Error(`GUEST_MARKER_MISSING:${marker}`);
  };
  const a = await rpc.request<SessionRecord>("session.start", template()); sessions.push(a);
  const b = await rpc.request<SessionRecord>("session.start", template()); sessions.push(b);
  await waitFor(a.id, "REPORT:0", 30_000); await waitFor(b.id, "REPORT:0", 30_000);
  await waitFor(a.id, "CROSS:", 10_000); await waitFor(b.id, "CROSS:", 10_000);
  // Third launch: admitted logically, physically queued behind two held slots.
  const third = rpc.request<SessionRecord>("session.start", template());
  const queuedBy = Date.now() + 10_000;
  while (backend.slots.snapshot().queued.length !== 1 && Date.now() < queuedBy) await new Promise((r) => setTimeout(r, 100));
  const queuedSnapshot = backend.slots.snapshot();
  const queuedRecord = store.list().find((record) => record.phase === "preparing");
  if (queuedSnapshot.queued.length !== 1 || queuedSnapshot.running.length !== 2 || queuedRecord?.ref.executionId !== queuedSnapshot.queued[0]) throw new Error("THIRD_WORKER_NOT_QUEUED");
  await new Promise((r) => setTimeout(r, 2_000));
  if (backend.slots.snapshot().queued.length !== 1 || workerIds.length !== 3 && workerIds.length !== 2) throw new Error("QUEUE_DID_NOT_HOLD");
  // Host-side authority checks: A's grant, B's identity.
  const tokenA = tokens.get(a.id)!;
  const post = async (token: string, workerId: string, eventId: string) => (await fetch(`http://127.0.0.1:${port}/v1/report`, { method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ workerId, eventId, kind: "PROGRESS", summary: "host probe" }) })).status;
  const crossStatus = await post(tokenA, b.id, "host-cross");
  const outputA = registry.snapshot(a.id).toString(), outputB = registry.snapshot(b.id).toString();
  const iso = (output: string) => JSON.parse(output.slice(output.indexOf("ISO:") + 4, output.indexOf("\n", output.indexOf("ISO:"))).replace(/\r$/, ""));
  const isoA = iso(outputA), isoB = iso(outputB);
  const inspections = await Promise.all(sessions.map((session) => client.inspect(session.execution!)));
  await writeFile(join(evidence, "isolation.json"), JSON.stringify({ isoA, isoB, crossStatus, queuedSnapshot, inspections, reports }, null, 2), { mode: 0o600 });
  if (isoA.marker !== a.id || isoA.home !== a.id || isoB.marker !== b.id || isoB.home !== b.id || isoA.uid !== 1000 || isoB.uid !== 1000
    || isoA.mounts !== 3 || isoB.mounts !== 3 || !isoA.foreign.every((n: number) => n === -1) || !isoB.foreign.every((n: number) => n === -1)
    || !outputA.includes("CROSS:403") || !outputB.includes("CROSS:403") || crossStatus !== 403
    || reports.filter((r) => r.code === "accepted").map((r) => r.workerId).sort().join() !== [a.id, b.id].sort().join()
    || inspections[0]!.Mounts.some((m) => inspections[1]!.Mounts.some((n) => n.Source === m.Source))) throw new Error("ISOLATION_ASSERTION_FAILED");
  // Stop A: its slot frees, the queued worker starts, A's grant is dead.
  await rpc.request("session.stop", { sessionId: a.id });
  const c = await third; sessions.push(c);
  await waitFor(c.id, "REPORT:0", 30_000);
  const readyA = (await fetch(`http://127.0.0.1:${port}/v1/ready`, { headers: { authorization: `Bearer ${tokenA}` } })).status;
  const afterStop = { slots: backend.slots.snapshot(), readyA, a: await backend.inspect(a.execution!), c: await backend.inspect(c.execution!) };
  await writeFile(join(evidence, "after-stop.json"), JSON.stringify(afterStop, null, 2), { mode: 0o600 });
  if (afterStop.a.state !== "stopped" || afterStop.c.state !== "running" || afterStop.slots.running.length !== 2 || afterStop.slots.queued.length || readyA === 200) throw new Error("QUEUE_HANDOVER_NOT_PROVED");
  // Retire A alone; B and C keep running with their clones and homes intact.
  await service.retire(a.id);
  const retired = { a: await backend.inspect(a.execution!), b: await backend.inspect(b.execution!), c: await backend.inspect(c.execution!),
    record: store.get(a.id)?.phase, cloneA: (await readdir(join(evidence, "clones"))).some((name) => name.startsWith(a.execution!.executionId)),
    markerB: await readFile(join(evidence, "worker-state", b.id, "marker"), "utf8"), reportsB: reports.filter((r) => r.workerId === b.id).length };
  await writeFile(join(evidence, "retirement.json"), JSON.stringify(retired, null, 2), { mode: 0o600 });
  if (retired.a.state !== "absent" || retired.b.state !== "running" || retired.c.state !== "running" || retired.record !== "destroyed" || !retired.cloneA || retired.markerB !== b.id) throw new Error("SELECTIVE_RETIREMENT_NOT_PROVED");
  // Recovery with two live guests: both stopped, none destroyed, slot occupancy recomputed.
  const reopened = await WorkerExecutionStore.open(join(evidence, "broker-state"));
  const recovered = await reconcileExecutions(reopened, { "orbstack-container": backend });
  await writeFile(join(evidence, "reconciliation.json"), JSON.stringify(recovered), { mode: 0o600 });
  if (recovered.unreachable.length || recovered.stopped.length !== 2) throw new Error("MULTI_RECONCILIATION_FAILED");
  if (await readFile(join(source, "answer.txt"), "utf8") !== "before") throw new Error("SOURCE_MODIFIED");
  if (failures.length) throw new Error("EXECUTION_RUNTIME_ERRORS");
  success = true;
} finally {
  const cleanup: Record<string, string> = {};
  for (const session of sessions) {
    const ref: ExecutionRef | undefined = session.execution ?? store.get(session.id)?.ref;
    if (!ref) continue;
    try { await backend.stop(ref, true); if ((await backend.inspect(ref)).state !== "absent") { await backend.collect(ref); await backend.destroy(ref); } cleanup[session.id] = (await backend.inspect(ref)).state; }
    catch (error) { cleanup[session.id] = String(error); }
  }
  rpc?.close(); await server?.close(); await gateway.close();
  const remaining = (await client.command(["ps", "-a", "--filter", `label=cyberdeck.broker=${store.brokerId}`, "--format", "{{.ID}}"])).trim();
  await writeFile(join(evidence, "result.json"), JSON.stringify({ sourceCommit, sourceDirty, success, image, workers: sessions.map((s) => s.id), reports, failures, cleanup, remaining }), { mode: 0o600 });
  console.log(JSON.stringify({ evidence, success, image, cleanup, remaining }));
  if (remaining || !success) process.exitCode = 1;
}
