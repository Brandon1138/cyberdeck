import { mkdir, readFile, writeFile, lstat, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readHealth } from "./resource-fleet/health-rpc.js";
import { CollectorConfigSchema, preflight } from "./resource-fleet/collector.js";
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const [configPath, output, ...extra] = process.argv.slice(2);
try {
  if (!configPath || !output || extra.length || !/^\/private\/tmp\/cyberdeck-resource-[A-Za-z0-9_-]+$/.test(output)) throw new Error("explicit-input-required");
  const config = CollectorConfigSchema.parse(JSON.parse(await readFile(resolve(configPath), "utf8")));
  // Atomic, non-recursive creation rejects pre-existing output, including symlinks.
  await mkdir(output, { mode: 0o700 });
  const root = fileURLToPath(new URL("../", import.meta.url));
  const actualSha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" }).trim() !== "";
  const pinsMatch = actualSha === config.candidate.sourceSha && !dirty && !config.candidate.dirty
    && hash(await readFile(config.configFile)) === config.candidate.configSha256
    && hash(await readFile(config.profileFile)) === config.candidate.profileSha256;
  let report: object = { status: "unverified", launches: 0, blockers: ["local-candidate-pins-mismatch"] };
  if (pinsMatch) {
    const stat = await lstat(config.socket);
    if (!stat.isSocket() || stat.uid !== process.getuid?.() || await realpath(config.socket) !== config.socket) throw new Error("isolated-socket-invalid");
    report = await preflight((method, signal) => readHealth(config.socket, method, signal), config.timeoutMs);
  }
  await writeFile(join(output, "preflight.json"), JSON.stringify({ schemaVersion: 1, candidate: config.candidate,
    requestedBrokerId: config.brokerId, requestedInstallationId: config.installationId,
    identityVerified: false, immutableBrokerPinsVerified: false, node: process.version, ...report }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify({ status: "unverified", output, launches: 0 }));
} catch {
  console.log(JSON.stringify({ status: "unverified", launches: 0, failure: "collector-input-or-preflight-unavailable",
    usage: "prove-resource-fleet.ts <private-config.json> </private/tmp/cyberdeck-resource-NEW>" }));
}
process.exitCode = 1;
