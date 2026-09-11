import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { brokerFixture, eventually, type EvalMode } from "./broker-fixture.js";
import { ExecutionSlotScheduler } from "../../src/orchestration/execution-slot-scheduler.js";
import { OrbStackExecutor } from "../../src/runtime/execution/orbstack-executor.js";
import { OrbStackClient } from "../../src/runtime/execution/orbstack-client.js";
import { containerLaunchContext } from "../../src/runtime/execution/container-launch-context.js";
import type { ContainerInspection } from "../../src/runtime/execution/orbstack-client.js";
import type { LiveEvalConfig } from "./live-config.js";
import { livePrompts } from "../scenarios/live-prompts.js";

export async function timeoutScenario(root: string, mode: EvalMode = "offline-scripted", live?: LiveEvalConfig) {
  if (mode !== "offline-scripted") return containerTimeout(root, mode, live);
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
/** The real attempt-deadline path stops the real guest. The clock handed to expiry is advanced
 * past the configured deadline so the scenario need not wait an hour; the stop itself is real. */
async function containerTimeout(root: string, mode: EvalMode, live?: LiveEvalConfig) {
  const broker = await brokerFixture(root, { mode, ...(live ? { live } : {}) }), container = broker.container!;
  try {
    const instruction = await broker.instruct(mode === "live-container" ? livePrompts["timeout"] : "hang");
    await eventually(async () => (await broker.queue.list(broker.worker.id)).some((record) => record.id === instruction.id && record.submittedAt !== undefined), "HANG_NOT_SUBMITTED", broker.timeout);
    const ref = broker.registry.get(broker.worker.id).execution!, before = await container.client.inspect(ref);
    const deadline = container.runtime.health().records.find((record) => record.ref.workerId === broker.worker.id)?.attemptDeadline;
    await container.executions.expireAttempts(Date.parse(deadline!) + 1);
    await eventually(() => container.runtime.health().records.some((record) => record.ref.workerId === broker.worker.id && record.phase === "stopped" && record.failure === "timeout"), "DEADLINE_STOP_NOT_RECORDED", broker.timeout);
    await eventually(() => broker.registry.get(broker.worker.id).exitCode !== null, "GUEST_EXIT_NOT_OBSERVED", broker.timeout);
    const after = await container.client.inspect(ref), health = container.runtime.health();
    const record = health.records.find((item) => item.ref.workerId === broker.worker.id)!;
    return { brokerId: broker.brokerId, image: container.image, facts: { before: before?.State, after: after?.State, record, slots: health.slots, deadline, session: broker.registry.get(broker.worker.id) },
      provenance: { "guest-or-scripted-process-stopped": "host-verified", "capacity-released": "broker", "evidence-retained": "broker", "guest-stopped-by-deadline": "host-verified" } as const,
      checks: { "guest-or-scripted-process-stopped": before?.State.Running === true && after?.State.Running === false,
        "capacity-released": !health.slots!.running.includes(ref.executionId),
        "evidence-retained": record.phase === "stopped" && record.failure === "timeout" && record.attemptDeadline === deadline,
        "guest-stopped-by-deadline": after?.State.Running === false && record.failure === "timeout" } };
  } finally { await broker.close(); }
}

/** Offline Engine fixtures exercise real backend command construction/inspection. They are
 * explicitly scripted: these verdicts never stand for kernel isolation or real OOM proof. */
export async function backendScenario(root: string, scenario: "oom" | "cross-worker", mode: EvalMode = "offline-scripted", live?: LiveEvalConfig) {
  if (mode !== "offline-scripted") return scenario === "oom" ? containerOom(root, mode, live) : containerCrossWorker(root, mode, live);
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
        HostConfig: { Memory: Number(value("--memory")), MemorySwap: Number(value("--memory-swap")), NanoCpus: Number(value("--cpus")) * 1e9,
          ReadonlyRootfs: command.includes("--read-only"), PidsLimit: Number(value("--pids-limit")), PidMode: "", IpcMode: "private",
          CapAdd: null, Devices: [], Privileged: false, NetworkMode: value("--network"), CapDrop: [value("--cap-drop")], SecurityOpt: [value("--security-opt")] }, Mounts: mounts });
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
async function containerOom(root: string, mode: EvalMode, live?: LiveEvalConfig) {
  // OOM is fault injection against the container runtime, never a model-cooperation test. A
  // subscription provider cannot arrange for PID 1 to exhaust the cgroup: it either refuses the
  // allocation command or spawns a child the kernel kills first, leaving its own container alive —
  // which is why the 2026-09-11 baseline carried six red rows that said nothing about either the
  // models or the infrastructure. The scripted guest IS the allocator (PID 1 allocates
  // in-process), so a live run keeps the real container, the real cgroup limit, the real kill and
  // the real broker evidence, deterministically and with no subscription spend. `live` is
  // deliberately not forwarded: this scenario has no model to bill or grade.
  void live;
  const broker = await brokerFixture(root, { mode: mode === "live-container" ? "container-scripted" : mode }), container = broker.container!;
  try {
    const ref = broker.registry.get(broker.worker.id).execution!;
    await broker.instruct("oom-fixture");
    await eventually(async () => (await container.client.inspect(ref))?.State.Running === false, "GUEST_NOT_OOM_KILLED", broker.timeout);
    await eventually(() => container.runtime.health().records.some((record) => record.ref.workerId === broker.worker.id && record.phase === "stopped"), "OOM_NOT_RECORDED", broker.timeout);
    const inspection = await container.client.inspect(ref), health = container.runtime.health();
    const record = health.records.find((item) => item.ref.workerId === broker.worker.id)!;
    return { brokerId: broker.brokerId, image: container.image,
      facts: { guest: "scripted-oom-injection", state: inspection?.State, memory: inspection?.HostConfig.Memory, record, slots: health.slots },
      provenance: { "oom-classified": "host-verified", "capacity-released": "broker", "evidence-retained": "broker", "real-cgroup-oom": "host-verified" } as const,
      checks: { "oom-classified": inspection?.State.OOMKilled === true && inspection.State.ExitCode === 137,
        "capacity-released": !health.slots!.running.includes(ref.executionId),
        "evidence-retained": record.phase === "stopped" && record.guestOutcome?.oomKilled === true && record.guestOutcome.exitCode === 137,
        "real-cgroup-oom": inspection?.State.OOMKilled === true && inspection.HostConfig.Memory === container.config.containerRuntime!.memoryBytes } };
  } finally { await broker.close(); }
}
async function containerCrossWorker(root: string, mode: EvalMode, live?: LiveEvalConfig) {
  const broker = await brokerFixture(root, { mode, ...(live ? { live } : {}) }), container = broker.container!;
  try {
    const second = await broker.startWorker();
    const workers = [broker.worker.id, second.id];
    const prompt = mode === "live-container" ? livePrompts["cross-worker"] : "probe-isolation";
    const instructions = await Promise.all(workers.map((id) => broker.instruct(prompt, id)));
    await eventually(async () => { const all = await broker.queue.list(); return instructions.every((instruction) => all.some((record) => record.id === instruction.id && record.status === "completed")); }, "PROBES_NOT_COMPLETED", broker.timeout);
    const guestFacts = (id: string) => broker.reports.find((report) => report.workerId === id && (report.facts?.probe === "isolation" || Array.isArray(report.facts?.readable)))?.facts;
    if (mode === "container-scripted") await eventually(() => workers.every((id) => guestFacts(id) !== undefined), "GUEST_PROBES_NOT_REPORTED", broker.timeout);
    const refs = workers.map((id) => broker.registry.get(id).execution!);
    const inspections = await Promise.all(refs.map((ref) => container.client.inspect(ref)));
    const mounts = inspections.map((inspection) => inspection!.Mounts);
    const disjoint = mounts[0]!.every((a) => mounts[1]!.every((b) => a.Source !== b.Source));
    const cwds = workers.map((id) => broker.registry.get(id).cwd);
    const facts = workers.map(guestFacts);
    const guestClean = mode === "live-container" ? facts.every((fact) => Array.isArray(fact?.readable) && (fact!.readable as string[]).length === 0)
      : facts.every((fact, index) => fact !== undefined && fact.marker === workers[index] && fact.mounts === 3 && Array.isArray(fact.foreign) && (fact.foreign as number[]).every((n) => n === -1) && fact.uid === 1000);
    return { brokerId: broker.brokerId, image: container.image, facts: { workers, cwds, inspections, guest: facts, slots: container.runtime.health().slots },
      provenance: { "private-workspaces": "host-verified", "other-worker-not-mounted": "host-verified", "credentials-not-shared": "host-verified", "other-worker-unavailable": "host-verified" } as const,
      checks: { "private-workspaces": cwds[0] !== cwds[1] && disjoint,
        "other-worker-not-mounted": disjoint && mounts.every((list) => list.length === 3),
        "credentials-not-shared": disjoint && mounts.every((list) => list.some((mount) => mount.Destination === "/run/credentials" && !mount.RW)),
        // Host facts decide; the guest's own probe corroborates but cannot pass this on its own.
        "other-worker-unavailable": disjoint && mounts.every((list) => list.length === 3) && guestClean } };
  } finally { await broker.close(); }
}
