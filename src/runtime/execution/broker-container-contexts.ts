import { writeAtomicPrivateFile } from "../../persistence/atomic-private-file.js";
import { mkdir, readFile, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ExecutionRef } from "../../domain/worker-execution.js";
import type { ExecutionLaunchInput } from "../../orchestration/session/execution-ports.js";
import type { WorkerGateway } from "../../broker/worker-gateway.js";
import { PrivateCloneProvisioner } from "./isolated-workspace.js";
import { containerLaunchContext, type ContainerLaunchContext } from "./container-launch-context.js";
import { trustedGit } from "./trusted-git.js";
import { readSelectedInputs } from "./read-selected-inputs.js";
import { prepareContainerWorkspaceTrust } from "./container-workspace-trust.js";
import type { ContainerAuthentication } from "../../domain/container-authentication.js";
import { resolveContainerCredential } from "./subscription-credentials.js";

export class BrokerContainerContexts {
  constructor(private readonly root: string, private readonly credentialFiles: Record<string, string>,
    private readonly gateway: WorkerGateway, private readonly gatewayPort: number,
    private readonly allowsWorkspaceTrust?: (source: string) => Promise<boolean>,
    private readonly authentication: Record<string, ContainerAuthentication> = {},
    private readonly attemptTimeoutMinutes = 60,
  ) {}
  async prepare(input: ExecutionLaunchInput): Promise<ContainerLaunchContext> {
    const { record, identity } = input;
    const auth = this.authentication[record.provider] ?? (this.credentialFiles[record.provider]
      ? { kind: "api-key" as const, file: this.credentialFiles[record.provider]! } : undefined);
    if (!auth) throw new Error("CONTAINER_CREDENTIALS_UNAVAILABLE");
    const credential = await resolveContainerCredential(record.provider, auth, this.attemptTimeoutMinutes * 60_000);
    let existing: ContainerLaunchContext | undefined;
    try { existing = await this.get({ ...identity, executor: "orbstack-container", workspaceId: "pending" }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const hostState = join(this.root, "provider-state", record.id), hostCredentials = join(this.root, "credentials", record.id);
    await mkdir(hostState, { recursive: true, mode: 0o700 }); await mkdir(hostCredentials, { recursive: true, mode: 0o700 });
    const token = this.gateway.issue({ workerId: record.id, executionId: identity.executionId, generation: identity.generation });
    await writeAtomicPrivateFile(join(hostCredentials, "provider.json"), JSON.stringify(credential));
    await writeAtomicPrivateFile(join(hostCredentials, "reporting-token"), token);
    let workspace = existing?.workspace;
    if (workspace === undefined) {
      const source = record.cwd;
      const root = (await trustedGit(source, ["rev-parse", "--show-toplevel"])).toString().trim();
      if (root !== await realpath(source)) throw new Error("CONTAINER_CWD_MUST_BE_REPO_ROOT");
      const baseRef = record.workspace?.baseRef ?? "HEAD";
      const baseCommit = (await trustedGit(source, ["rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`])).toString().trim();
      workspace = await new PrivateCloneProvisioner(join(this.root, "clones")).provision({
        executionId: identity.executionId, source, baseCommit, branch: record.workspace?.branch ?? `worker/${record.id}`,
        inputs: await readSelectedInputs(source, record.workspace?.selectedInputs),
      });
    }
    const context = containerLaunchContext({ workspace, hostState, hostCredentials, reportingUrl: `http://host.docker.internal:${this.gatewayPort}/v1/report` });
    await prepareContainerWorkspaceTrust(context, record.provider, this.allowsWorkspaceTrust);
    await mkdir(join(this.root, "contexts"), { recursive: true, mode: 0o700 });
    await writeAtomicPrivateFile(join(this.root, "contexts", `${identity.executionId}.json`), JSON.stringify(context));
    record.cwd = workspace.hostPath;
    record.workspace = { provisioning: "pre-provisioned", storage: "independent-clone", worktreePath: workspace.hostPath, repositoryPath: workspace.source,
      branch: workspace.branch, baseRef: workspace.baseCommit, writableRoots: [] };
    return context;
  }
  async get(ref: ExecutionRef): Promise<ContainerLaunchContext> {
    const parsed = JSON.parse(await readFile(join(this.root, "contexts", `${ref.executionId}.json`), "utf8"));
    if (parsed.workspace?.executionId !== ref.executionId
      || parsed.workspace?.hostPath !== join(this.root, "clones", ref.executionId)
      || parsed.hostState !== join(this.root, "provider-state", ref.workerId)
      || parsed.hostCredentials !== join(this.root, "credentials", ref.workerId)) throw new Error("CONTAINER_CONTEXT_MISMATCH");
    return containerLaunchContext(parsed);
  }
  async release(ref: ExecutionRef): Promise<void> {
    const context = await this.get(ref);
    this.gateway.revoke(ref.executionId);
    // Only the private staged copy is retired; the configured credential source is untouched.
    await rm(context.hostCredentials, { recursive: true, force: true });
  }
}
