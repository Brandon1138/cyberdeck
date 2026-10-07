import { z } from "zod";
import type { OrbStackClient } from "./orbstack-client.js";
import { evaluatorLabels, evaluatorName, type EvaluatorState, type EvaluatorFiles } from "./task-evaluation-executor-state.js";

const Container = z.object({ Id: z.string().regex(/^[a-f0-9]{64}$/), Name: z.string(),
  Config: z.object({ Image: z.string(), User: z.string(), Labels: z.record(z.string(), z.string()).nullable() }),
  State: z.object({ Running: z.boolean(), Pid: z.number().int().nonnegative(), ExitCode: z.number().int(), OOMKilled: z.boolean(),
    Status: z.string().optional(), StartedAt: z.string().optional() }),
  HostConfig: z.object({ Memory: z.number(), MemorySwap: z.number(), NanoCpus: z.number(), PidsLimit: z.number(),
    NetworkMode: z.string(), Privileged: z.boolean(), ReadonlyRootfs: z.boolean(), PidMode: z.string(), IpcMode: z.string(),
    CapAdd: z.array(z.string()).nullable(), CapDrop: z.array(z.string()).nullable(), SecurityOpt: z.array(z.string()).nullable(),
    Binds: z.array(z.string()).nullable(), Devices: z.array(z.unknown()).nullable(), PortBindings: z.record(z.string(), z.unknown()).nullable(),
    Tmpfs: z.record(z.string(), z.string()), RestartPolicy: z.object({ Name: z.string() }),
    LogConfig: z.object({ Type: z.string(), Config: z.record(z.string(), z.string()) }),
  }), Mounts: z.array(z.object({ Type: z.string(), Source: z.string().optional(), Destination: z.string(), RW: z.boolean() })),
  NetworkSettings: z.object({ Networks: z.record(z.string(), z.unknown()) }),
});
export type EvaluatorContainer = z.infer<typeof Container>;
export class EvaluatorEngine {
  constructor(private readonly client: OrbStackClient, private readonly files: EvaluatorFiles) {}
  command(args: string[]): Promise<string> { return this.client.command(args); }
  async inspect(state: EvaluatorState): Promise<EvaluatorContainer | undefined> {
    const name = evaluatorName(state);
    const ids = (await this.command(["ps", "-a", "--filter", `name=^/${name}$`, "--format", "{{.ID}}"])).trim();
    if (!ids) return undefined;
    const current = z.array(Container).length(1).parse(JSON.parse(await this.command(["inspect", name])))[0]!;
    if (current.Name !== `/${name}` || state.backendId && state.backendId !== current.Id) throw new Error("EVALUATOR_OWNERSHIP_MISMATCH");
    for (const [key, value] of Object.entries(evaluatorLabels(state))) if (current.Config.Labels?.[key] !== value) throw new Error("EVALUATOR_OWNERSHIP_MISMATCH");
    return current;
  }
  verify(state: EvaluatorState, current: EvaluatorContainer): void {
    const host = current.HostConfig, mounts = current.Mounts.filter(m => m.Type !== "tmpfs"), networks = Object.keys(current.NetworkSettings.Networks);
    if (current.Config.Image !== state.image || current.Config.User !== "1000:1000" || host.Privileged || !host.ReadonlyRootfs
      || host.Memory !== state.resource.demand.memoryBytes || host.MemorySwap !== host.Memory || host.NanoCpus !== 500000000
      || host.PidsLimit !== 64 || host.NetworkMode !== "none" || networks.some(name => name !== "none")
      || host.PidMode !== "" || !["", "private"].includes(host.IpcMode) || host.RestartPolicy.Name !== "no"
      || (host.CapAdd?.length ?? 0) !== 0 || !host.CapDrop?.includes("ALL") || !host.SecurityOpt?.some(s => ["no-new-privileges", "no-new-privileges:true"].includes(s))
      || (host.Binds?.length ?? 0) !== 0 || (host.Devices?.length ?? 0) !== 0 || Object.keys(host.PortBindings ?? {}).length !== 0
      || Object.keys(host.Tmpfs).length !== 2 || host.Tmpfs["/tmp"] !== "rw,nosuid,nodev,noexec,size=134217728"
      || host.Tmpfs["/run/evaluation"] !== "rw,nosuid,nodev,noexec,size=16777216,mode=1777"
      || host.LogConfig.Type !== "local" || host.LogConfig.Config["max-size"] !== "1m" || host.LogConfig.Config["max-file"] !== "1"
      || mounts.length !== 1 || mounts[0]?.Type !== "bind" || mounts[0].Source !== this.files.path(state.runId, "input.json")
      || mounts[0].Destination !== "/run/input.json" || mounts[0].RW) throw new Error("EVALUATOR_BOUNDARY_MISMATCH");
  }
  args(state: EvaluatorState): string[] {
    const source = this.files.path(state.runId, "input.json");
    if (source.includes(",")) throw new Error("EVALUATOR_INPUT_PATH_INVALID");
    const labels = Object.entries(evaluatorLabels(state)).flatMap(([key, value]) => ["--label", `${key}=${value}`]);
    return ["create", "--pull", "never", "--name", evaluatorName(state), ...labels, "--init", "--user", "1000:1000",
      "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--network", "none", "--restart", "no",
      "--memory", String(state.resource.demand.memoryBytes), "--memory-swap", String(state.resource.demand.memoryBytes), "--cpus", "0.5", "--pids-limit", "64",
      "--log-driver", "local", "--log-opt", "max-size=1m", "--log-opt", "max-file=1", "--log-opt", "compress=false",
      "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=134217728", "--tmpfs", "/run/evaluation:rw,nosuid,nodev,noexec,size=16777216,mode=1777",
      "--mount", `type=bind,src=${source},dst=/run/input.json,readonly`, "--env", "HOME=/tmp/home", "--env", "PROMPTFOO_DISABLE_TELEMETRY=1",
      "--env", "PROMPTFOO_DISABLE_UPDATE=1", "--env", `NODE_OPTIONS=--max-old-space-size=${Math.floor(state.resource.demand.memoryBytes / 1024 ** 2 * 0.6)}`,
      "--entrypoint", "node", state.image, "/opt/evaluator/production/container-entrypoint.mjs"];
  }
}
