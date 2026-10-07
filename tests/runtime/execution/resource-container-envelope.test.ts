import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { it, expect, vi } from "vitest";
import { OrbStackClient, type ContainerInspection } from "../../../src/runtime/execution/orbstack-client.js";
import { OrbStackExecutor } from "../../../src/runtime/execution/orbstack-executor.js";
import type { ExecutionLaunchInput } from "../../../src/orchestration/session/execution-ports.js";
import { containerLaunchContext } from "../../../src/runtime/execution/container-launch-context.js";
import type { SessionRecord } from "../../../src/domain/session.js";

it("admits eight granted preparations despite legacy two slots and enforces grant limits on both sandbox modes", async () => {
  const root = await mkdtemp(join(tmpdir(), "resource-envelope-"));
  try {
    const image = `sha256:${"a".repeat(64)}`, memoryBytes = 640 * 1024 ** 2;
    const inputs: ExecutionLaunchInput[] = Array.from({ length: 8 }, (_, i) => {
      const id = randomUUID();
      return { identity: { brokerId: randomUUID(), executionId: randomUUID(), workerId: id, sessionId: id, generation: 1 },
        record: { id, sandbox: i % 2 ? "workspace-write" : "read-only" } as SessionRecord,
        request: { executor: "orbstack-container", profile: "ordinary" },
        launch: { executable: "node", args: [], cwd: "/workspace", env: {} } };
    });
    const contexts = new Map(await Promise.all(inputs.map(async input => {
      const path = join(root, input.identity.executionId); await mkdir(path);
      return [input.identity.executionId, containerLaunchContext({ hostState: join(path, "state"), hostCredentials: path,
        reportingUrl: "http://host.docker.internal:1234/v1/report", workspace: { mode: "independent-clone", executionId: input.identity.executionId,
          hostPath: join(path, "clone"), guestPath: "/workspace", source: root, baseCommit: "a".repeat(40), branch: "work", manifestHash: "b".repeat(64) } })] as const;
    })));
    const client = new OrbStackClient("unix:///tmp/fixture");
    vi.spyOn(client, "capacity").mockResolvedValue({ cpus: 2, memory: 8 * 1024 ** 3 });
    const commands = vi.spyOn(client, "command").mockImplementation(async args => args[0] === "image" ? "1" : "0.250.250.254");
    vi.spyOn(client, "inspect").mockImplementation(async ref => {
      const context = contexts.get(ref.executionId)!, input = inputs.find(i => i.identity.executionId === ref.executionId)!;
      return { Id: "c".repeat(64), Name: "fixture", Config: { Labels: {}, User: "1000:1000", Image: image },
        State: { Running: false, ExitCode: 0, OOMKilled: false },
        HostConfig: { Memory: memoryBytes, MemorySwap: memoryBytes, NanoCpus: 1e9, Privileged: false, ReadonlyRootfs: true,
          PidsLimit: 96, PidMode: "", IpcMode: "private", NetworkMode: "bridge", CapAdd: null, Devices: [], CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges"], ExtraHosts: ["host.docker.internal:0.250.250.254"] },
        Mounts: [{ Source: context.workspace.hostPath, Destination: "/workspace", RW: input.record.sandbox !== "read-only" },
          { Source: context.hostState, Destination: "/home/worker", RW: true }, { Source: context.hostCredentials, Destination: "/run/credentials", RW: false }] } as ContainerInspection;
    });
    const prepare = vi.fn(async (input: ExecutionLaunchInput) => contexts.get(input.identity.executionId)!);
    const backend = new OrbStackExecutor({ client, profile: { image, cpus: 4, memoryBytes: 4 * 1024 ** 3, slots: 2, network: "egress" },
      grantedEnvelope: input => { if (!inputs.includes(input)) throw new Error("GRANT_REQUIRED"); return { memoryBytes, cpus: 1, pidLimit: 96 }; },
      contexts: { prepare, get: async ref => contexts.get(ref.executionId)! }, writableProxyPort: 1235,
      attach: () => { throw new Error("PREPARE_ONLY"); }, evidenceDirectory: root, onFailure: () => {} });
    await Promise.all(inputs.map(input => backend.prepare(input)));
    expect(backend.slots.snapshot().running).toHaveLength(8);
    for (const context of contexts.values()) expect(JSON.parse(await readFile(join(context.hostCredentials, "launch.json"), "utf8")).networkRestricted).toBe(true);
    const dns = commands.mock.calls.map(([args]) => args).filter(args => args[0] === "run");
    expect(dns).toHaveLength(8);
    for (const args of dns) { expect(args).toContain("--memory-swap"); expect(args).toContain("--pids-limit"); expect(args).toContain("--name"); }
    await expect(backend.prepare({ ...inputs[0]! })).rejects.toThrow("GRANT_REQUIRED");
    expect(prepare).toHaveBeenCalledTimes(8);
  } finally { await rm(root, { recursive: true, force: true }); }
});
