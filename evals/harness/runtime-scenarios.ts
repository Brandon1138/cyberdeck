import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { brokerFixture, eventually } from "./broker-fixture.js";
import { ExecutionSlotScheduler } from "../../src/orchestration/execution-slot-scheduler.js";
import { OrbStackExecutor } from "../../src/runtime/execution/orbstack-executor.js";
import { OrbStackClient } from "../../src/runtime/execution/orbstack-client.js";
import { containerLaunchContext } from "../../src/runtime/execution/container-launch-context.js";
import type { ContainerInspection } from "../../src/runtime/execution/orbstack-client.js";

export async function timeoutScenario(root: string) {
  const broker = await brokerFixture(root), slots = new ExecutionSlotScheduler(1);
  const release = await slots.reserve(broker.worker.id);
  try {
    await broker.instruct("hang");
    await eventually(async () => (await broker.queue.list(broker.worker.id))[0]?.submittedAt !== undefined, "HANG_NOT_SUBMITTED");
    await broker.rpc.request("session.stop", { sessionId: broker.worker.id });
    await eventually(() => broker.registry.get(broker.worker.id).exitCode !== null, "TIMEOUT_STOP_UNCONFIRMED");
    release(); release();
    const record = broker.registry.get(broker.worker.id), journal = await readFile(join(broker.state, "events.jsonl"), "utf8");
    let alive = true;
    try { process.kill(record.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false; }
    return { brokerId: broker.brokerId, facts: { record, slots: slots.snapshot(), processAlive: alive, journal, schedulerMode: "scripted-reservation" },
      checks: { "guest-or-scripted-process-stopped": !alive && record.exitCode !== null,
        "capacity-released": slots.snapshot().running.length === 0, "evidence-retained": journal.includes("session.stopped") } };
  } finally { release(); await broker.close(); }
}

/** Offline Engine fixtures exercise real backend command construction/inspection. They are
 * explicitly scripted: these verdicts never stand for kernel isolation or real OOM proof. */
export async function backendScenario(root: string, scenario: "oom" | "cross-worker") {
  const broker = await brokerFixture(root), commands: string[][] = [], inspections = new Map<string, ContainerInspection>();
  const endpoint = "unix:///scripted/orbstack.sock", image = `sha256:${"a".repeat(64)}`;
  const client = new OrbStackClient(endpoint, async (args) => {
    const command = args.slice(2); commands.push(command);
    if (command[0] === "context") return JSON.stringify([{ Name: "orbstack", Endpoints: { docker: { Host: endpoint } } }]);
    if (command[0] === "info") return JSON.stringify({ NCPU: 4, MemTotal: 4 * 1024 ** 3, MemoryLimit: true });
    if (command[0] === "ps") {
      const filter = command[command.indexOf("--filter") + 1]!;
      return [...inspections.values()].find((item) => filter === `name=^/${item.Name}$`)?.Id ?? "";
    }
    if (command[0] === "inspect") return JSON.stringify([[...inspections.values()].find((item) => item.Name === command[1])]);
    if (command[0] === "create") {
      const value = (name: string) => command[command.indexOf(name) + 1]!;
      const labels = Object.fromEntries(command.flatMap((arg, index) => arg === "--label" ? [command[index + 1]!.split("=")] : []));
      const mounts = command.flatMap((arg, index) => {
        if (arg !== "--mount") return [];
        const values = Object.fromEntries(command[index + 1]!.split(",").map((entry) => entry.split("=")));
        return [{ Source: values.src!, Destination: values.dst!, RW: !Object.hasOwn(values, "readonly") }];
      });
      const id = String(inspections.size + 1).repeat(64);
      inspections.set(id, { Id: id, Name: value("--name"), Config: { Labels: labels, User: "1000:1000", Image: image },
        State: { Running: false, ExitCode: scenario === "oom" ? 137 : 0, OOMKilled: scenario === "oom" },
        HostConfig: { Memory: 256 * 1024 ** 2, NanoCpus: 1e9, Privileged: false, NetworkMode: "bridge", CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges"] }, Mounts: mounts });
      return id;
    }
    throw new Error(`UNEXPECTED_SCRIPTED_DOCKER_COMMAND:${command[0]}`);
  });
  const contexts = new Map<string, ReturnType<typeof containerLaunchContext>>();
  const backend = new OrbStackExecutor({ client, profile: { image, cpus: 1, memoryBytes: 256 * 1024 ** 2, slots: 2, network: "egress" },
    attach: () => { throw new Error("OFFLINE_CONTAINER_START_FORBIDDEN"); }, evidenceDirectory: join(root, "evidence"), onFailure: () => {},
    contexts: { get: async (ref) => contexts.get(ref.executionId)!, prepare: async (input) => {
      const owned = join(root, input.identity.executionId), workspace = join(owned, "workspace"), state = join(owned, "state"), credentials = join(owned, "credentials");
      for (const directory of [workspace, state, credentials]) await mkdir(directory, { recursive: true, mode: 0o700 });
      const context = containerLaunchContext({ workspace: { mode: "independent-clone", executionId: input.identity.executionId, hostPath: workspace, guestPath: "/workspace", source: broker.cwd,
        baseCommit: "b".repeat(40), branch: "fixture", manifestHash: "c".repeat(64) }, hostState: state, hostCredentials: credentials, reportingUrl: "http://host.docker.internal:1234/v1/report" });
      contexts.set(input.identity.executionId, context); return context;
    } },
  });
  try {
    const refs = [];
    for (let i = 0; i < 2; i++) {
      const id = randomUUID();
      const prepared = await backend.prepare({ record: { ...broker.worker, id, sandbox: "read-only" }, request: { executor: "orbstack-container", profile: "ordinary" },
        identity: { brokerId: broker.brokerId, workerId: id, sessionId: id, executionId: randomUUID(), generation: 1 },
        launch: { executable: "node", args: [], cwd: "/workspace", env: {} } });
      refs.push(prepared.ref);
    }
    const inspected = await backend.inspect(refs[0]!);
    for (const ref of refs) await backend.stop(ref, true);
    const records = [...inspections.values()];
    const disjoint = records[0]!.Mounts.every((a) => records[1]!.Mounts.every((b) => a.Source !== b.Source));
    return { brokerId: broker.brokerId, facts: { commands, records, inspected, slots: backend.slots.snapshot(), fixtureMode: "scripted-engine-no-containers" }, checks: scenario === "oom" ? {
      "oom-classified": inspected.oomKilled === true && inspected.guestExitCode === 137,
      "capacity-released": backend.slots.snapshot().running.length === 0, "evidence-retained": records.length === 2,
    } : { "private-workspaces": contexts.size === 2 && disjoint,
      "other-worker-not-mounted": disjoint && records.every((record) => record.Mounts.length === 3),
      "credentials-not-shared": disjoint && records.every((record) => record.Mounts.some((mount) => mount.Destination === "/run/credentials" && !mount.RW)),
    } };
  } finally { await broker.close(); }
}
