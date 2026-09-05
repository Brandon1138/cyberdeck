import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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

const evidence = await mkdtemp(join(tmpdir(), "cyberdeck-container-proof-"));
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
const workerId = randomUUID();
const reports: unknown[] = [];
const gateway = new WorkerGateway({ submit: async (event) => { reports.push(event); return { code: "accepted", eventId: event.eventId! }; } }, (binding) => binding.workerId === workerId);
const port = await gateway.listen();
const store = await WorkerExecutionStore.open(join(evidence, "broker-state"));
let context: ReturnType<typeof containerLaunchContext>;
const failures: string[] = [];
const backend = new OrbStackExecutor({ client,
  profile: { image, cpus: 1, memoryBytes: 256 * 1024 * 1024, slots: 1, network: "egress" },
  attach: createSessionRuntime, evidenceDirectory: join(evidence, "collected"), onFailure: (error) => failures.push(String(error)),
  contexts: {
    prepare: async (input) => {
      if (context !== undefined) return context;
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
const service = new WorkerExecutionService(store, { "orbstack-container": backend });
const record: SessionRecord = { id: workerId, generation: 1, provider: "codex", model: "scripted-fixture", kind: "worker", cwd: source,
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
report.stdin.end(JSON.stringify({workerId:${JSON.stringify(workerId)},eventId:'runtime-proof',kind:'PROGRESS',summary:'scripted fixture'}));
report.on('exit',code => { console.log('REPORT:'+code); process.stdin.on('data',b => console.log('ECHO:'+b.toString())); });
process.stdout.on('resize', () => console.log('SIZE:'+process.stdout.columns+':'+process.stdout.rows));
setInterval(() => {},1000);
`;
  const runtime = await service.start(record, { executable: "node", args: ["-e", code], cwd: "/workspace", env: {}, transport: "pty" }, 65536);
  const deadline = Date.now() + 30_000;
  while (!runtime.snapshot().includes("REPORT:0") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  runtime.write(Buffer.from("hello-container\n")); runtime.resize(93, 31);
  const echoDeadline = Date.now() + 5_000;
  while (!runtime.snapshot().includes("ECHO:hello-container") && Date.now() < echoDeadline) await new Promise((r) => setTimeout(r, 100));
  const resizeDeadline = Date.now() + 5_000;
  while (!runtime.snapshot().includes("SIZE:93:31") && Date.now() < resizeDeadline) await new Promise((r) => setTimeout(r, 100));
  const output = runtime.snapshot().toString();
  await writeFile(join(evidence, "output.txt"), output, { mode: 0o600 });
  const inspected = await client.inspect(record.execution!);
  await writeFile(join(evidence, "running-inspection.json"), JSON.stringify(inspected), { mode: 0o600 });
  if (!output.includes('"readOnly":true') || !output.includes('"uid":1000') || !output.includes('"memory":"268435456"')
    || !output.includes('"cpu":"100000 100000"') || !output.includes("ECHO:hello-container") || !output.includes("SIZE:93:31") || reports.length !== 1) throw new Error("CONTAINER_PROOF_ASSERTION_FAILED");
  const exit = new Promise<void>((resolve, reject) => { const timeout = setTimeout(() => reject(new Error("STOP_TIMEOUT")), 20_000); runtime.onExit(() => { clearTimeout(timeout); resolve(); }); });
  runtime.kill(); await exit;
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
  await gateway.close();
  await writeFile(join(evidence, "result.json"), JSON.stringify({ success, image, record, reports, failures, cleanup }), { mode: 0o600 });
  console.log(JSON.stringify({ evidence, success, image, cleanup }));
  if (cleanup !== "absent") process.exitCode = 1;
}
