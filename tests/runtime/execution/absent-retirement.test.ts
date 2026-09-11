import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { WorkerExecutionStore } from "../../../src/persistence/worker-execution-store.js";
import { WorkerExecutionService } from "../../../src/orchestration/worker-execution-service.js";
import { OrbStackClient } from "../../../src/runtime/execution/orbstack-client.js";
import { OrbStackExecutor } from "../../../src/runtime/execution/orbstack-executor.js";
import { BrokerContainerContexts } from "../../../src/runtime/execution/broker-container-contexts.js";
import { WorkerGateway } from "../../../src/broker/worker-gateway.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it.each(["absent", "unreachable"])("retires a failed acquisition only with verified %s evidence", async (state) => {
  const root = await mkdtemp(join(tmpdir(), "absent-retirement-")); roots.push(root);
  const source = join(root, "source"); await mkdir(source); await writeFile(join(source, "work.txt"), "user work");
  const store = await WorkerExecutionStore.open(root), workerId = randomUUID();
  const ref = { brokerId: store.brokerId, executionId: randomUUID(), workerId, sessionId: workerId,
    generation: 1, executor: "orbstack-container" as const, workspaceId: source };
  await store.put({ schemaVersion: 1, ref, request: { executor: "orbstack-container", profile: "ordinary" },
    phase: "failed", failure: "prepare", cleanupFailed: true, updatedAt: new Date().toISOString() });
  const containerRoot = join(root, "containers"), credentials = join(containerRoot, "credentials", workerId);
  await mkdir(credentials, { recursive: true }); await writeFile(join(credentials, "provider.json"), "staged secret");
  const gateway = new WorkerGateway({ submit: async () => { throw new Error("UNUSED"); } }, () => false);
  const contexts = new BrokerContainerContexts(containerRoot, {}, gateway, 1234);
  const client = new OrbStackClient("unix:///tmp/fixture");
  vi.spyOn(client, "inspect").mockImplementation(async () => { if (state === "unreachable") throw new Error("offline"); return undefined; });
  const commands = vi.spyOn(client, "command").mockRejectedValue(new Error("NO_DOCKER_MUTATION"));
  const backend = new OrbStackExecutor({ client, contexts, profile: { image: `sha256:${"a".repeat(64)}`, cpus: 1, memoryBytes: 256 * 1024 ** 2, slots: 1, network: "egress" },
    evidenceDirectory: join(root, "evidence"), attach: () => { throw new Error("NO_SPAWN"); }, onFailure: () => {} });
  const service = new WorkerExecutionService(store, { "orbstack-container": backend });
  if (state === "unreachable") {
    await expect(service.retire(workerId)).rejects.toThrow("offline");
    expect(store.get(workerId)?.phase).toBe("failed");
    expect(await readFile(join(credentials, "provider.json"), "utf8")).toBe("staged secret");
  } else {
    await service.retire(workerId);
    expect(store.get(workerId)).toMatchObject({ phase: "destroyed", cleanupFailed: false });
    const evidence = JSON.parse(await readFile(store.get(workerId)!.manifestRef!, "utf8"));
    expect(evidence.payload).toMatchObject({ state: { state: "absent" }, contextAvailable: false, files: [], logs: null });
    await expect(readFile(join(credentials, "provider.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await service.retire(workerId);
  }
  expect(commands).not.toHaveBeenCalled();
  expect(await readFile(join(source, "work.txt"), "utf8")).toBe("user work");
  await gateway.close();
});
