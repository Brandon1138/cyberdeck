import { mkdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ResourceAdmissionPort, ResourceDecision, ResourceRequest } from "../../domain/resource-budget.js";
import type { ResourceRuntimeBindingPort, ResourceRuntimeIdentity } from "../../domain/resource-runtime.js";
import { NativeToolRequestSchema, type NativeCommandResult, type NativeProcessSupervisor,
  type NativeToolAuthorization, type NativeToolRecipe, type NativeToolRequest } from "./native-tool-types.js";
import { nativeManifestHash, prepareNativeWorkspace, writeNativeRecord } from "./native-tool-workspace.js";
import { safeRelativePath } from "./workspace-manifest.js";
import { NativeToolSimulator } from "./native-tool-simulator.js";

export interface NativeToolExecutorOptions {
  admission: ResourceAdmissionPort;
  bindings: ResourceRuntimeBindingPort;
  installationId: string;
  rootDirectory: string;
  recipes: readonly NativeToolRecipe[];
  authorize: (request: NativeToolRequest) => Promise<NativeToolAuthorization>;
  supervisor: NativeProcessSupervisor;
  /** Composition persists evaluation/outbox intent; rejection retains the reservation for reconciliation. */
  settled?: (result: Extract<NativeToolResult, { state: "finished" }>) => Promise<void>;
  /** Requires lifetime process AND simulator service inventory, not a current PID-table scan. */
  proveTermination?: (request: NativeToolRequest, identities: ResourceRuntimeIdentity[], directory: string) => Promise<boolean>;
}
export type NativeToolResult = Exclude<ResourceDecision, { state: "admitted" }> | {
  state: "finished"; request: NativeToolRequest; result: NativeCommandResult;
  artifactsDirectory: string; inputManifestSha256: string;
  isolation: "native-user-filesystem";
};

/** Narrow auxiliary executor; canonical worker authority and generation are checked by composition. */
export class NativeToolExecutor {
  private readonly recipes: Map<string, NativeToolRecipe>;
  private readonly active = new Set<string>();
  constructor(private readonly options: NativeToolExecutorOptions) {
    if (!isAbsolute(options.rootDirectory)) throw new Error("native-root-must-be-absolute");
    this.recipes = new Map(options.recipes.map(recipe => {
      safeRelativePath(recipe.project);
      if (!/^[a-f0-9]{64}$/.test(recipe.inputManifestSha256)
        || !/^com\.apple\.CoreSimulator\.SimRuntime\.iOS-[\d-]+$/.test(recipe.simulatorRuntime)
        || !/^com\.apple\.CoreSimulator\.SimDeviceType\.[\w-]+$/.test(recipe.simulatorDeviceType)
        || !isAbsolute(recipe.developerDirectory) || !/^[\w.-]+$/.test(recipe.scheme)
        || recipe.timeoutMs < 1 || recipe.timeoutMs > 3600000 || recipe.maxInputBytes < 1 || recipe.maxArtifactBytes < 1)
        throw new Error("invalid-native-recipe");
      return [recipe.id, structuredClone(recipe)];
    }));
    if (this.recipes.size !== options.recipes.length) throw new Error("duplicate-native-recipe");
  }
  async execute(input: NativeToolRequest, signal?: AbortSignal): Promise<NativeToolResult> {
    const request = NativeToolRequestSchema.parse(input);
    const recipe = this.recipes.get(request.recipeId);
    if (!recipe) throw new Error("native-recipe-unavailable");
    if (this.active.has(request.requestId)) throw new Error("native-request-active");
    this.active.add(request.requestId);
    try { return await this.executeAuthorized(request, recipe, signal); }
    finally { this.active.delete(request.requestId); }
  }
  /** Retire this durable request without consulting authority that may already be stale. */
  async cancelPending(input: NativeToolRequest): Promise<{ cleanupComplete: boolean }> {
    const request = NativeToolRequestSchema.parse(input);
    if (this.active.has(request.requestId)) throw new Error("native-request-active");
    this.active.add(request.requestId);
    try { return await this.retireOwned(request); }
    finally { this.active.delete(request.requestId); }
  }
  /** Recovery never runs a tool or infers native lifetime completion from current PIDs. */
  async recover(input: NativeToolRequest): Promise<{ cleanupComplete: boolean; result?: Extract<NativeToolResult, { state: "finished" }> }> {
    const request = NativeToolRequestSchema.parse(input), cleanup = await this.cancelPending(request);
    try {
      const result = JSON.parse(await readFile(join(this.options.rootDirectory, request.requestId, "result.json"), "utf8")) as Extract<NativeToolResult, { state: "finished" }>;
      if (result.state !== "finished" || JSON.stringify(NativeToolRequestSchema.parse(result.request)) !== JSON.stringify(request))
        throw new Error("native-recovery-result-mismatch");
      return { ...cleanup, result };
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return cleanup; throw error; }
  }
  private async retireOwned(request: NativeToolRequest): Promise<{ cleanupComplete: boolean }> {
    const key = `native-${request.requestId}`, binding = this.options.bindings.get(key);
    if (!binding) return { cleanupComplete: true }; // Intent always precedes admission.
    const resource = binding.request;
    if (resource.requestId !== key || resource.owner.installationId !== this.options.installationId
      || resource.owner.kind !== "service" || ![key, request.attemptId].includes(resource.owner.workloadId)
      || resource.owner.executionId !== request.executionId || resource.owner.generation !== request.generation)
      throw new Error("native-recovery-identity-mismatch");
    // Accept legacy attemptId owners only for recovery; new requests always use their unique key.
    if (["launching", "bound"].includes(binding.phase) || binding.identities.length) return { cleanupComplete: false };
    await this.options.bindings.put({ ...binding, phase: "terminated" }); // Durable never-launched proof before release.
    try { await this.options.admission.cancel(key); }
    catch (error) {
      if (!(error instanceof Error) || error.message !== "RESOURCE_TERMINATION_REQUIRED") throw error;
      // refresh() may have admitted a previously waiting request. Reuse its immutable identity.
      const decision = await this.options.admission.request(resource);
      if (decision.state !== "admitted") throw new Error("native-recovery-admission-unconfirmed");
      await this.options.admission.release({ reservationId: decision.reservationId, terminationEvidenceId: `${key}-not-launched` });
    }
    return { cleanupComplete: true };
  }
  private async executeAuthorized(request: NativeToolRequest, recipe: NativeToolRecipe, signal?: AbortSignal): Promise<NativeToolResult> {
    const authority = await this.options.authorize(request);
    if (!authority.writeAllowed) throw new Error("native-write-policy-refused");
    const hash = nativeManifestHash(authority.inputManifest);
    if (hash !== recipe.inputManifestSha256) throw new Error("native-recipe-input-mismatch");
    const resource: ResourceRequest = { requestId: `native-${request.requestId}`, priority: "interactive",
      owner: { installationId: this.options.installationId, workloadId: `native-${request.requestId}`,
        executionId: request.executionId, generation: request.generation, familyId: authority.familyId, kind: "service" },
      demand: recipe.demand };
    const prior = this.options.bindings.get(resource.requestId);
    if (prior && prior.phase !== "queued") throw new Error("native-request-already-launched");
    if (prior && JSON.stringify(prior.request) !== JSON.stringify(resource)) throw new Error("native-request-identity-changed");
    await this.options.bindings.put({ request: resource, phase: "queued", identities: [] });
    if (signal?.aborted) { await this.retireOwned(request); throw new Error("native-cancelled-before-launch"); }
    const decision = await this.options.admission.request(resource);
    if (decision.state !== "admitted") return decision;
    await this.options.bindings.put({ request: resource, phase: "reserved", identities: [] });
    let launching = false;
    try {
      // Recheck authority after potentially long queueing; no stale generation or handoff grants.
      const current = await this.options.authorize(request);
      if (!current.writeAllowed || current.familyId !== authority.familyId || current.workspaceRoot !== authority.workspaceRoot
        || nativeManifestHash(current.inputManifest) !== hash) throw new Error("native-authority-changed");
      if (signal?.aborted) throw new Error("native-cancelled-before-launch");
      await mkdir(this.options.rootDirectory, { recursive: true, mode: 0o700 });
      const root = await realpath(this.options.rootDirectory);
      const directory = join(root, request.requestId);
      await mkdir(directory, { mode: 0o700 }); // exclusive identity; never reuse another attempt's files
      const workspace = join(directory, "input"), artifacts = join(directory, "artifacts");
      await prepareNativeWorkspace(workspace, current.workspaceRoot, current.inputManifest, recipe.maxInputBytes);
      await mkdir(artifacts, { mode: 0o700 });
      await mkdir(join(directory, "home"), { mode: 0o700 });
      await mkdir(join(directory, "tmp"), { mode: 0o700 });
      await writeNativeRecord(join(directory, "request.json"), { request, inputManifestSha256: hash, recipe, isolation: "native-user-filesystem" });
      await this.options.bindings.put({ request: resource, phase: "launching", identities: [] });
      launching = true;
      const known = new Map<string, ResourceRuntimeIdentity>();
      const context = { ...(signal ? { signal } : {}), identities: async (identities: ResourceRuntimeIdentity[]) => {
        for (const identity of identities) known.set(JSON.stringify(identity), identity);
        await this.options.bindings.put({ request: resource, phase: "bound", identities: [...known.values()] });
      } };
      const base = { executable: "/usr/bin/xcodebuild", args: [] as string[], cwd: workspace,
        env: { PATH: "/usr/bin:/bin", HOME: join(directory, "home"), TMPDIR: `${join(directory, "tmp")}/`, DEVELOPER_DIR: recipe.developerDirectory },
        timeoutMs: recipe.timeoutMs, logPath: join(artifacts, "xcodebuild.log"), artifactsDirectory: directory,
        maxArtifactBytes: recipe.maxArtifactBytes, memoryBytes: recipe.demand.memoryBytes, pidLimit: recipe.demand.pidLimit };
      const simulator = new NativeToolSimulator(this.options.supervisor, base, context);
      let result: NativeCommandResult;
      try {
        const simulatorId = await simulator.create(recipe, request.requestId);
        result = await this.options.supervisor.run({ ...base,
        args: ["-project", join(workspace, recipe.project), "-scheme", recipe.scheme,
          "-destination", `platform=iOS Simulator,id=${simulatorId}`, "-derivedDataPath", join(artifacts, "DerivedData"),
          "-resultBundlePath", join(artifacts, "Result.xcresult"), "-disableAutomaticPackageResolution",
          "-jobs", "1", "-maximum-concurrent-test-simulator-destinations", "1",
          "-parallel-testing-enabled", "NO", "CODE_SIGNING_ALLOWED=NO", "CODE_SIGNING_REQUIRED=NO", recipe.action],
        }, context);
      } catch {
        result = { exitCode: null, signal: null, timedOut: false, cancelled: signal?.aborted === true,
          reason: "native-run-failed", identities: [...known.values()], cleanup: "unproven", uncertainty: ["native-run-failed"] };
      } finally {
        const cleanup = await simulator.cleanup().catch(() => [{ reason: "native-simulator-cleanup-failed" }]);
        // A deleted device does not prove its launchd/compiler lifetime inventory complete.
        await writeNativeRecord(join(directory, "simulator-cleanup.json"), cleanup);
      }
      result.identities = [...known.values()];
      result.cleanup = await this.options.proveTermination?.(request, result.identities, directory) === true ? "terminated" : "unproven";
      if (result.cleanup !== "terminated") result.uncertainty = [...new Set([...result.uncertainty, "simulator-service-lifetime-unproven"])];
      const output: NativeToolResult = { state: "finished", request, result, artifactsDirectory: artifacts,
        inputManifestSha256: hash, isolation: "native-user-filesystem" };
      await writeNativeRecord(join(directory, "result.json"), output);
      await this.options.settled?.(output);
      if (result.cleanup === "terminated") {
        await this.options.bindings.put({ request: resource, phase: "terminated", identities: result.identities });
        await this.options.admission.release({ reservationId: decision.reservationId, terminationEvidenceId: `native-${request.requestId}-terminated` });
      }
      return output;
    } catch (error) {
      // Any post-launch error deliberately keeps capacity reserved for recovery.
      if (!launching) {
        await this.options.bindings.put({ request: resource, phase: "terminated", identities: [] });
        await this.options.admission.release({ reservationId: decision.reservationId, terminationEvidenceId: `native-${request.requestId}-not-launched` });
      }
      throw error;
    }
  }
}
