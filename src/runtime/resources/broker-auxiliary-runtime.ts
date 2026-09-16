import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { BrokerRuntimeConfig } from "../../config.js";
import { AgentActivitySchema, type ActivityInput } from "../../domain/agent-activity.js";
import { AuxiliaryProfileRequestSchema, type AuxiliaryProfileRequest } from "../../domain/auxiliary-profile.js";
import { ExecutionIdentitySchema, type ExecutionIdentity } from "../../domain/worker-execution.js";
import type { GatewayBinding } from "../../broker/worker-gateway.js";
import type { AgentActivityPort } from "../../orchestration/agent-activity-port.js";
import { writeAtomicPrivateFile } from "../../persistence/atomic-private-file.js";
import { IntegrationServiceExecutor } from "../execution/integration-service-executor.js";
import { NativeToolExecutor } from "../execution/native-tool-executor.js";
import { MacosNativeProcessSupervisor } from "../execution/native-process-supervisor.js";
import { OrbStackClient } from "../execution/orbstack-client.js";
import { workspaceManifest } from "../execution/workspace-manifest.js";
import { NativeMacosProcessSampler } from "./native-macos-process-sampler.js";
import type { brokerResourceRuntime } from "./broker-resource-runtime.js";

const BindingSchema = z.object({ workerId: z.uuid(), executionId: z.uuid(), generation: z.number().int().positive() }).strict();
const RecordSchema = z.object({ request: AuxiliaryProfileRequestSchema, binding: BindingSchema,
  identity: ExecutionIdentitySchema, leaseVersion: z.number().int().positive(), familyId: z.string().min(1),
  state: z.enum(["queued", "running", "waiting-capacity", "finished", "intervention"]), reason: z.string().max(256).optional(),
  terminal: AgentActivitySchema.omit({ sequence: true }).optional(),
  result: z.unknown().optional(),
}).strict();
type Record = z.infer<typeof RecordSchema>;
export interface AuxiliaryAuthority {
  identity: ExecutionIdentity; leaseVersion: number; familyId: string; writeAllowed: boolean; workspaceRoot: string;
}

/** Broker-owned recipe supervisor. Requests persist before launch; the worker only polls a receipt. */
export async function brokerAuxiliaryRuntime(options: {
  config: BrokerRuntimeConfig; resource: NonNullable<Awaited<ReturnType<typeof brokerResourceRuntime>>>;
  activity: AgentActivityPort;
  authorize(binding: GatewayBinding, request: AuxiliaryProfileRequest, expectedLeaseVersion?: number): Promise<AuxiliaryAuthority>;
}) {
  const config = options.config.resourceManagement!, profiles = config.auxiliaryProfiles;
  const path = join(config.directory, "auxiliary-requests.json");
  const records = new Map<string, Record>(), active = new Map<string, { abort: AbortController; done: Promise<void> }>();
  let closing = false, poisoned = false, failures = 0, writeTail = Promise.resolve();
  const projected = new Set<string>();
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 ** 2) throw new Error("AUXILIARY_STORE_UNSAFE");
    for (const record of z.array(RecordSchema).max(512).parse(JSON.parse(await readFile(path, "utf8")))) {
      if (records.has(record.request.requestId)) throw new Error("AUXILIARY_DUPLICATE_REQUEST");
      records.set(record.request.requestId, record);
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const save = (record: Record) => {
    const operation = writeTail.then(async () => {
      options.resource.assertOwner();
      if (poisoned) throw new Error("AUXILIARY_STORE_REOPEN_REQUIRED");
      const previous = records.get(record.request.requestId);
      if (previous && (!isDeepStrictEqual(previous.request, record.request)
        || !isDeepStrictEqual(previous.binding, record.binding) || previous.leaseVersion !== record.leaseVersion
        || previous.familyId !== record.familyId || !isDeepStrictEqual(previous.identity, record.identity)))
        throw new Error("AUXILIARY_REQUEST_CONFLICT");
      const next = new Map(records); next.set(record.request.requestId, RecordSchema.parse(record));
      const body = JSON.stringify([...next.values()]);
      if (next.size > 512 || Buffer.byteLength(body) > 2 * 1024 ** 2) throw new Error("AUXILIARY_RETENTION_CAP");
      try { await writeAtomicPrivateFile(path, body); }
      catch (error) { poisoned = true; throw error; }
      records.set(record.request.requestId, structuredClone(record));
    });
    writeTail = operation.catch(() => { failures++; }); return operation;
  };
  const authorize = async (record: Record) => {
    const current = await options.authorize(record.binding, record.request, record.leaseVersion);
    if (!isDeepStrictEqual(current.identity, record.identity) || current.familyId !== record.familyId)
      throw new Error("AUXILIARY_AUTHORITY_CHANGED");
    return current;
  };
  const byNative = (id: string) => { const record = records.get(id); if (!record) throw new Error("AUXILIARY_REQUEST_UNKNOWN"); return record; };
  const integration = profiles?.integrationImage ? new IntegrationServiceExecutor({
    client: new OrbStackClient(options.config.containerRuntime!.endpoint), admission: options.resource.admission,
    image: profiles.integrationImage, evidenceDirectory: join(config.directory, "integration"),
    authorize: async request => {
      const record = [...records.values()].find(r => r.request.profile === "integration" && r.request.requestId === request.attemptId);
      if (!record || request.leaseVersion !== record.leaseVersion || !isDeepStrictEqual(request.identity, record.identity))
        throw new Error("AUXILIARY_REQUEST_UNKNOWN");
      await authorize(record); return { installationId: config.installationId, familyId: record.familyId };
    },
  }) : undefined;
  if (integration) options.resource.registerVerifier("postgres-fixture-v1", (reservation, evidence) => integration.verifyTermination(reservation, evidence));
  const native = new NativeToolExecutor({ admission: options.resource.admission, bindings: options.resource.bindings,
    installationId: config.installationId, rootDirectory: join(config.directory, "native"), recipes: profiles?.nativeRecipes ?? [],
    supervisor: new MacosNativeProcessSupervisor(new NativeMacosProcessSampler(config.nativeHelper)),
    authorize: async request => {
      const record = byNative(request.requestId), authority = await authorize(record);
      if (request.executionId !== record.identity.executionId || request.generation !== record.identity.generation
        || request.attemptId !== record.request.attemptId || request.recipeId !== record.request.recipeId) throw new Error("AUXILIARY_IDENTITY_MISMATCH");
      const recipe = profiles?.nativeRecipes.find(r => r.id === request.recipeId);
      if (!recipe) throw new Error("AUXILIARY_RECIPE_UNAVAILABLE");
      return { ...authority, inputManifest: await workspaceManifest(authority.workspaceRoot, recipe.maxInputBytes) };
    },
  });
  for (const profileId of new Set(profiles?.nativeRecipes.map(r => r.demand.profileId))) {
    options.resource.registerVerifier(profileId, async (reservation, evidence) => {
      const binding = options.resource.bindings.get(reservation.request.requestId);
      return evidence === `${reservation.request.requestId}-not-launched` && binding?.phase === "terminated"
        && binding.identities.length === 0 && JSON.stringify(binding.request) === JSON.stringify(reservation.request);
    });
  }
  // Native lifetime cleanup cannot currently be proved; no verifier claims otherwise.
  const terminal = async (record: Record, outcome: ActivityInput["outcome"], result: unknown) => {
    const event: ActivityInput = { schemaVersion: 1, eventId: record.request.requestId,
      sourceKey: `profile:${record.request.requestId}`, runId: record.request.requestId,
      sessionId: record.binding.workerId, workerId: record.binding.workerId, generation: record.binding.generation,
      executionId: record.binding.executionId, causationId: record.request.attemptId,
      observedAt: new Date().toISOString(), kind: "profile.settled", operation: "lifecycle", provenance: "host-verified",
      coverage: "complete-for-source", outcome };
    await save({ ...record, state: "finished", terminal: event, result });
    await options.activity.append(event); // Durable request is the recovery source if append fails.
    projected.add(record.request.requestId);
  };
  const run = async (record: Record, signal: AbortSignal) => {
    try {
      await authorize(record); await save({ ...record, state: "running" });
      const result = record.request.profile === "integration"
        ? await integration!.run({ identity: record.identity, attemptId: record.request.requestId, leaseVersion: record.leaseVersion,
          recipe: "postgres-fixture-v1" }, signal)
        : await native.execute({ requestId: record.request.requestId, attemptId: record.request.attemptId,
          executionId: record.identity.executionId, generation: record.identity.generation, recipeId: record.request.recipeId }, signal);
      if (result.state === "waiting-capacity" || result.state === "resource-infeasible") {
        await save({ ...record, state: result.state === "waiting-capacity" ? "waiting-capacity" : "intervention", reason: result.reason }); return;
      }
      const outcome = result.state === "completed"
        ? result.outcome === "verified-pass" ? "succeeded" : result.outcome === "verified-fail" ? "failed" : result.outcome === "cancelled" ? "cancelled" : "unknown"
        : result.result.cancelled ? "cancelled" : result.result.exitCode === 0 && !result.result.timedOut && !result.result.reason ? "succeeded" : "unknown";
      await terminal(record, outcome, result);
    } catch {
      const current = records.get(record.request.requestId)!;
      if (current.terminal) return; // A capture retry must never replace the terminal result.
      await terminal(record, signal.aborted ? "cancelled" : "unknown", { reason: "auxiliary-operation-interrupted" });
    }
  };
  const start = (record: Record) => {
    if (closing || poisoned || active.has(record.request.requestId)) return;
    const abort = new AbortController();
    const done = run(record, abort.signal).catch(() => { failures++; }).finally(() => active.delete(record.request.requestId));
    active.set(record.request.requestId, { abort, done });
  };
  await integration?.reconcileAll();
  for (const record of records.values()) {
    if (record.terminal) { await options.activity.append(record.terminal); projected.add(record.request.requestId); }
    else if (record.state === "running") await terminal(record, "unknown", { reason: "broker-restarted-during-profile" });
  }
  let pending: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (pending || closing) return;
    pending = (async () => {
      for (const record of records.values()) {
        if (record.terminal && !projected.has(record.request.requestId)) {
          await options.activity.append(record.terminal); projected.add(record.request.requestId);
        }
        if (active.has(record.request.requestId)) {
          try { await authorize(record); } catch { active.get(record.request.requestId)?.abort.abort(); }
        } else if (["queued", "waiting-capacity"].includes(record.state)) start(record);
      }
    })().catch(() => { failures++; }).finally(() => { pending = undefined; });
  }, 2000).unref();
  return {
    async request(binding: GatewayBinding, input: AuxiliaryProfileRequest) {
      const request = AuxiliaryProfileRequestSchema.parse(input);
      if (closing || poisoned) throw new Error("AUXILIARY_DRAINING");
      if (request.profile === "integration" ? !integration || request.recipeId !== "postgres-fixture-v1"
        : !profiles?.nativeRecipes.some(r => r.id === request.recipeId)) throw new Error("AUXILIARY_RECIPE_UNAVAILABLE");
      let record = records.get(request.requestId);
      if (record) {
        if (!isDeepStrictEqual(record.request, request) || !isDeepStrictEqual(record.binding, binding))
          throw new Error("AUXILIARY_REQUEST_CONFLICT");
        await authorize(record);
      } else {
        const authority = await options.authorize(binding, request);
        record = { request, binding, identity: authority.identity, leaseVersion: authority.leaseVersion,
          familyId: authority.familyId, state: "queued" };
        await save(record);
      }
      if (["queued", "waiting-capacity"].includes(record.state)) start(record);
      // Artifacts stay in the broker-owned bounded directory; no arbitrary host file service.
      return { requestId: request.requestId, state: record.state, reason: record.reason, outcome: record.terminal?.outcome,
        artifactRef: record.terminal ? `profile:${request.requestId}` : undefined };
    },
    admissionHold: () => poisoned || [...records.values()].some(r => r.terminal && !projected.has(r.request.requestId))
      ? "auxiliary-capture-gap" as const : null,
    health: () => ({ active: active.size, retained: records.size, failures, poisoned,
      waiting: [...records.values()].filter(r => r.state === "waiting-capacity").length,
      nativeCleanup: "lifetime-unproven" }),
    close: async () => { closing = true; clearInterval(timer); await pending;
      for (const entry of active.values()) entry.abort.abort(); await Promise.all([...active.values()].map(r => r.done)); await writeTail; },
  };
}
