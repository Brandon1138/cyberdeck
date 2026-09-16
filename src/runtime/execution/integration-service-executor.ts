import { randomBytes } from "node:crypto";
import { readFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { ResourceAdmissionPort, ResourceDecision, ResourceReservation } from "../../domain/resource-budget.js";
import { ResourceRequestSchema, type ResourceRequest } from "../../domain/resource-budget.js";
import { writeAtomicPrivateFile } from "../../persistence/atomic-private-file.js";
import type { OrbStackClient } from "./orbstack-client.js";
import { IntegrationServiceEngine } from "./integration-service-engine.js";
import { IntegrationServiceRequestSchema, integrationHash, integrationNames, integrationRecipe, serviceContainerArgs,
  type IntegrationServiceRequest } from "./integration-service-recipe.js";

const ManifestSchema = z.object({
  version: z.literal(1), request: IntegrationServiceRequestSchema, resource: ResourceRequestSchema,
  image: z.string(), recipeHash: z.string(), reservationId: z.string().optional(),
  phase: z.enum(["waiting", "provisioning", "testing", "cleanup", "retained"]),
  outcome: z.enum(["verified-pass", "verified-fail", "cancelled", "infrastructure-error"]).optional(),
  reason: z.string().optional(), cleanupComplete: z.boolean(),
  cleanupReason: z.string().optional(), cleanupAttempts: z.number().int().nonnegative().optional(),
  observations: z.array(z.object({ role: z.enum(["service", "runner"]), id: z.string(), exitCode: z.number(), oomKilled: z.boolean(), logs: z.string() })),
});
type Manifest = z.infer<typeof ManifestSchema>;
export type IntegrationServiceResult = Exclude<ResourceDecision, { state: "admitted" }> | {
  state: "completed"; outcome: NonNullable<Manifest["outcome"]>; manifestRef: string; cleanupComplete: boolean;
};
export interface IntegrationServiceExecutorOptions {
  client: OrbStackClient; admission: ResourceAdmissionPort; image: string; evidenceDirectory: string;
  /** Resolve canonical bindings/lease fencing afresh, never derive family from request data. */
  authorize(request: IntegrationServiceRequest): Promise<{ installationId: string; familyId: string }>;
  now?: () => number; pause?: (ms: number) => Promise<void>;
}

/** Broker-owned fixed service/test capability; no guest receives engine or network administration. */
export class IntegrationServiceExecutor {
  private readonly active = new Set<string>();
  private readonly recipe;
  private readonly now: () => number;
  private readonly pause: (ms: number) => Promise<void>;
  constructor(private readonly options: IntegrationServiceExecutorOptions) {
    this.recipe = integrationRecipe(options.image); this.now = options.now ?? Date.now;
    this.pause = options.pause ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  }
  async run(input: IntegrationServiceRequest, signal?: AbortSignal): Promise<IntegrationServiceResult> {
    const request = IntegrationServiceRequestSchema.parse(input), key = integrationNames(request).key;
    return this.exclusive(key, async () => {
      signal?.throwIfAborted();
      const owner = await this.options.authorize(request);
      const resource: ResourceRequest = { requestId: key, owner: { ...owner, workloadId: key, kind: "service",
        executionId: request.identity.executionId, generation: request.identity.generation }, priority: "interactive",
      demand: { memoryBytes: this.recipe.service.memoryBytes + this.recipe.runner.memoryBytes + this.recipe.dataBytes,
        cpuWeight: 100, pidLimit: this.recipe.service.pids + this.recipe.runner.pids,
        profileId: this.recipe.id, profileVersion: integrationHash(this.recipe) } };
      let manifest = await this.read(request);
      if (manifest && (manifest.phase !== "waiting" || integrationHash(manifest.resource) !== integrationHash(resource)))
        throw new Error("INTEGRATION_ATTEMPT_ALREADY_STARTED");
      manifest ??= { version: 1, request, resource, image: this.recipe.image, recipeHash: integrationHash(this.recipe),
        phase: "waiting", cleanupComplete: false, observations: [] };
      await this.save(manifest); // Intent precedes admission, including the reserve-before-save crash window.
      const decision = await this.options.admission.request(resource);
      if (decision.state !== "admitted") return decision;
      manifest.reservationId = decision.reservationId; manifest.phase = "provisioning";
      const engine = new IntegrationServiceEngine(this.options.client, request, this.recipe);
      const password = randomBytes(32).toString("hex");
      try {
        await this.save(manifest);
        await this.check(request, signal);
        await writeAtomicPrivateFile(this.secretPath(request), JSON.stringify({ host: "database", port: 5432,
          database: "cyberdeck", user: "cyberdeck", password, network: integrationNames(request).network }));
        await engine.createInfrastructure();
        await this.check(request, signal);
        await engine.command(serviceContainerArgs({ request, recipe: this.recipe, password, runner: false }));
        const service = await engine.container("service");
        if (!service) throw new Error("INTEGRATION_SERVICE_ABSENT");
        engine.verifyBoundary(service, false);
        await engine.command(["start", service.Id]);
        await this.waitFor(engine, "service", request, this.recipe.readinessMs, signal);
        await this.check(request, signal);
        manifest.phase = "testing"; await this.save(manifest);
        await engine.command(serviceContainerArgs({ request, recipe: this.recipe, password, runner: true }));
        const runner = await engine.container("runner");
        if (!runner) throw new Error("INTEGRATION_RUNNER_ABSENT");
        engine.verifyBoundary(runner, true);
        await engine.command(["start", runner.Id]);
        const finished = await this.waitFor(engine, "runner", request, this.recipe.testMs, signal);
        const finalService = await engine.container("service");
        if (!finalService?.State.Running || finalService.State.OOMKilled) throw new Error("INTEGRATION_SERVICE_FAILED");
        const output = await engine.command(["logs", "--tail", "200", finished.Id]);
        manifest.outcome = finished.State.ExitCode === 0 && output.includes("cyberdeck-integration-pass") ? "verified-pass" : "verified-fail";
      } catch (error) {
        manifest.outcome = signal?.aborted ? "cancelled" : "infrastructure-error";
        manifest.reason = error instanceof Error && /^INTEGRATION_[A-Z_]+$/.test(error.message) ? error.message : "INTEGRATION_OPERATION_FAILED";
      }
      await this.cleanup(manifest, engine, password);
      return this.result(manifest);
    });
  }
  /** Bind admission's termination verifier to the durable, sanitized cleanup evidence. */
  async verifyTermination(reservation: ResourceReservation, evidenceId: string): Promise<boolean> {
    const key = reservation.request.requestId;
    if (!/^[a-f0-9]{64}$/.test(key)) return false;
    try {
      const manifest = ManifestSchema.parse(JSON.parse(await readFile(join(this.options.evidenceDirectory, `${key}.json`), "utf8")));
      if (!manifest.cleanupComplete || manifest.phase !== "retained" || manifest.reservationId !== reservation.reservationId
        || integrationHash(manifest.resource) !== integrationHash(reservation.request) || integrationHash(manifest) !== evidenceId) return false;
      const engine = new IntegrationServiceEngine(this.options.client, manifest.request, integrationRecipe(manifest.image));
      for (const role of ["runner", "service", "volume", "network"] as const) if (await engine.inspect(role)) return false;
      return true;
    } catch { return false; }
  }
  /** Validate the entire bounded inventory before mutating anything during startup reconciliation. */
  async reconcileAll(): Promise<Array<{ request: IntegrationServiceRequest; result: IntegrationServiceResult }>> {
    const entries = await readdir(this.options.evidenceDirectory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return []; throw error;
    });
    const files = entries.filter(entry => /^[a-f0-9]{64}\.json$/.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name));
    if (files.length > 1024 || files.some(entry => !entry.isFile())) throw new Error("INTEGRATION_RECOVERY_INVENTORY_INVALID");
    const requests: IntegrationServiceRequest[] = [];
    for (const file of files) {
      const manifest = ManifestSchema.parse(JSON.parse(await readFile(join(this.options.evidenceDirectory, file.name), "utf8")));
      const key = integrationNames(manifest.request).key;
      if (file.name !== `${key}.json` || manifest.resource.requestId !== key
        || manifest.resource.owner.kind !== "service" || manifest.resource.owner.workloadId !== key
        || manifest.resource.owner.executionId !== manifest.request.identity.executionId
        || manifest.resource.owner.generation !== manifest.request.identity.generation
        || integrationHash(integrationRecipe(manifest.image)) !== manifest.recipeHash
        || manifest.resource.demand.profileVersion !== manifest.recipeHash) throw new Error("INTEGRATION_RECOVERY_MANIFEST_INVALID");
      requests.push(manifest.request);
    }
    const results: Array<{ request: IntegrationServiceRequest; result: IntegrationServiceResult }> = [];
    for (const request of requests) results.push({ request, result: await this.recover(request) });
    return results;
  }
  /** Startup reconciliation only. Expired authority never prevents stopping already owned services. */
  async recover(input: IntegrationServiceRequest): Promise<IntegrationServiceResult> {
    const request = IntegrationServiceRequestSchema.parse(input);
    return this.exclusive(integrationNames(request).key, async () => {
      const manifest = await this.read(request);
      if (!manifest) throw new Error("INTEGRATION_RECOVERY_UNKNOWN");
      const recipe = integrationRecipe(manifest.image);
      if (manifest.recipeHash !== integrationHash(recipe)) throw new Error("INTEGRATION_RECIPE_MISMATCH");
      if (!manifest.reservationId) {
        try { await this.options.admission.cancel(manifest.resource.requestId); }
        catch (error) {
          if (!(error instanceof Error) || error.message !== "RESOURCE_TERMINATION_REQUIRED") throw error;
          const decision = await this.options.admission.request(manifest.resource);
          if (decision.state !== "admitted") throw new Error("INTEGRATION_RECOVERY_ADMISSION_UNCONFIRMED");
          manifest.reservationId = decision.reservationId;
        }
        await this.save(manifest);
      }
      if (!manifest.outcome) { manifest.outcome = "infrastructure-error"; manifest.reason = "INTEGRATION_BROKER_INTERRUPTED"; }
      let password = "";
      try { password = z.object({ password: z.string() }).parse(JSON.parse(await readFile(this.secretPath(request), "utf8"))).password; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await this.cleanup(manifest, new IntegrationServiceEngine(this.options.client, request, recipe), password);
      return this.result(manifest);
    });
  }
  /** Cleanup authority comes from the durable owner manifest, never the now-stale caller grant. */
  async cancelPending(input: IntegrationServiceRequest): Promise<{ cleanupComplete: boolean; result?: IntegrationServiceResult }> {
    const request = IntegrationServiceRequestSchema.parse(input);
    if (!await this.read(request)) return { cleanupComplete: true }; // No intent means no admission or engine mutation.
    const result = await this.recover(request);
    return { cleanupComplete: result.state === "completed" && result.cleanupComplete, result };
  }
  private async waitFor(engine: IntegrationServiceEngine, role: "service" | "runner", request: IntegrationServiceRequest, timeout: number, signal?: AbortSignal) {
    const deadline = this.now() + timeout;
    while (this.now() < deadline) {
      await this.check(request, signal);
      const current = await engine.container(role);
      if (!current || current.State.OOMKilled) throw new Error("INTEGRATION_SERVICE_FAILED");
      engine.verifyBoundary(current, role === "runner");
      if (role === "runner" && !current.State.Running) return current;
      if (role === "service" && !current.State.Running) throw new Error("INTEGRATION_SERVICE_FAILED");
      if (role === "service" && current.State.Health?.Status === "healthy") return current;
      await this.pause(250);
    }
    throw new Error("INTEGRATION_DEADLINE_EXCEEDED");
  }
  private async cleanup(manifest: Manifest, engine: IntegrationServiceEngine, password: string): Promise<void> {
    manifest.phase = "cleanup"; manifest.cleanupComplete = false;
    manifest.cleanupAttempts = (manifest.cleanupAttempts ?? 0) + 1;
    try {
      await this.save(manifest);
      for (const role of ["runner", "service"] as const) {
        let current = await engine.container(role);
        if (!current) continue;
        if (current.State.Running) { await engine.command(["stop", "--timeout", "5", current.Id]); current = await engine.container(role); }
        if (!current || current.State.Running) throw new Error("INTEGRATION_STOP_UNCONFIRMED");
        const observation = manifest.observations.find(o => o.role === role);
        if (observation && observation.id !== current.Id) throw new Error("INTEGRATION_RECOVERY_IDENTITY_MISMATCH");
        if (!observation) {
          let logs = (await engine.command(["logs", "--tail", "200", current.Id])).slice(-65536);
          if (password) logs = logs.replaceAll(password, "[redacted]");
          manifest.observations.push({ role, id: current.Id, exitCode: current.State.ExitCode, oomKilled: current.State.OOMKilled, logs });
        }
        await this.save(manifest); // Evidence must reach disk before any destructive operation.
        await engine.command(["rm", current.Id]);
        if (await engine.container(role)) throw new Error("INTEGRATION_REMOVE_UNCONFIRMED");
      }
      for (const kind of ["volume", "network"] as const) {
        const current = await engine.inspect(kind);
        if (current) await engine.command([kind, "rm", current.Id]);
        if (await engine.inspect(kind)) throw new Error("INTEGRATION_REMOVE_UNCONFIRMED");
      }
      manifest.cleanupComplete = true; manifest.phase = "retained";
      delete manifest.cleanupReason;
      await this.save(manifest);
      if (manifest.reservationId) await this.options.admission.release({ reservationId: manifest.reservationId,
        terminationEvidenceId: integrationHash(manifest) });
      await unlink(this.secretPath(manifest.request)).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    } catch {
      manifest.cleanupComplete = false; manifest.cleanupReason = "INTEGRATION_CLEANUP_INCOMPLETE";
      await this.save(manifest);
    }
  }
  private async check(request: IntegrationServiceRequest, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted(); await this.options.authorize(request); signal?.throwIfAborted();
  }
  private path(request: IntegrationServiceRequest): string { return join(this.options.evidenceDirectory, `${integrationNames(request).key}.json`); }
  private secretPath(request: IntegrationServiceRequest): string { return join(this.options.evidenceDirectory, `${integrationNames(request).key}.credentials.json`); }
  private save(manifest: Manifest): Promise<void> { return writeAtomicPrivateFile(this.path(manifest.request), JSON.stringify(manifest)); }
  private async read(request: IntegrationServiceRequest): Promise<Manifest | undefined> {
    try {
      const manifest = ManifestSchema.parse(JSON.parse(await readFile(this.path(request), "utf8")));
      if (JSON.stringify(manifest.request) !== JSON.stringify(request)) throw new Error("INTEGRATION_RECOVERY_IDENTITY_MISMATCH");
      return manifest;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }
  private result(manifest: Manifest): IntegrationServiceResult {
    return { state: "completed", outcome: manifest.outcome!, manifestRef: this.path(manifest.request), cleanupComplete: manifest.cleanupComplete };
  }
  private async exclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    if (this.active.has(key)) throw new Error("INTEGRATION_ATTEMPT_BUSY");
    this.active.add(key); try { return await operation(); } finally { this.active.delete(key); }
  }
}
