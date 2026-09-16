import { mkdir, writeFile } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { execFileSync } from "node:child_process";
import { RpcClient } from "../src/client/rpc-client.js";
import type { SessionRecord } from "../src/domain/session.js";
import { NativeMacosProcessSampler } from "../src/runtime/resources/native-macos-process-sampler.js";
import { ResourceMonitor } from "../src/runtime/resources/resource-monitor.js";
import { readDockerInventory } from "../src/runtime/resources/docker-stats-reader.js";

// Explicit read-only surfaces; no credential lookup, daemon discovery, admission or launch.
const [output, helper, socket, engineSocket, vmPidText, vmBirth, ...controlPids] = process.argv.slice(2);
if (!output || !helper || !socket || !engineSocket || ![output, helper, socket, engineSocket].every(isAbsolute)
  || !/^libproc:\d+\.\d{6}$/.test(vmBirth ?? "") || !/^[1-9]\d*$/.test(vmPidText ?? "")
  || controlPids.some(pid => !/^[1-9]\d*$/.test(pid))) throw new Error("EXPLICIT_CAPACITY_INSPECTION_ARGUMENTS_REQUIRED");
await mkdir(output, { mode: 0o700 });
const client = await RpcClient.connect(socket), table = await new NativeMacosProcessSampler(helper).readTable();
let monitor: ResourceMonitor | undefined;
try {
  const status = await client.request<{ pid: number }>("broker.status", {});
  const sessions = await client.request<SessionRecord[]>("session.list", {});
  const vm = table.rows.find(row => row.identity.pid === Number(vmPidText) && row.identity.startTime === vmBirth);
  if (!vm) throw new Error("VM_IDENTITY_CHANGED_REINSPECT_REQUIRED");
  const live = sessions.filter(record => record.executionState === "active" || record.executionState === "starting");
  const candidates = [{ pid: status.pid, workloadId: "existing-broker", kind: "control" as const },
    ...controlPids.map(pid => ({ pid: Number(pid), workloadId: `explicit-control-${pid}`, kind: "control" as const })),
    ...live.filter(record => record.executor !== "orbstack-container").map(record => ({ pid: record.pid, workloadId: record.id, kind: record.kind ?? "worker" }))];
  const roots = [...new Map(candidates.map(candidate => [candidate.pid, candidate])).values()].flatMap(candidate => {
    const row = table.rows.find(row => row.identity.pid === candidate.pid);
    return row ? [{ identity: row.identity, owner: { installationId: "capacity-inspection", workloadId: candidate.workloadId, kind: candidate.kind } }] : [];
  });
  const missingPids = candidates.filter(candidate => !roots.some(root => root.identity.pid === candidate.pid)).map(candidate => candidate.pid);
  const ownedExecutions = new Set(live.flatMap(record => record.execution ? [record.execution.executionId] : []));
  const before = await readDockerInventory(engineSocket);
  monitor = new ResourceMonitor({ installationId: "capacity-inspection", nativeHelper: helper, vmIdentity: vm.identity,
    roots: () => structuredClone(roots), uncertainBytes: 256 * 1024 ** 2, engineSocket,
    containers: async () => (await readDockerInventory(engineSocket)).filter(row => row.running).map(row => ({ id: row.id,
      helper: row.labels["cyberdeck.network-helper"] !== undefined,
      owned: ownedExecutions.has(row.labels["cyberdeck.execution"] ?? row.labels["cyberdeck.network-helper"] ?? "") })) });
  await monitor.start();
  const health = monitor.health();
  const evidence = { sourceSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    dirty: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim() !== "", node: process.version,
    mode: "read-only-current-capacity", budgetBytes: 8 * 1024 ** 3, missingPids, roots, health,
    inventoryUnchanged: JSON.stringify(before) === JSON.stringify(await readDockerInventory(engineSocket)),
    limitations: ["single snapshot; not idle, concurrency or soak acceptance", "external control roots explicitly supplied; no full installation census",
      "native ancestry polling cannot prove full lifetime ownership", "whole VM upper bound; residual attribution uncalibrated"] };
  await writeFile(join(output, "capacity.json"), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ output, missingPids, inventoryUnchanged: evidence.inventoryUnchanged,
    ...( "samples" in health ? { observedAt: health.observedAt, managedNativePhysicalBytes: health.managedNativePhysicalBytes,
      vmPhysicalBytes: health.vm.vmPhysicalBytes, conservativePhysicalUpperBytes: health.conservativePhysicalUpperBytes, pressure: health.pressure } : health) }));
} finally { client.close(); await monitor?.close(); }
