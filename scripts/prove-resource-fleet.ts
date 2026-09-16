import { mkdir, writeFile, lstat, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readPrivateInput } from "./resource-fleet/private-input.js";
import { readHealth } from "./resource-fleet/health-rpc.js";
import { CollectorConfigSchema, preflight } from "./resource-fleet/collector.js";
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function localSource() {
  const root = fileURLToPath(new URL("../", import.meta.url));
  return { actualSha: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    dirty: execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" }).trim() !== "" };
}
export async function runCollector(args: string[], source = localSource): Promise<void> {
let outputCreated = false, stage = "arguments";
const [configPath, output, ...extra] = args;
try {
  if (!configPath || !isAbsolute(configPath) || !output || extra.length || !/^\/private\/tmp\/cyberdeck-resource-[A-Za-z0-9_-]+$/.test(output)) throw new Error("explicit-input-required");
  stage = "config-input";
  const config = CollectorConfigSchema.parse(JSON.parse((await readPrivateInput(configPath, 64 * 1024)).toString("utf8")));
  // Atomic, non-recursive creation rejects pre-existing output, including symlinks.
  stage = "output-create";
  await mkdir(output, { mode: 0o700 });
  outputCreated = true; stage = "candidate-pins";
  const { actualSha, dirty } = source();
  const pinsMatch = actualSha === config.candidate.sourceSha && !dirty && !config.candidate.dirty
    && hash(await readPrivateInput(config.configFile, 1024 * 1024)) === config.candidate.configSha256
    && hash(await readPrivateInput(config.profileFile, 1024 * 1024)) === config.candidate.profileSha256;
  let report: object = { status: "unverified", launches: 0, blockers: ["local-candidate-pins-mismatch"] };
  if (pinsMatch) {
    stage = "isolated-socket";
    const stat = await lstat(config.socket);
    if (!stat.isSocket() || stat.uid !== process.getuid?.() || await realpath(config.socket) !== config.socket) throw new Error("isolated-socket-invalid");
    stage = "health-read";
    report = await preflight((method, signal) => readHealth(config.socket, method, signal), config.timeoutMs);
  }
  stage = "report-write";
  await writeFile(join(output, "preflight.json"), JSON.stringify({ schemaVersion: 1, candidate: config.candidate,
    requestedBrokerId: config.brokerId, requestedInstallationId: config.installationId,
    identityVerified: false, immutableBrokerPinsVerified: false, node: process.version, ...report }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify({ status: "unverified", output, launches: 0 }));
} catch {
  if (outputCreated && output) {
    try { await writeFile(join(output, "failure.json"), JSON.stringify({ status: "unverified", launches: 0,
      stage, reason: "collector-input-or-preflight-unavailable" }) + "\n", { mode: 0o600, flag: "wx" }); }
    catch { console.log(JSON.stringify({ status: "unverified", stage: "failure-report-write", reason: "durable-failure-unavailable" })); }
  }
  console.log(JSON.stringify({ status: "unverified", launches: 0, failure: "collector-input-or-preflight-unavailable",
    usage: "prove-resource-fleet.ts <private-config.json> </private/tmp/cyberdeck-resource-NEW>" }));
}
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runCollector(process.argv.slice(2)); process.exitCode = 1;
}
