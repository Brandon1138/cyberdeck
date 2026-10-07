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
import type { ResourceReservation } from "../../domain/resource-budget.js";
import { writeAtomicPrivateFile } from "../../persistence/atomic-private-file.js";
import { IntegrationServiceExecutor, type IntegrationServiceResult } from "../execution/integration-service-executor.js";
import { integrationNames } from "../execution/integration-service-recipe.js";
import { NativeToolExecutor, type NativeToolResult } from "../execution/native-tool-executor.js";
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
  cleanupPending: z.boolean().optional(), cleanupAttempts: z.number().int().nonnegative().optional(),
  cleanupAfter: z.number().nonnegative().optional(), cleanupReason: z.string().max(256).optional(),
  recoveryPending: z.boolean().optional(), recoveryAttempts: z.number().int().nonnegative().optional(),
  recoveryAfter: z.number().nonnegative().optional(), recoveryReason: z.string().max(256).optional(),
}).strict();
type Record = z.infer<typeof RecordSchema>;
export interface AuxiliaryAuthority {
  identity: ExecutionIdentity; leaseVersion: number; familyId: string; writeAllowed: boolean; workspaceRoot: string;
}

/** Broker-owned recipe supervisor. Requests persist before launch; the worker only polls a receipt. */
export async function brokerAuxiliaryRuntime(options: {
  config: BrokerRuntimeConfig; resource: NonNullable<Awaited<ReturnType<typeof brokerResourceRuntime>>> & {
    registerRecovery?(profileId: string, check: (reservation: ResourceReservation) => Promise<boolean>): void;
  };
  activity: AgentActivityPort;
  authorize(binding: GatewayBinding, request: AuxiliaryProfileRequest, expectedLeaseVersion?: number): Promise<AuxiliaryAuthority>;
}) {
  const config = options.config.resourceManagement!, profiles = config.auxiliaryProfiles;
  const path = join(config.directory, "auxiliary-requests.json");
  const records = new Map<string, Record>(), active = new Map<string, { abort: AbortController; done: Promise<void> }>();
  let closing = false, poisoned = false, failures = 0, writeTail = Promise.resolve();
  let inventoryReady = false;
  const recoveryChecks = new Map<string, boolean>();
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
    if (!isDeepStrictEqual(current.identity, record.identity) || current.familyId !== record.familyId
      || current.leaseVersion !== record.leaseVersion || !current.writeAllowed)
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
  const nativeRequest = (record: Record) => ({ requestId: record.request.requestId, attemptId: record.request.attemptId,
    executionId: record.identity.executionId, generation: record.identity.generation, recipeId: record.request.recipeId });
  const integrationRequest = (record: Record) => ({ identity: record.identity, attemptId: record.request.requestId,
    leaseVersion: record.leaseVersion, recipe: "postgres-fixture-v1" as const });
  const revoked = (error: unknown) => error instanceof Error && ["AUXILIARY_EXECUTION_STALE", "AUXILIARY_LEASE_STALE",
    "AUXILIARY_ATTEMPT_STALE", "AUXILIARY_ATTEMPT_AMBIGUOUS", "AUXILIARY_WRITE_POLICY_REFUSED", "AUXILIARY_AUTHORITY_CHANGED"].includes(error.message);
  // Owner checks run under admission's serialized recovery callback: no ledger mutations here.
  const recoveryReady = async (reservation: ResourceReservation): Promise<boolean> => {
    let ready = false;
    try {
      if (!inventoryReady || poisoned || reservation.request.owner.kind !== "service"
        || reservation.request.owner.installationId !== config.installationId) return false;
      const record = [...records.values()].find(r => (r.request.profile === "integration"
        ? integrationNames(integrationRequest(r)).key : `native-${r.request.requestId}`) === reservation.request.requestId);
      if (!record || record.recoveryPending || record.familyId !== reservation.request.owner.familyId) return false;
      if (!record.terminal) await authorize(record);
      ready = record.request.profile === "integration" ? await integration?.recoveryReady(reservation) === true
        : profiles?.nativeRecipes.some(recipe => recipe.id === record.request.recipeId) === true
          && native.recoveryReady(nativeRequest(record), reservation);
      return ready;
    } catch { return false; }
    finally { recoveryChecks.set(reservation.request.requestId, ready); }
  };
  if (integration) options.resource.registerRecovery?.("postgres-fixture-v1", recoveryReady);
  for (const profileId of new Set(profiles?.nativeRecipes.map(r => r.demand.profileId)))
    options.resource.registerRecovery?.(profileId, recoveryReady);
  const outcome = (result: IntegrationServiceResult | NativeToolResult | undefined): ActivityInput["outcome"] => result?.state === "completed"
    ? result.outcome === "verified-pass" ? "succeeded" : result.outcome === "verified-fail" ? "failed" : result.outcome === "cancelled" ? "cancelled" : "unknown"
    : result?.state === "finished" ? result.result.cancelled ? "cancelled"
      : result.result.exitCode === 0 && !result.result.timedOut && !result.result.reason ? "succeeded" : "unknown" : "unknown";
  const retire = async (record: Record) => {
    const attempts = (record.cleanupAttempts ?? 0) + 1;
    // Persist the recovery obligation before cleanup or terminal publication. A crash replays it.
    await save({ ...record, cleanupPending: true, cleanupAttempts: attempts,
      cleanupAfter: Date.now() + Math.min(60000, 2000 * 2 ** Math.min(attempts - 1, 5)) });
    try {
      const recovery = record.request.profile === "integration"
        ? await integration!.cancelPending(integrationRequest(record)) : await native.recover(nativeRequest(record), true);
      const current = records.get(record.request.requestId)!;
      await save({ ...current, cleanupPending: !recovery.cleanupComplete,
        cleanupReason: recovery.cleanupComplete ? undefined : "owned-runtime-cleanup-unproven" });
      return recovery.result;
    } catch {
      await save({ ...records.get(record.request.requestId)!, cleanupPending: true, cleanupReason: "owned-runtime-cleanup-failed" });
      failures++; return undefined;
    }
  };
  const terminal = async (record: Record, outcome: ActivityInput["outcome"], result: unknown) => {
    const event: ActivityInput = { schemaVersion: 1, eventId: record.request.requestId,
      sourceKey: `profile:${record.request.requestId}`, runId: record.request.requestId,
      sessionId: record.binding.workerId, workerId: record.binding.workerId, generation: record.binding.generation,
      executionId: record.binding.executionId, causationId: record.request.attemptId,
      observedAt: new Date().toISOString(), kind: "profile.settled", operation: "lifecycle", provenance: "host-verified",
      coverage: "complete-for-source", outcome };
    await save({ ...record, state: "finished", terminal: event, result,
      recoveryPending: false, recoveryAfter: undefined, recoveryReason: undefined });
    await options.activity.append(event); // Durable request is the recovery source if append fails.
    projected.add(record.request.requestId);
  };
  const deferRecovery = async (record: Record) => {
    const attempts = (record.recoveryAttempts ?? 0) + 1;
    await save({ ...record, recoveryPending: true, recoveryAttempts: attempts,
      recoveryAfter: Date.now() + Math.min(60000, 2000 * 2 ** Math.min(attempts - 1, 5)),
      recoveryReason: "owned-runtime-recovery-unavailable", cleanupPending: true });
    failures++;
  };
  const run = async (record: Record, signal: AbortSignal) => {
    let enteredExecutor = false;
    try {
      await authorize(record); await save({ ...record, state: "running", cleanupPending: true });
      enteredExecutor = true;
      const result = record.request.profile === "integration"
        ? await integration!.run(integrationRequest(record), signal) : await native.execute(nativeRequest(record), signal);
      if (result.state === "waiting-capacity" || result.state === "resource-infeasible") {
        await save({ ...record, state: result.state === "waiting-capacity" ? "waiting-capacity" : "intervention", reason: result.reason, cleanupPending: false }); return;
      }
      const cleanupPending = result.state === "completed" ? !result.cleanupComplete : result.result.cleanup !== "terminated";
      await terminal({ ...records.get(record.request.requestId)!, cleanupPending, cleanupAfter: Date.now() + 2000 }, outcome(result), result);
    } catch (error) {
      const current = records.get(record.request.requestId)!;
      if (current.terminal) return; // A capture retry must never replace the terminal result.
      if (!signal.aborted && !revoked(error)) {
        let stillPending = !enteredExecutor;
        if (enteredExecutor) {
          try {
            const recovered = record.request.profile === "integration"
              ? await integration!.recover(integrationRequest(record)) : await native.recover(nativeRequest(record));
            stillPending = "pending" in recovered || "state" in recovered && recovered.state === "pending";
          } catch { await deferRecovery(current); return; }
        }
        if (stillPending) {
          await save({ ...current, state: "queued", reason: "auxiliary-operation-unavailable", cleanupPending: false }); return;
        }
      }
      const recovered = await retire(current);
      await terminal(records.get(record.request.requestId)!, recovered ? outcome(recovered) : signal.aborted ? "cancelled" : "unknown",
        recovered ?? { reason: "auxiliary-operation-interrupted" });
    }
  };
  const start = (record: Record) => {
    if (closing || poisoned || record.recoveryPending || active.has(record.request.requestId)) return;
    const abort = new AbortController();
    const done = run(record, abort.signal).catch(() => { failures++; }).finally(() => active.delete(record.request.requestId));
    active.set(record.request.requestId, { abort, done });
  };
  const preservePending = async (record: Record) => {
    record = { ...record, recoveryPending: false, recoveryAfter: undefined, recoveryReason: undefined };
    try {
      await authorize(record);
      await save({ ...record, state: "waiting-capacity", reason: undefined, cleanupPending: false });
    } catch (error) {
      if (!revoked(error)) {
        await save({ ...record, state: "queued", reason: "auxiliary-authority-unavailable", cleanupPending: false }); return;
      }
      const recovered = await retire(record);
      await terminal(records.get(record.request.requestId)!, outcome(recovered), recovered ?? { reason: "auxiliary-authority-revoked" });
    }
  };
  const retryRecovery = async (record: Record) => {
    try {
      const recovered = record.request.profile === "integration"
        ? await integration!.recover(integrationRequest(record)) : await native.recover(nativeRequest(record));
      if ("pending" in recovered || "state" in recovered && recovered.state === "pending") {
        await preservePending(record); return;
      }
      const result = "state" in recovered ? recovered : recovered.result;
      const cleanupComplete = "cleanupComplete" in recovered ? recovered.cleanupComplete : false;
      await terminal({ ...record, cleanupPending: !cleanupComplete, cleanupAfter: Date.now() + 2000 },
        outcome(result), result ?? { reason: "auxiliary-operation-interrupted" });
    } catch {
      const current = records.get(record.request.requestId)!;
      if (!current.terminal) await deferRecovery(current); // Terminal projection has its own durable retry path.
    }
  };
  // Recovered engine results remain authoritative even when their cleanup needs another retry.
  const preserved = new Set<string>();
  for (const recovered of await integration?.reconcileAll() ?? []) {
    const record = records.get(recovered.request.attemptId);
    if (!record || record.request.profile !== "integration") continue;
    if (!isDeepStrictEqual(integrationRequest(record), recovered.request)) throw new Error("AUXILIARY_RECOVERY_IDENTITY_MISMATCH");
    if (recovered.result.state === "pending") {
      if (!record.terminal) { await preservePending(record); preserved.add(record.request.requestId); }
      continue;
    }
    if (recovered.result.state !== "completed") continue;
    const updated = { ...record, cleanupPending: !recovered.result.cleanupComplete, cleanupAfter: Date.now() + 2000 };
    if (record.terminal) await save(updated);
    else await terminal(updated, outcome(recovered.result), recovered.result);
  }
  for (const record of records.values()) {
    if (preserved.has(record.request.requestId)) continue;
    if (record.terminal) {
      if (record.cleanupPending || record.request.profile === "native" && record.cleanupPending === undefined) await retire(record);
      await options.activity.append(record.terminal); projected.add(record.request.requestId);
    }
    else if (record.request.profile === "native") {
      const recovered = await native.recover(nativeRequest(record));
      if ("pending" in recovered) await preservePending(record);
      else {
        await save({ ...record, cleanupPending: !recovered.cleanupComplete, cleanupAfter: Date.now() + 2000 });
        await terminal(records.get(record.request.requestId)!, outcome(recovered.result), recovered.result ?? { reason: "broker-restarted-during-profile" });
      }
    }
    // No integration manifest means the crash preceded executor intent/admission. A running
    // auxiliary receipt alone is not evidence that infrastructure was provisioned.
    else if (["queued", "waiting-capacity", "running"].includes(record.state)) await preservePending(record);
  }
  inventoryReady = true;
  let pending: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (pending || closing) return;
    pending = (async () => {
      let cleanupBudget = 2; // At most two selective retries per sweep; persistent debt backs off to 60 seconds.
      for (const record of records.values()) {
        if (record.terminal && !projected.has(record.request.requestId)) {
          await options.activity.append(record.terminal); projected.add(record.request.requestId);
        }
        if (active.has(record.request.requestId)) {
          try { await authorize(record); } catch (error) { if (revoked(error)) active.get(record.request.requestId)?.abort.abort(); }
        } else if (record.recoveryPending && (record.recoveryAfter ?? 0) <= Date.now() && cleanupBudget-- > 0) await retryRecovery(record);
        else if (record.cleanupPending && record.terminal && (record.cleanupAfter ?? 0) <= Date.now() && cleanupBudget-- > 0) await retire(record);
        else if (["queued", "waiting-capacity"].includes(record.state)) start(record);
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
    admissionHold: () => poisoned || [...records.values()].some(r => r.recoveryPending || r.terminal && !projected.has(r.request.requestId))
      ? "auxiliary-capture-gap" as const : null,
    recoveryReady,
    health: () => ({ active: active.size, retained: records.size, failures, poisoned,
      recovery: { inventoryReady, checked: recoveryChecks.size, held: [...recoveryChecks.values()].filter(ready => !ready).length,
        pending: [...records.values()].filter(r => r.recoveryPending).length,
        retries: [...records.values()].reduce((sum, r) => sum + (r.recoveryAttempts ?? 0), 0) },
      waiting: [...records.values()].filter(r => r.state === "waiting-capacity").length,
      cleanupPending: [...records.values()].filter(r => r.cleanupPending).length,
      cleanupRetries: [...records.values()].reduce((sum, r) => sum + (r.cleanupAttempts ?? 0), 0),
      nativeCleanup: "lifetime-unproven" }),
    close: async () => { closing = true; clearInterval(timer); await pending;
      for (const entry of active.values()) entry.abort.abort(); await Promise.all([...active.values()].map(r => r.done)); await writeTail; },
  };
}
