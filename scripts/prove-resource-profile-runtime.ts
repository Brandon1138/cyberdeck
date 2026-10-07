import { constants } from "node:fs";
import { mkdir, open, realpath, writeFile } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BrokerRuntimeConfigSchema } from "../src/config.js";
import { brokerResourceRuntime } from "../src/runtime/resources/broker-resource-runtime.js";
import { NativeMacosProcessSampler } from "../src/runtime/resources/native-macos-process-sampler.js";
import { OrbStackClient } from "../src/runtime/execution/orbstack-client.js";
import { IntegrationServiceExecutor } from "../src/runtime/execution/integration-service-executor.js";
import { proveIntegrationService } from "./prove-integration-service.js";
import { RpcClient } from "../src/client/rpc-client.js";
import type { SessionRecord } from "../src/domain/session.js";

const [output, mode, configPath, inventorySocket, expectedSourceSha] = process.argv.slice(2);
if (!output?.startsWith("/private/tmp/cyberdeck-resource-") || mode !== "integration"
  || !configPath || !inventorySocket || ![configPath, inventorySocket].every(isAbsolute)
  || !/^[a-f0-9]{40}$/.test(expectedSourceSha ?? "")) throw new Error("PROFILE_PROOF_ARGUMENTS_REQUIRED");
if (await realpath(process.cwd()) !== await realpath(resolve(dirname(fileURLToPath(import.meta.url)), "..")))
  throw new Error("PROFILE_PROOF_CANDIDATE_ROOT_REQUIRED");
const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim() !== "";
if (sourceSha !== expectedSourceSha || dirty) throw new Error("EXACT_CLEAN_PROFILE_CANDIDATE_REQUIRED");
const handle = await open(configPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
let configBytes: string;
try {
  const stat = await handle.stat();
  if (!stat.isFile() || stat.size > 1024 ** 2 || stat.mode & 0o077 || stat.uid !== process.getuid?.())
    throw new Error("PROFILE_CONFIG_NOT_PRIVATE");
  const buffer = Buffer.alloc(1024 ** 2 + 1);
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
  const after = await handle.stat();
  if (bytesRead !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs
    || after.ctimeMs !== stat.ctimeMs) throw new Error("PROFILE_CONFIG_CHANGED_DURING_READ");
  configBytes = buffer.subarray(0, bytesRead).toString("utf8");
} finally { await handle.close(); }
const supplied = BrokerRuntimeConfigSchema.parse(JSON.parse(configBytes));
const resources = supplied.resourceManagement;
const image = resources?.auxiliaryProfiles?.integrationImage;
if (!resources || !image || !supplied.containerRuntime || !resources.vmIdentity)
  throw new Error("PROFILE_CONFIG_INCOMPLETE");
await mkdir(output, { mode: 0o700 });
const table = await new NativeMacosProcessSampler(resources.nativeHelper).readTable();
const sameIdentity = (identity: { pid: number; startTime: string }) => table.rows.some(row =>
  row.identity.pid === identity.pid && row.identity.startTime === identity.startTime);
if (!sameIdentity(resources.vmIdentity) || resources.externalRoots.some(root => !sameIdentity(root)))
  throw new Error("PROFILE_PROCESS_IDENTITY_CHANGED_REINSPECT_REQUIRED");
const inventoryClient = await RpcClient.connect(inventorySocket);
let live: SessionRecord[], existingBrokerPid: number;
try {
  existingBrokerPid = (await inventoryClient.request<{ pid: number }>("broker.status", {})).pid;
  live = (await inventoryClient.request<SessionRecord[]>("session.list", {}))
    .filter(record => ["active", "starting"].includes(record.executionState) && record.executor !== "orbstack-container");
} finally { inventoryClient.close(); }
// The supplied roots include independently identified Fleet/implementation tools. Add all
// current native session roots and the live broker, rather than a stale orientation PID list.
const roots = [...resources.externalRoots];
for (const pid of new Set([existingBrokerPid, ...live.filter(record => record.pid > 0).map(record => record.pid)])) {
  const row = table.rows.find(candidate => candidate.identity.pid === pid);
  if (!row) throw new Error("PROFILE_LIVE_ROOT_METRICS_UNAVAILABLE");
  if (!roots.some(root => root.pid === pid)) roots.push({ ...row.identity, workloadId: `existing-cyberdeck-${pid}` });
}
const installationId = randomUUID(), brokerId = randomUUID();
const config = BrokerRuntimeConfigSchema.parse({ containerRuntime: supplied.containerRuntime,
  resourceManagement: { ...resources, installationId, directory: join(output, "resources"), externalRoots: roots } });
const runtime = await brokerResourceRuntime({ config, brokerId, execution: () => undefined, resolveFamily: async () => "operator-profile-fixture" });
if (!runtime) throw new Error("RESOURCE_RUNTIME_UNAVAILABLE");
const client = new OrbStackClient(config.containerRuntime!.endpoint);
const workerId = randomUUID();
const request = { identity: { brokerId, executionId: randomUUID(), workerId, sessionId: workerId, generation: 1 },
  attemptId: randomUUID(), leaseVersion: 1, recipe: "postgres-fixture-v1" as const };
const executor = new IntegrationServiceExecutor({ client, admission: runtime.admission, image, evidenceDirectory: join(output, "service"),
  authorize: async candidate => {
    if (JSON.stringify(candidate) !== JSON.stringify(request)) throw new Error("PROOF_AUTHORITY_MISMATCH");
    return { installationId, familyId: "operator-profile-fixture" };
  } });
runtime.registerVerifier("postgres-fixture-v1", (reservation, evidence) => executor.verifyTermination(reservation, evidence));
await runtime.completeRecovery(); // This fresh fixture has no recovered auxiliary reservations.
const samples: unknown[] = [runtime.health()];
const timer = setInterval(() => { if (samples.length < 120) samples.push(runtime.health()); }, 1000).unref();
try {
  await proveIntegrationService({ executor, client, request, evidencePath: join(output, "service-proof.json"), sourceSha, dirty });
  console.log(JSON.stringify({ passed: true, output }));
} finally {
  clearInterval(timer); samples.push(runtime.health());
  await writeFile(join(output, "resource-health.json"), JSON.stringify(samples), { mode: 0o600 });
  await writeFile(join(output, "manifest.json"), JSON.stringify({ sourceSha, dirty, image, installationId, brokerId,
    suppliedConfigSha256: createHash("sha256").update(configBytes).digest("hex"),
    effectiveResourceConfigSha256: createHash("sha256").update(JSON.stringify(config.resourceManagement)).digest("hex"),
    policyHash: createHash("sha256").update(JSON.stringify(config.resourceManagement!.policy)).digest("hex"),
    root: resolve("."), mode: "isolated-shared-admission-profile-fixture", node: process.version,
    limitations: ["operator-fixed fixture authority; production lease/RPC composition not proven", "no concurrent coding fleet in this profile baseline", "external Fleet and implementation roots explicitly supplied; no complete installation census", "native polling cannot establish full descendant lifetime"] }, null, 2), { mode: 0o600 });
  await runtime.close();
}
