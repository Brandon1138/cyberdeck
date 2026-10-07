import { writeAtomicPrivateFile } from "../src/persistence/atomic-private-file.js";
import type { IntegrationServiceExecutor } from "../src/runtime/execution/integration-service-executor.js";
import type { OrbStackClient } from "../src/runtime/execution/orbstack-client.js";
import { integrationHash, type IntegrationServiceRequest } from "../src/runtime/execution/integration-service-recipe.js";

async function inventory(client: OrbStackClient) {
  const containers = (await client.command(["ps", "-a", "--no-trunc", "--format", "{{.ID}}\t{{.Names}}\t{{.State}}\t{{.Ports}}"])).trim().split("\n").filter(Boolean).sort();
  const volumes = (await client.command(["volume", "ls", "--format", "{{.Name}}"])).trim().split("\n").filter(Boolean).sort();
  const networks = (await client.command(["network", "ls", "--no-trunc", "--format", "{{.ID}}\t{{.Name}}"])).trim().split("\n").filter(Boolean).sort();
  return { containers, volumes, networks };
}
/** Deliberately no standalone budget: the proof must receive the installation's admitted executor. */
export async function proveIntegrationService(input: {
  executor: IntegrationServiceExecutor; client: OrbStackClient; request: IntegrationServiceRequest;
  evidencePath: string; sourceSha: string; dirty: boolean; signal?: AbortSignal;
}): Promise<void> {
  if (!/^[a-f0-9]{40}$/.test(input.sourceSha)) throw new Error("PROOF_SOURCE_SHA_REQUIRED");
  const startedAt = new Date().toISOString(), before = await inventory(input.client);
  const result = await input.executor.run(input.request, input.signal);
  const after = await inventory(input.client);
  const unchanged = integrationHash(before) === integrationHash(after);
  await writeAtomicPrivateFile(input.evidencePath, JSON.stringify({ version: 1, sourceSha: input.sourceSha, dirty: input.dirty,
    mode: "real-service-fixed-sql", startedAt, endedAt: new Date().toISOString(), node: process.version,
    before, after, foreignInventoryUnchanged: unchanged, result }));
  if (result.state !== "completed" || result.outcome !== "verified-pass" || !result.cleanupComplete || !unchanged)
    throw new Error("INTEGRATION_PROOF_NOT_PASSED");
}
