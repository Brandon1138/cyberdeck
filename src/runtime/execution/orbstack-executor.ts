import { writeAtomicPrivateFile } from "../../persistence/atomic-private-file.js";
import { mkdir, readFile, open } from "node:fs/promises";
import { join } from "node:path";
import type { SessionRuntime, SessionRuntimeFactory } from "../../domain/session-runtime.js";
import type { ExecutionInspection, ExecutionRef } from "../../domain/worker-execution.js";
import type { ExecutionLaunchInput, PreparedExecution, WorkerExecutionPort, CollectedExecution } from "../../orchestration/session/execution-ports.js";
import type { ProviderLaunchSpec } from "../../orchestration/session/provider-ports.js";
import { ExecutionSlotScheduler } from "../../orchestration/execution-slot-scheduler.js";
import type { ContainerLaunchContext } from "./container-launch-context.js";
import { ContainerSessionRuntime } from "./container-session-runtime.js";
import { OrbStackClient, containerName } from "./orbstack-client.js";
import { contentHash, workspaceManifest } from "./workspace-manifest.js";
import { prepareWorkerNetwork, activateWorkerNetwork } from "./worker-network-boundary.js";

export interface ContainerProfile {
  image: string; cpus: number; memoryBytes: number; slots: number; network: "none" | "egress";
}
export interface OrbStackExecutorOptions {
  client: OrbStackClient;
  profile: ContainerProfile;
  contexts: { prepare(input: ExecutionLaunchInput): Promise<ContainerLaunchContext>; get(ref: ExecutionRef): Promise<ContainerLaunchContext>; release?(ref: ExecutionRef): Promise<void> };
  attach: SessionRuntimeFactory<ProviderLaunchSpec>;
  evidenceDirectory: string;
  onFailure(error: unknown): void;
  writableProxyPort?: number;
}
/**
 * `network: none` is a configured value with no launch path today. The guest gates its provider
 * process on the authenticated readiness endpoint and reports through the same host gateway,
 * both TCP to host.docker.internal, and every supported provider needs egress to its model API.
 * Until a host-reachable transport that needs no network is proved on OrbStack, the profile is
 * refused at prepare and reported as unsupported; it is never silently launched as egress.
 */
export function networkProfileSupport(network: ContainerProfile["network"]): { supported: boolean; reason?: string } {
  return network === "none"
    ? { supported: false, reason: "readiness/report gateway and provider APIs require egress; no non-network transport is proved" }
    : { supported: true };
}
export class OrbStackExecutor implements WorkerExecutionPort {
  readonly slots: ExecutionSlotScheduler;
  private readonly reservations = new Map<string, () => void>();
  constructor(private readonly options: OrbStackExecutorOptions) {
    const p = options.profile;
    if (!/^sha256:[a-f0-9]{64}$/.test(p.image) || !Number.isFinite(p.cpus) || p.cpus <= 0
      || !Number.isSafeInteger(p.memoryBytes) || p.memoryBytes < 64 * 1024 * 1024) throw new Error("CONTAINER_PROFILE_INVALID");
    this.slots = new ExecutionSlotScheduler(p.slots);
  }
  support(): { network: ContainerProfile["network"]; supported: boolean; reason?: string } {
    return { network: this.options.profile.network, ...networkProfileSupport(this.options.profile.network) };
  }
  async prepare(input: ExecutionLaunchInput): Promise<PreparedExecution> {
    const { client, profile } = this.options;
    if (!networkProfileSupport(profile.network).supported) throw new Error("CONTAINER_NETWORK_PROFILE_UNSUPPORTED");
    if (input.launch.cwd !== "/workspace" || !["node", "claude", "codex"].includes(input.launch.executable)
      || Object.keys(input.launch.env).some((key) => !["TERM", "DISABLE_UPDATES", "ENABLE_TOOL_SEARCH", "CYBERDECK_PROCESS_ROLE", "CYBERDECK_WORKER_MODE", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS"].includes(key))) {
      throw new Error("CONTAINER_LAUNCH_NOT_TARGETED");
    }
    const capacity = await client.capacity();
    if (profile.slots * profile.cpus > capacity.cpus || profile.slots * profile.memoryBytes > capacity.memory * 0.8) throw new Error("CONTAINER_CAPACITY_EXCEEDED");
    const release = await this.slots.reserve(input.identity.executionId, input.signal);
    this.reservations.set(input.identity.executionId, release);
    try {
      input.signal?.throwIfAborted();
      const context = await this.options.contexts.prepare(input);
      const networkHost = input.record.sandbox !== "read-only"
        ? await prepareWorkerNetwork(client, profile.image, context, this.options.writableProxyPort ?? 0) : undefined;
      input.signal?.throwIfAborted();
      let ref: ExecutionRef = { ...input.identity, executor: "orbstack-container", workspaceId: context.workspace.hostPath };
      // Launch data is local-only, protected by the credentials mount, never Docker metadata.
      await writeAtomicPrivateFile(join(context.hostCredentials, "launch.json"), JSON.stringify({ executable: input.launch.executable,
        args: input.launch.args, env: input.launch.env, cwd: context.guest.workspace, networkRestricted: input.record.sandbox !== "read-only" }));
      let inspected = await client.inspect(ref);
      input.signal?.throwIfAborted();
      if (inspected === undefined) {
        const mount = (source: string, target: string, readonly: boolean) => {
          if (source.includes(",")) throw new Error("CONTAINER_MOUNT_PATH_UNSUPPORTED");
          return `type=bind,src=${source},dst=${target}${readonly ? ",readonly" : ""}`;
        };
        const args = ["create", "--name", containerName(ref),
          "--label", `cyberdeck.broker=${ref.brokerId}`, "--label", `cyberdeck.worker=${ref.workerId}`,
          "--label", `cyberdeck.execution=${ref.executionId}`, "--init", "--user", "1000:1000",
          "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only", "--pids-limit", "512",
          "--cpus", String(profile.cpus), "--memory", String(profile.memoryBytes), "--memory-swap", String(profile.memoryBytes),
          "--network", profile.network === "none" ? "none" : "bridge", "--interactive",
          ...(networkHost ? ["--add-host", `host.docker.internal:${networkHost}`] : []),
          ...(input.launch.transport === "pipe" ? [] : ["--tty"]),
          "--tmpfs", "/tmp:rw,nosuid,nodev,size=268435456", "--mount", mount(context.workspace.hostPath, "/workspace", input.record.sandbox === "read-only"),
          "--mount", mount(context.hostState, "/home/worker", false), "--mount", mount(context.hostCredentials, "/run/credentials", true),
          "--env", `CYBERDECK_REPORT_URL=${context.reportingUrl}`, profile.image, "node", "/opt/cyberdeck/launch.mjs"];
        const backendId = (await client.command(args)).trim();
        if (!/^[a-f0-9]{64}$/.test(backendId)) throw new Error("CONTAINER_ID_INVALID");
        ref = { ...ref, backendId };
        inspected = await client.inspect(ref);
      }
      input.signal?.throwIfAborted();
      if (!inspected || inspected.State.Running) throw new Error("CONTAINER_NOT_READY");
      ref = { ...ref, backendId: inspected.Id };
      const host = inspected.HostConfig;
      const mounts = inspected.Mounts;
      if (inspected.Config.Image !== profile.image || inspected.Config.User !== "1000:1000"
        || host.Privileged || host.Memory !== profile.memoryBytes || host.NanoCpus !== profile.cpus * 1e9
        || host.MemorySwap !== profile.memoryBytes || !host.ReadonlyRootfs || host.PidsLimit !== 512
        || host.NetworkMode !== "bridge" || host.PidMode !== "" || !["private", ""].includes(host.IpcMode)
        || (networkHost !== undefined && (host.ExtraHosts?.length !== 1 || host.ExtraHosts[0] !== `host.docker.internal:${networkHost}`))
        || (host.CapAdd?.length ?? 0) !== 0 || (host.Devices?.length ?? 0) !== 0
        || !host.CapDrop?.includes("ALL") || !host.SecurityOpt?.some((s) => s.startsWith("no-new-privileges"))
        || mounts.length !== 3 || !mounts.some((m) => m.Source === context.workspace.hostPath && m.Destination === "/workspace" && m.RW === (input.record.sandbox !== "read-only"))
        || !mounts.some((m) => m.Source === context.hostState && m.Destination === "/home/worker" && m.RW)
        || !mounts.some((m) => m.Source === context.hostCredentials && m.Destination === "/run/credentials" && !m.RW)) throw new Error("CONTAINER_BOUNDARY_MISMATCH");
      return { ref, launch: input.launch };
    } catch (error) { this.release(input.identity.executionId); throw error; }
  }
  async start(prepared: PreparedExecution, replayBytes: number): Promise<SessionRuntime> {
    try {
      await this.options.client.verify();
      const attached = this.options.attach({ executable: "docker", args: ["--context", "orbstack", "start", "--attach", "--interactive", prepared.ref.backendId!],
        cwd: prepared.ref.workspaceId, env: { PATH: process.env.PATH, HOME: process.env.HOME },
        ...(prepared.launch.transport === undefined ? {} : { transport: prepared.launch.transport }),
      }, replayBytes);
      const context = await this.options.contexts.get(prepared.ref);
      const spec = JSON.parse(await readFile(join(context.hostCredentials, "launch.json"), "utf8"));
      if (spec.networkRestricted === true) await activateWorkerNetwork(this.options.client, this.options.profile.image, prepared.ref, context);
      return new ContainerSessionRuntime(attached, this.options.client, prepared.ref,
        () => this.release(prepared.ref.executionId), this.options.onFailure);
    } catch (error) {
      try { await this.stop(prepared.ref, true); } catch (cleanup) { this.options.onFailure(cleanup); }
      throw error;
    }
  }
  async inspect(ref: ExecutionRef): Promise<ExecutionInspection> {
    try {
      const result = await this.options.client.inspect(ref);
      return result === undefined ? { ref, state: "absent" } : { ref, state: result.State.Running ? "running" : "stopped", guestExitCode: result.State.ExitCode, oomKilled: result.State.OOMKilled };
    } catch { return { ref, state: "unreachable" }; }
  }
  async stop(ref: ExecutionRef, force: boolean): Promise<ExecutionInspection> {
    const result = await this.options.client.stop(ref, force);
    this.release(ref.executionId);
    return result ? { ref, state: "stopped", guestExitCode: result.State.ExitCode, oomKilled: result.State.OOMKilled } : { ref, state: "absent" };
  }
  async collect(ref: ExecutionRef): Promise<CollectedExecution> {
    const state = await this.inspect(ref);
    if (state.state !== "stopped" && state.state !== "absent") throw new Error("CONTAINER_COLLECTION_REQUIRES_STOP");
    const context = await this.options.contexts.get(ref).catch((error: NodeJS.ErrnoException) => {
      if (state.state === "absent" && error.code === "ENOENT") return undefined;
      throw error;
    });
    // Never use ref.workspaceId here: failed preparation can still name the user's source.
    const files = context ? await workspaceManifest(context.workspace.hostPath) : [];
    const providerFiles = context ? await workspaceManifest(context.hostState, 512 * 1024 * 1024, true) : [];
    const logs = state.state === "absent" ? null : await this.options.client.command(["logs", "--timestamps", ref.backendId ?? containerName(ref)]);
    const payload = { ref, state, files, providerFiles, logs, contextAvailable: context !== undefined };
    const body = JSON.stringify({ payload, sha256: contentHash(JSON.stringify(payload)) });
    await mkdir(this.options.evidenceDirectory, { recursive: true, mode: 0o700 });
    const manifestRef = join(this.options.evidenceDirectory, `${ref.executionId}-${ref.generation}.json`);
    const handle = await open(manifestRef, "w", 0o600);
    try { await handle.writeFile(body); await handle.sync(); } finally { await handle.close(); }
    return { manifestRef, complete: true };
  }
  async destroy(ref: ExecutionRef): Promise<void> {
    const manifest = JSON.parse(await readFile(join(this.options.evidenceDirectory, `${ref.executionId}-${ref.generation}.json`), "utf8")) as { payload: { ref: ExecutionRef }; sha256: string };
    if (manifest.sha256 !== contentHash(JSON.stringify(manifest.payload)) || JSON.stringify(manifest.payload.ref) !== JSON.stringify(ref)) throw new Error("CONTAINER_COLLECTION_UNVERIFIED");
    const inspected = await this.options.client.inspect(ref);
    if (inspected === undefined) { await this.options.contexts.release?.(ref); return; }
    if (inspected.State.Running) throw new Error("CONTAINER_STILL_RUNNING");
    await this.options.client.command(["rm", inspected.Id]);
    await this.options.contexts.release?.(ref);
  }
  private release(id: string): void { this.reservations.get(id)?.(); this.reservations.delete(id); }
}
