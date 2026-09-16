import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { BrokerRuntimeConfigSchema } from "../src/config.js";
import { brokerResourceRuntime } from "../src/runtime/resources/broker-resource-runtime.js";
import { NativeMacosProcessSampler } from "../src/runtime/resources/native-macos-process-sampler.js";
import { OrbStackClient } from "../src/runtime/execution/orbstack-client.js";
import { IntegrationServiceExecutor } from "../src/runtime/execution/integration-service-executor.js";
import { proveIntegrationService } from "./prove-integration-service.js";

const [output, mode] = process.argv.slice(2);
if (!output?.startsWith("/private/tmp/cyberdeck-resource-") || mode !== "integration") throw new Error("PROFILE_PROOF_ARGUMENTS_REQUIRED");
await mkdir(output, { mode: 0o700 });
const helper = "/private/tmp/cyberdeck-process-sample";
const table = await new NativeMacosProcessSampler(helper).readTable();
const vm = table.rows.find(row => row.identity.pid === 33743 && row.identity.startTime === "libproc:1788938163.523107");
if (!vm) throw new Error("ORIENTATION_VM_IDENTITY_CHANGED_REINSPECT_REQUIRED");
const privateBaseline = JSON.parse(await readFile("/private/tmp/cyberdeck-resource-provider-baseline/config.json", "utf8"));
const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim() !== "";
const installationId = randomUUID(), brokerId = randomUUID();
const roots = [85613, 85652, 2869, 16773, 41386, 41092].flatMap(pid => {
  const row = table.rows.find(row => row.identity.pid === pid);
  return row ? [{ ...row.identity, workloadId: `existing-cyberdeck-${pid}` }] : [];
});
const config = BrokerRuntimeConfigSchema.parse({ containerRuntime: privateBaseline.containerRuntime,
  resourceManagement: { installationId, directory: join(output, "resources"), nativeHelper: helper,
    ownerLockHelper: "/private/tmp/cyberdeck-resource-tools/owner-lock", vmIdentity: vm.identity, externalRoots: roots,
    policy: { totalBytes: 8 * 1024 ** 3, fixedBytes: 1024 ** 3, uncertainBytes: 256 * 1024 ** 2,
      controlMarginBytes: 256 * 1024 ** 2, maxPids: 2048 }, profiles: {} } });
const runtime = await brokerResourceRuntime({ config, brokerId, execution: () => undefined, resolveFamily: async () => "operator-profile-fixture" });
if (!runtime) throw new Error("RESOURCE_RUNTIME_UNAVAILABLE");
const client = new OrbStackClient(config.containerRuntime!.endpoint);
const image = "sha256:f3bd19c606e442c3d7bdfa8002e03fe260a1023351e0ea4598032022b68dd6e3";
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
    policyHash: createHash("sha256").update(JSON.stringify(config.resourceManagement!.policy)).digest("hex"),
    root: resolve("."), mode: "isolated-shared-admission-profile-fixture", node: process.version,
    limitations: ["operator-fixed fixture authority; production lease/RPC composition not proven", "no concurrent coding fleet in this profile baseline", "existing process roots are orientation snapshot; not a complete installation census"] }, null, 2), { mode: 0o600 });
  await runtime.close();
}
