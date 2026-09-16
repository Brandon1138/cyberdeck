import { z } from "zod";
import type { OrbStackClient } from "./orbstack-client.js";
import { integrationHash, integrationLabels, integrationNames, type IntegrationRecipe, type IntegrationServiceRequest } from "./integration-service-recipe.js";

const labels = z.record(z.string(), z.string()).nullable();
const ContainerSchema = z.object({
  Id: z.string().regex(/^[a-f0-9]{64}$/), Name: z.string(),
  Config: z.object({ Labels: labels, Image: z.string(), User: z.string() }),
  State: z.object({ Running: z.boolean(), ExitCode: z.number().int(), OOMKilled: z.boolean(), Health: z.object({ Status: z.string() }).optional() }),
  HostConfig: z.object({ Memory: z.number(), MemorySwap: z.number(), NanoCpus: z.number(), PidsLimit: z.number(),
    Privileged: z.boolean(), ReadonlyRootfs: z.boolean(), NetworkMode: z.string(), PidMode: z.string(), IpcMode: z.string(),
    CapAdd: z.array(z.string()).nullable(), CapDrop: z.array(z.string()).nullable(), SecurityOpt: z.array(z.string()).nullable(),
    PortBindings: z.record(z.string(), z.unknown()).nullable(), Binds: z.array(z.string()).nullable(), Devices: z.array(z.unknown()).nullable(),
  }),
  Mounts: z.array(z.object({ Type: z.string(), Name: z.string().optional(), Destination: z.string() })),
  NetworkSettings: z.object({ Networks: z.record(z.string(), z.unknown()) }),
});
export type ServiceContainer = z.infer<typeof ContainerSchema>;
export type ServiceResource = "service" | "runner" | "network" | "volume";

/** This adapter is private broker authority. It intentionally exposes no generic operation to a guest. */
export class IntegrationServiceEngine {
  constructor(private readonly client: OrbStackClient, readonly request: IntegrationServiceRequest, readonly recipe: IntegrationRecipe) {}
  command(args: string[]): Promise<string> { return this.client.command(args); }
  private checkLabels(actual: Record<string, string> | null): void {
    for (const [key, value] of Object.entries(integrationLabels(this.request, integrationHash(this.recipe))))
      if (actual?.[key] !== value) throw new Error("INTEGRATION_OWNERSHIP_MISMATCH");
  }
  async inspect(kind: ServiceResource): Promise<ServiceContainer | { Id: string } | undefined> {
    const name = integrationNames(this.request)[kind], container = kind === "service" || kind === "runner";
    const rows = (await this.command(container
      ? ["ps", "-a", "--filter", `name=^/${name}$`, "--format", "{{.Names}}"]
      : [kind, "ls", "--filter", `name=${name}`, "--format", "{{.Name}}"])).trim().split("\n").filter(Boolean);
    if (!rows.includes(name)) return undefined; // Absence only after a successful engine listing.
    if (rows.filter(row => row === name).length !== 1) throw new Error("INTEGRATION_RESOURCE_AMBIGUOUS");
    const raw = z.array(z.unknown()).length(1).parse(JSON.parse(await this.command(container ? ["inspect", name] : [kind, "inspect", name])))[0];
    if (container) {
      const result = ContainerSchema.parse(raw); this.checkLabels(result.Config.Labels);
      if (result.Name !== `/${name}`) throw new Error("INTEGRATION_OWNERSHIP_MISMATCH");
      return result;
    }
    const result = z.object({ Name: z.literal(name), Labels: labels, Id: z.string().optional(), Internal: z.boolean().optional(),
      Driver: z.string(), Options: z.record(z.string(), z.string()).nullable().optional(), Containers: z.record(z.string(), z.unknown()).optional() }).parse(raw);
    this.checkLabels(result.Labels);
    if (kind === "network" && (!result.Internal || result.Driver !== "bridge")) throw new Error("INTEGRATION_NETWORK_MISMATCH");
    if (kind === "volume" && (result.Driver !== "local" || result.Options?.type !== "tmpfs" || result.Options.device !== "tmpfs"
      || result.Options.o !== `size=${this.recipe.dataBytes},uid=999,gid=999,mode=1777`)) throw new Error("INTEGRATION_VOLUME_MISMATCH");
    return { Id: result.Id ?? result.Name };
  }
  async container(kind: "service" | "runner"): Promise<ServiceContainer | undefined> {
    const result = await this.inspect(kind);
    return result as ServiceContainer | undefined;
  }
  verifyBoundary(result: ServiceContainer, runner: boolean): void {
    const names = integrationNames(this.request), limits = runner ? this.recipe.runner : this.recipe.service, host = result.HostConfig;
    const networks = Object.keys(result.NetworkSettings.Networks);
    const volumes = result.Mounts.filter(m => m.Type !== "tmpfs");
    if (result.Config.Image !== this.recipe.image || result.Config.User !== "postgres" || host.Memory !== limits.memoryBytes
      || host.MemorySwap !== limits.memoryBytes || host.NanoCpus !== limits.cpus * 1e9 || host.PidsLimit !== limits.pids
      || host.Privileged || !host.ReadonlyRootfs || host.NetworkMode !== names.network || host.PidMode !== ""
      || !["private", ""].includes(host.IpcMode) || (host.CapAdd?.length ?? 0) !== 0 || !host.CapDrop?.includes("ALL")
      || !host.SecurityOpt?.some(s => s.startsWith("no-new-privileges")) || Object.keys(host.PortBindings ?? {}).length !== 0
      || (host.Binds?.length ?? 0) !== 0 || (host.Devices?.length ?? 0) !== 0
      || networks.length !== 1 || networks[0] !== names.network
      || (runner ? volumes.length !== 0 : volumes.length !== 1 || volumes[0]?.Type !== "volume"
        || volumes[0]?.Name !== names.volume || volumes[0]?.Destination !== "/var/lib/postgresql/data")) throw new Error("INTEGRATION_BOUNDARY_MISMATCH");
  }
  async createInfrastructure(): Promise<void> {
    const names = integrationNames(this.request);
    const args = Object.entries(integrationLabels(this.request, integrationHash(this.recipe))).flatMap(([k, v]) => ["--label", `${k}=${v}`]);
    for (const kind of ["network", "volume", "service", "runner"] as const)
      if (await this.inspect(kind)) throw new Error("INTEGRATION_RESOURCE_ALREADY_EXISTS");
    await this.command(["network", "create", "--internal", "--driver", "bridge", ...args, names.network]);
    if (!await this.inspect("network")) throw new Error("INTEGRATION_NETWORK_ABSENT");
    await this.command(["volume", "create", "--driver", "local", "--opt", "type=tmpfs", "--opt", "device=tmpfs",
      "--opt", `o=size=${this.recipe.dataBytes},uid=999,gid=999,mode=1777`, ...args, names.volume]);
    if (!await this.inspect("volume")) throw new Error("INTEGRATION_VOLUME_ABSENT");
  }
}
