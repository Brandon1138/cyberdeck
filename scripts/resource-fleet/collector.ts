import { z } from "zod";
import { ResourceCandidateSchema } from "../../evals/assertions/resource-fleet-schema.js";

const choice = z.object({ provider: z.enum(["claude", "codex"]), model: z.string().min(1), effort: z.string().min(1), authMode: z.literal("subscription") }).strict();
export const CollectorConfigSchema = z.object({
  candidate: ResourceCandidateSchema, brokerId: z.uuid(), installationId: z.uuid(),
  socket: z.string().regex(/^\/private\/tmp\/cd-resource-[A-Za-z0-9_-]+\.sock$/),
  configFile: z.string().startsWith("/"), profileFile: z.string().startsWith("/"),
  workers: z.array(choice).length(8).refine(rows => new Set(rows.map(r => r.provider)).size === 2),
  orchestrator: choice.extend({ provider: z.literal("codex"), runtime: z.literal("first-party-codex") }),
  timeoutMs: z.number().int().min(100).max(600000), sampleIntervalMs: z.number().int().min(100).max(15000),
}).strict();
export type CollectorConfig = z.infer<typeof CollectorConfigSchema>;
export const blockers = ["broker-identity-and-immutable-pins-not-attested", "native-ready-progress-barrier-contract-missing",
  "first-party-orc-owned-lifetime-unverified", "complete-scoped-teardown-contract-missing"];
export const healthMethods = ["resource.health", "execution.health", "evaluation.health", "activity.health"] as const;
export async function bounded<T>(action: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([action(controller.signal), new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error("collector-timeout")); }, timeoutMs);
  })]); } finally { clearTimeout(timer!); }
}
/** Read-only production seam. Health is diagnostic, never identity or native overlap proof. */
export async function preflight(request: (method: string, signal: AbortSignal) => Promise<unknown>, timeoutMs: number) {
  const observations = [];
  for (const method of healthMethods) {
    try {
      const raw = await bounded(signal => request(method, signal), timeoutMs);
      const row = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
      // Do not persist arbitrary health payloads: they can contain paths, prompts and credentials.
      observations.push({ method, received: true, configured: typeof row.configured === "boolean" ? row.configured : null,
        degraded: typeof row.degraded === "boolean" ? row.degraded : null });
    } catch { observations.push({ method, received: false, configured: null, degraded: null }); }
  }
  return { status: "unverified" as const, launches: 0, blockers: [...blockers], observations };
}

/** Future trusted broker adapter only; not injectable from CLI/config or evidence JSON. */
export interface FleetAdapter {
  run(input: { runId: string; phase: "warmup" | "measured"; workerCount: 8; signal: AbortSignal }): Promise<{ captureComplete: boolean; dispositions: number; terminalAttempts: number; failures: string[] }>;
  cleanup(runId: string, signal: AbortSignal): Promise<{ complete: boolean; unexplained: number }>;
}
export async function collectSequence(adapter: FleetAdapter, timeoutMs: number, persist: (row: object) => Promise<void>) {
  const { randomUUID } = await import("node:crypto");
  for (let index = 0; index < 4; index++) {
    const runId = randomUUID(), phase = index === 0 ? "warmup" : "measured";
    const row: Record<string, unknown> = { runId, phase, status: "unverified", startedAt: new Date().toISOString() };
    // Persist intent before a possibly partial launch. Restart reconciliation is mandatory.
    await persist({ ...row, stage: "intent" });
    let runSettled = false;
    try { row.result = await bounded(signal => adapter.run({ runId, phase, workerCount: 8, signal }).finally(() => { runSettled = true; }), timeoutMs); }
    catch { row.failure = "run-failed-or-timeout"; }
    let safe = false;
    try { const cleanup = await bounded(signal => adapter.cleanup(runId, signal), timeoutMs); row.cleanup = cleanup; safe = cleanup.complete && cleanup.unexplained === 0; }
    catch { row.cleanup = { complete: false }; }
    row.launchOperationSettled = runSettled;
    row.finishedAt = new Date().toISOString();
    await persist(row);
    if (!safe || !runSettled) break; // Never compound unknown ownership with another run.
  }
}
