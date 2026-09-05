import { request } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { ExecutionRef } from "../../domain/worker-execution.js";

const exec = promisify(execFile);
const InspectionSchema = z.object({
  Id: z.string(), Name: z.string(),
  Config: z.object({ Labels: z.record(z.string(), z.string()).nullable(), User: z.string(), Image: z.string() }),
  State: z.object({ Running: z.boolean(), ExitCode: z.number(), OOMKilled: z.boolean() }),
  HostConfig: z.object({ Memory: z.number(), NanoCpus: z.number(), Privileged: z.boolean(), NetworkMode: z.string(), CapDrop: z.array(z.string()).nullable(), SecurityOpt: z.array(z.string()).nullable() }),
  Mounts: z.array(z.object({ Source: z.string(), Destination: z.string(), RW: z.boolean() })),
});
export type ContainerInspection = z.infer<typeof InspectionSchema>;
export type DockerRunner = (args: string[]) => Promise<string>;
export class OrbStackClient {
  constructor(readonly endpoint: string, private readonly run: DockerRunner = async (args) =>
    (await exec("docker", args, { env: { PATH: process.env.PATH, HOME: process.env.HOME }, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 })).stdout,
  ) { if (!endpoint.startsWith("unix:///")) throw new Error("ORBSTACK_ENDPOINT_INVALID"); }
  async verify(): Promise<void> {
    const context: unknown = JSON.parse(await this.run(["--context", "orbstack", "context", "inspect", "orbstack"]));
    const contexts = z.array(z.object({ Name: z.literal("orbstack"), Endpoints: z.object({ docker: z.object({ Host: z.literal(this.endpoint) }) }) })).length(1);
    contexts.parse(context);
  }
  async command(args: string[]): Promise<string> {
    await this.verify();
    return this.run(["--context", "orbstack", ...args]);
  }
  async capacity(): Promise<{ cpus: number; memory: number }> {
    const info = z.object({ NCPU: z.number().positive(), MemTotal: z.number().positive(), MemoryLimit: z.literal(true) }).parse(JSON.parse(await this.command(["info", "--format", "{{json .}}"]))) ;
    return { cpus: info.NCPU, memory: info.MemTotal };
  }
  async inspect(ref: ExecutionRef): Promise<ContainerInspection | undefined> {
    const name = containerName(ref);
    // A successful filtered listing distinguishes absent from daemon/transport failure.
    const ids = (await this.command(["ps", "-a", "--filter", `name=^/${name}$`, "--format", "{{.ID}}"])).trim();
    if (!ids) return undefined;
    const inspected = z.array(InspectionSchema).length(1).parse(JSON.parse(await this.command(["inspect", name])))[0]!;
    const labels = inspected.Config.Labels ?? {};
    if (labels["cyberdeck.broker"] !== ref.brokerId || labels["cyberdeck.execution"] !== ref.executionId
      || labels["cyberdeck.worker"] !== ref.workerId || (ref.backendId && ref.backendId !== inspected.Id)) throw new Error("CONTAINER_OWNERSHIP_MISMATCH");
    return inspected;
  }
  async resize(ref: ExecutionRef, cols: number, rows: number): Promise<void> {
    await this.verify();
    if (!/^[a-f0-9]{64}$/.test(ref.backendId ?? "")) throw new Error("CONTAINER_ID_INVALID");
    await new Promise<void>((resolve, reject) => {
      const req = request({ socketPath: this.endpoint.slice("unix://".length), method: "POST",
        path: `/containers/${ref.backendId}/resize?w=${cols}&h=${rows}` }, (response) => {
        response.resume();
        response.on("end", () => response.statusCode === 200 ? resolve() : reject(new Error("CONTAINER_RESIZE_FAILED")));
      });
      req.once("error", reject); req.setTimeout(5_000, () => req.destroy(new Error("CONTAINER_RESIZE_TIMEOUT"))); req.end();
    });
  }
  async stop(ref: ExecutionRef, force: boolean): Promise<ContainerInspection | undefined> {
    const current = await this.inspect(ref);
    if (!current?.State.Running) return current;
    await this.command(force ? ["kill", current.Id] : ["stop", "--timeout", "10", current.Id]);
    const stopped = await this.inspect(ref);
    if (stopped?.State.Running) throw new Error("CONTAINER_STOP_UNCONFIRMED");
    return stopped;
  }
}
export function containerName(ref: Pick<ExecutionRef, "brokerId" | "executionId">): string {
  z.uuid().parse(ref.brokerId); z.uuid().parse(ref.executionId);
  return `cyberdeck-${ref.brokerId}-${ref.executionId}`;
}
