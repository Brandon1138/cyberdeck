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
import { mkdir, mkdtemp, readFile, writeFile, open } from "node:fs/promises";
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
import { OrchestratorStore } from "../src/persistence/orchestrator-store.js";
import { WorkerHandoffService } from "../src/orchestration/worker-handoff-service.js";
import { BrokerWorkerLeaseCredentialCustodian } from "../src/broker/worker-lease-credential-custodian.js";
import { reconcileExecutions } from "../src/orchestration/execution-reconciler.js";
import { proveHandoff } from "./worker-proof-handoff.js";

const evidence = await mkdtemp(join(tmpdir(), "cyberdeck-broker-container-proof-"));
console.log(JSON.stringify({ evidence }));
const client = new OrbStackClient(`unix://${process.env.HOME}/.orbstack/run/docker.sock`);
const image = (await client.command(["image", "inspect", "cyberdeck-worker:20260905", "--format", "{{.Id}}"])).trim();
const source = join(evidence, "source"); await mkdir(source);
await trustedGit(source, ["init", "-b", "main"]);
await trustedGit(source, ["config", "user.email", "fixture@example.invalid"]);
await trustedGit(source, ["config", "user.name", "Fixture"]);
await writeFile(join(source, "answer.txt"), "before");
await trustedGit(source, ["add", "."]); await trustedGit(source, ["commit", "-m", "fixture"]);
const baseCommit = (await trustedGit(source, ["rev-parse", "HEAD"])).toString().trim();
let workerId: string = randomUUID();
let channel: WorkerEventChannel;
let registry: SessionRegistry;
let server: BrokerServer | undefined;
let rpc: RpcClient | undefined;
const reports: unknown[] = [];
const gateway = new WorkerGateway({ submit: async (event) => { const ack = await channel.submit(event); reports.push(ack); return ack; } }, (binding) => {
  try {
    const session = registry?.get(binding.workerId), execution = store.get(binding.workerId);
    return binding.workerId === workerId && session?.executionState === "active" && session.generation === binding.generation
      && execution?.ref.executionId === binding.executionId && execution.ref.generation === binding.generation;
  } catch { return false; }
});
const port = await gateway.listen();
const store = await WorkerExecutionStore.open(join(evidence, "broker-state"));
let context: ReturnType<typeof containerLaunchContext>;
const failures: string[] = [];
const backend = new OrbStackExecutor({ client,
  profile: { image, cpus: 1, memoryBytes: 256 * 1024 * 1024, slots: 1, network: "egress" },
  attach: createSessionRuntime, evidenceDirectory: join(evidence, "collected"), onFailure: (error) => failures.push(String(error)),
  contexts: {
    prepare: async (input) => {
      if (context !== undefined) {
        const token = gateway.issue({ workerId, executionId: input.identity.executionId, generation: input.identity.generation });
        await writeFile(join(context.hostCredentials, "reporting-token"), token, { mode: 0o600 });
        return context;
      }
      const workspace = await new PrivateCloneProvisioner(join(evidence, "clones")).provision({ executionId: input.identity.executionId, source, baseCommit, branch: "worker/proof", inputs: [] });
      const hostState = join(evidence, "worker-state"), hostCredentials = join(evidence, "credentials");
      await mkdir(hostState, { mode: 0o700 }); await mkdir(hostCredentials, { mode: 0o700 });
      const token = gateway.issue({ workerId, executionId: input.identity.executionId, generation: 1 });
      await writeFile(join(hostCredentials, "reporting-token"), token, { mode: 0o600 });
      context = containerLaunchContext({ workspace, hostState, hostCredentials, reportingUrl: `http://host.docker.internal:${port}/v1/report` });
      return context;
    },
    get: async () => context,
  },
});
const service = new WorkerExecutionService(store, { "orbstack-container": backend }, undefined, process.argv[2] === "--timeout-after-handoff" ? 5000 : 3600000);
let record: SessionRecord = { id: workerId, generation: 1, provider: "codex", model: "scripted-fixture", kind: "worker", cwd: source,
  executor: "orbstack-container", executionProfile: "ordinary", sandbox: "read-only", detached: true,
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), executionState: "starting", attachmentState: "detached", pid: 0, exitCode: null, childIds: [] };
let success = false;
try {
  const code = `
const fs = require('fs'); const cp = require('child_process');
const info = { uid: process.getuid(), memory: fs.readFileSync('/sys/fs/cgroup/memory.max','utf8').trim(), cpu: fs.readFileSync('/sys/fs/cgroup/cpu.max','utf8').trim(),
  versions: ['claude','codex'].map(p => { try { return cp.execFileSync(p,['--version'],{encoding:'utf8'}).trim(); } catch { return p + ':unavailable'; } }) };
try { fs.writeFileSync('/workspace/answer.txt','unsafe'); info.readOnly = false; } catch { info.readOnly = true; }
info.forbidden = ['/var/run/docker.sock','/Users/brandon','.ssh'].map(p => fs.existsSync(p));
console.log(JSON.stringify(info));
const report = cp.spawn('node',['/opt/cyberdeck/report.mjs'],{stdio:['pipe','inherit','inherit']});
report.stdin.end(JSON.stringify({workerId:'__WORKER_ID__',eventId:'runtime-proof',kind:'PROGRESS',summary:'scripted fixture'}));
report.on('exit',code => { console.log('REPORT:'+code); process.stdin.on('data',b => {
  console.log('ECHO:'+b.toString());
  if(b.toString().trim() === 'oom-proof') { const blocks=[]; while(true) blocks.push(Buffer.alloc(64*1024*1024, 1)); }
}); });
process.stdout.on('resize', () => console.log('SIZE:'+process.stdout.columns+':'+process.stdout.rows));
setInterval(() => {},1000);
`;
  const state = join(evidence, "test-broker");
  registry = new SessionRegistry({ adapters: { codex: { id: "codex", buildLaunchSpec: (session) => {
      if (session.kind === "orchestrator") return { executable: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], cwd: source, env: {}, transport: "pipe" };
      workerId = session.id;
      return { executable: "node", args: ["-e", code.replace("__WORKER_ID__", session.id)], cwd: "/workspace", env: {}, transport: "pty" };
    }, buildResumeSpec: (session) => ({ executable: "node", args: ["-e", code.replace("__WORKER_ID__", session.id)], cwd: "/workspace", env: {}, transport: "pty" }) } },
    executions: service, sessionRuntimeFactory: createSessionRuntime, journal: new Journal(state), store: new SessionStore(state),
    workerTurnObservation: new WorkerTurnObservationAdapter(), config: BrokerRuntimeConfigSchema.parse({}),
  });
  await registry.ready();
  const coordination = new WorkerCoordinationService({ store: new WorkerCoordinationStore(state) }); await coordination.initialize();
  const orchestrators = new OrchestratorStore(state), credentials = new BrokerWorkerLeaseCredentialCustodian();
  const workerHandoff = new WorkerHandoffService({ coordination, registry, orchestrators, credentials });
  channel = new WorkerEventChannel(coordination, registry, { findBySessionId: async () => undefined }, { enqueue: async () => { throw new Error("FIXTURE_NO_CHECKPOINTS"); } });
  const socketPath = join(evidence, "broker.sock");
  server = new BrokerServer({ registry, socketPath, workerEvents: channel, workerHandoff }); await server.listen();
  rpc = await RpcClient.connect(socketPath);
  record = await rpc.request<SessionRecord>("session.start", record);
  const runtime = { snapshot: () => registry.snapshot(record.id) };
  const deadline = Date.now() + 30_000;
  while (!runtime.snapshot().includes("REPORT:0") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  await rpc.request("session.send", { sessionId: record.id, data: Buffer.from("hello-container\n").toString("base64") });
  registry.resize(record.id, undefined, 93, 31);
  const echoDeadline = Date.now() + 5_000;
  while (!runtime.snapshot().includes("ECHO:hello-container") && Date.now() < echoDeadline) await new Promise((r) => setTimeout(r, 100));
  const resizeDeadline = Date.now() + 5_000;
  while (!runtime.snapshot().includes("SIZE:93:31") && Date.now() < resizeDeadline) await new Promise((r) => setTimeout(r, 100));
  const output = runtime.snapshot().toString();
  await writeFile(join(evidence, "output.txt"), output, { mode: 0o600 });
  const inspected = await client.inspect(record.execution!);
  await writeFile(join(evidence, "running-inspection.json"), JSON.stringify(inspected), { mode: 0o600 });
  if (!output.includes('"readOnly":true') || !output.includes('"uid":1000') || !output.includes('"memory":"268435456"')
    || !output.includes('"cpu":"100000 100000"') || !output.includes("ECHO:hello-container") || !output.includes("SIZE:93:31") || reports.length !== 1 || (reports[0] as { code: string }).code !== "accepted") throw new Error("CONTAINER_PROOF_ASSERTION_FAILED");
  if (process.argv[2] === "--resume-before-handoff") {
    const firstExecution = record.execution!;
    await rpc.request("session.stopOne", { sessionId: record.id });
    const stoppedBy = Date.now() + 15000;
    while (registry.get(record.id).exitCode === null && Date.now() < stoppedBy) await new Promise((r) => setTimeout(r, 100));
    if (registry.get(record.id).exitCode === null) throw new Error("RESUME_STOP_NOT_CONFIRMED");
    record = await rpc.request<SessionRecord>("session.resume", { sessionId: record.id });
    const readyBy = Date.now() + 30000;
    while (reports.length < 2 && Date.now() < readyBy) await new Promise((r) => setTimeout(r, 100));
    if (record.generation !== 2 || record.execution?.generation !== 2 || record.execution.executionId !== firstExecution.executionId
      || record.execution.backendId !== firstExecution.backendId || reports.slice().length !== 2) throw new Error("RESUME_GENERATION_OR_REPORT_FAILED");
    await writeFile(join(evidence, "resume.json"), JSON.stringify({ firstExecution, resumed: record, reports }), { mode: 0o600 });
  }
  await proveHandoff({ registry, rpc, coordination, credentials, orchestrators, worker: record, client, evidence });
  if (process.argv[2] === "--timeout-after-handoff") {
    const deadline = Date.now() + 15000;
    while (store.get(record.id)?.phase !== "stopped" && Date.now() < deadline) {
      await service.expireAttempts(); await new Promise((r) => setTimeout(r, 100));
    }
    const outcome = await backend.inspect(record.execution!), execution = store.get(record.id);
    await writeFile(join(evidence, "timeout.json"), JSON.stringify({ outcome, execution }), { mode: 0o600 });
    if (execution?.failure !== "timeout" || outcome.state !== "stopped" || backend.slots.snapshot().running.length) throw new Error("ATTEMPT_TIMEOUT_NOT_PROVED");
  }
  if (process.argv[2] === "--oom-after-handoff") {
    await rpc.request("session.send", { sessionId: record.id, data: Buffer.from("oom-proof\n").toString("base64") });
    const deadline = Date.now() + 20_000;
    while ((await backend.inspect(record.execution!)).state !== "stopped" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    const outcome = await backend.inspect(record.execution!);
    await writeFile(join(evidence, "oom.json"), JSON.stringify(outcome), { mode: 0o600 });
    if (outcome.state !== "stopped" || outcome.oomKilled !== true || outcome.guestExitCode !== 137) throw new Error("REAL_CGROUP_OOM_NOT_PROVED");
  }
  if (process.argv[2] === "--crash-after-handoff") {
    const checkpoint = await open(join(evidence, "result.json"), "wx", 0o600);
    try { await checkpoint.writeFile(JSON.stringify({ image, record, reports, failures, cleanup: "crash-recovery-required", proofMode: "intentional-broker-sigkill" })); await checkpoint.sync(); }
    finally { await checkpoint.close(); }
    console.log(JSON.stringify({ evidence, checkpoint: "durable-before-sigkill", executionId: record.execution!.executionId }));
    process.kill(process.pid, "SIGKILL");
  }
  // Reopen the durable stores and run the same recovery path as broker startup while the
  // owned guest is still running. This proves reconciliation, not a SIGKILL process test.
  const reopened = await WorkerExecutionStore.open(join(evidence, "broker-state"));
  const recovered = await reconcileExecutions(reopened, { "orbstack-container": backend });
  const recoveredCoordination = new WorkerCoordinationService({ store: new WorkerCoordinationStore(state) });
  await recoveredCoordination.initialize();
  await writeFile(join(evidence, "reconciliation.json"), JSON.stringify({ recovered,
    handoffs: recoveredCoordination.listHandoffs(), sameBrokerId: reopened.brokerId === store.brokerId }), { mode: 0o600 });
  if (recovered.unreachable.length || !recovered.stopped.includes(record.execution!.executionId)
    || reopened.brokerId !== store.brokerId || recoveredCoordination.listHandoffs().length !== 2) throw new Error("RECONCILIATION_PROOF_FAILED");
  await rpc.request("session.stop", { sessionId: record.id });
  const stopDeadline = Date.now() + 20_000;
  while ((await backend.inspect(record.execution!)).state !== "stopped" && Date.now() < stopDeadline) await new Promise((r) => setTimeout(r, 100));
  if ((await backend.inspect(record.execution!)).state !== "stopped" || backend.slots.snapshot().running.length) throw new Error("GUEST_STOP_OR_SLOT_FAILED");
  if (await readFile(join(source, "answer.txt"), "utf8") !== "before") throw new Error("SOURCE_MODIFIED");
  if (failures.length) throw new Error("EXECUTION_RUNTIME_ERRORS");
  success = true;
} finally {
  let cleanup = "no-container";
  if (record.execution !== undefined) {
    try {
      await backend.stop(record.execution, true);
      await backend.collect(record.execution);
      await backend.destroy(record.execution);
      cleanup = (await backend.inspect(record.execution)).state;
    } catch (error) { cleanup = String(error); }
  }
  rpc?.close();
  await server?.close();
  await gateway.close();
  await writeFile(join(evidence, "result.json"), JSON.stringify({ success, image, record, reports, failures, cleanup }), { mode: 0o600 });
  console.log(JSON.stringify({ evidence, success, image, cleanup }));
  if (cleanup !== "absent") process.exitCode = 1;
}
