import { constants } from "node:fs";
import { mkdir, open, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { BrokerRuntimeConfigSchema } from "../src/config.js";

/** Writes a new private staging directory only. Never replaces a live configuration. */
const [currentPath, patchPath, output] = process.argv.slice(2);
if (!currentPath || !patchPath || !output || ![currentPath, patchPath, output].every(isAbsolute))
  throw new Error("Usage: prepare-resource-config.ts <private-current-config> <private-patch> <new-staging-directory>");
async function readPrivate(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 1024 ** 2 || stat.mode & 0o077 || stat.uid !== process.getuid?.()) throw new Error("CONFIG_SOURCE_NOT_PRIVATE");
    return await handle.readFile("utf8");
  } finally { await handle.close(); }
}
const originalBytes = await readPrivate(currentPath), patch = JSON.parse(await readPrivate(patchPath));
if (!patch || typeof patch !== "object" || Array.isArray(patch) || Object.keys(patch).some(key =>
  !["resourceManagement", "containerRuntime", "workerExecution", "maxConcurrentWorkers"].includes(key))) throw new Error("CONFIG_PATCH_SCOPE_REFUSED");
const original = JSON.parse(originalBytes);
const merged = { ...original, ...patch,
  containerRuntime: { ...original.containerRuntime, ...patch.containerRuntime },
  workerExecution: { ...original.workerExecution, ...patch.workerExecution } };
const config = BrokerRuntimeConfigSchema.parse(merged);
if (!config.resourceManagement || !config.resourceManagement.evaluation || !config.resourceManagement.auxiliaryProfiles?.integrationImage
  || !config.resourceManagement.auxiliaryProfiles.nativeRecipes.length || !config.containerRuntime || config.containerRuntime.slots < 8
  || config.maxConcurrentWorkers !== null && config.maxConcurrentWorkers < 8 || config.workerExecution?.defaultExecutor !== "orbstack-container")
  throw new Error("RESOURCE_ROLLOUT_PROFILE_INCOMPLETE");
if (Object.keys(config.containerRuntime.credentialFiles).length || Object.values(config.containerRuntime.authentication).some(auth => auth.kind === "api-key")
  || config.containerRuntime.authentication.codex?.kind !== "codex-subscription") throw new Error("RESOURCE_ROLLOUT_REQUIRES_SUBSCRIPTION_AUTH");
const proposed = JSON.stringify(merged, null, 2) + "\n", hash = (body: string) => createHash("sha256").update(body).digest("hex");
await mkdir(output, { mode: 0o700 });
await writeFile(join(output, "config.original.json"), originalBytes, { mode: 0o600, flag: "wx" });
await writeFile(join(output, "config.proposed.json"), proposed, { mode: 0o600, flag: "wx" });
const manifest = { schemaVersion: 1, originalSha256: hash(originalBytes), proposedSha256: hash(proposed),
  workerImage: config.containerRuntime.image, evaluatorImage: config.resourceManagement.evaluation.image,
  integrationImage: config.resourceManagement.auxiliaryProfiles.integrationImage,
  budgetBytes: config.resourceManagement.policy.totalBytes, activation: "not-performed",
  acceptance: "unverified; schema validation does not prove measured fleet capacity or safe native cleanup" };
await writeFile(join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600, flag: "wx" });
console.log(JSON.stringify({ output, ...manifest }));
