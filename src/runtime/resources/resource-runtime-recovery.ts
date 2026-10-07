import type { ResourceRuntimeBinding, ResourceRuntimeIdentity, ResourceRuntimeInspection } from "../../domain/resource-runtime.js";

type NativeIdentity = Extract<ResourceRuntimeIdentity, { kind: "native" }>;
export interface ResourceRuntimeRecoveryProbes {
  /** null = conclusively absent; undefined = unavailable/permission denied. */
  native: (pid: number) => Promise<NativeIdentity | null | undefined>;
  container: (containerId: string) => Promise<"running" | "terminated" | "unknown">;
  /** Must prove the entire lifetime's owned tree, not just the currently visible parent chain. */
  inventoryComplete: (binding: ResourceRuntimeBinding) => Promise<boolean>;
}

/** A read-only verifier. PID reuse never supplies authority to kill a replacement process. */
export class ResourceRuntimeRecovery {
  constructor(private readonly probes: ResourceRuntimeRecoveryProbes) {}
  async inspect(binding: ResourceRuntimeBinding): Promise<ResourceRuntimeInspection> {
    const inventoryComplete = await this.probes.inventoryComplete(binding);
    if (!inventoryComplete || !binding.identities.length)
      return { state: "unknown", inventoryComplete: false, identities: binding.identities };
    let running = false, unknown = false;
    for (const identity of binding.identities) {
      if (identity.kind === "container") {
        const state = await this.probes.container(identity.containerId);
        running ||= state === "running"; unknown ||= state === "unknown";
      } else {
        const actual = await this.probes.native(identity.pid);
        unknown ||= actual === undefined || actual !== null && actual.pid !== identity.pid;
        running ||= actual !== null && actual !== undefined && actual.pid === identity.pid && actual.startTime === identity.startTime;
      }
    }
    return { state: unknown ? "unknown" : running ? "running" : "terminated", inventoryComplete,
      identities: binding.identities };
  }
}
