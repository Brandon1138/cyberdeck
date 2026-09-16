import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { ActivityInput } from "../../domain/agent-activity.js";
import { ResourceSummarySchema, type ResourceSummary } from "../../domain/resource-summary.js";
import type { AgentActivityPort } from "../../orchestration/agent-activity-port.js";
import { resourceIncident } from "../../observability/resource-projection.js";
import { ensurePrivateDirectory } from "../../persistence/private-files.js";

const SUMMARY_INTERVAL_MS = 60_000;
const MAX_STATE_BYTES = 16 * 1024;
const timestamp = z.number().int().nonnegative().max(253_402_300_799_999);
const incidentState = ResourceSummarySchema.shape.reason.exclude(["healthy", "recovered"]).nullable();
const ResourceEventSchema = z.object({
  schemaVersion: z.literal(1), eventId: z.uuid(), sourceKey: z.string().max(128), sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  runId: z.uuid(), workerId: z.uuid(), sessionId: z.uuid(), observedAt: z.iso.datetime(),
  kind: z.enum(["resource.summary", "resource.incident"]), provenance: z.literal("broker"),
  coverage: z.literal("partial"), outcome: z.enum(["observed", "succeeded"]), operation: z.literal("resource"),
  resource: ResourceSummarySchema,
}).strict();
type ResourceEvent = z.infer<typeof ResourceEventSchema>;
const StateSchema = z.object({
  version: z.literal(1), installationId: z.uuid(), brokerId: z.uuid(), revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  lastSummaryAt: timestamp.nullable(), incidentState, pinned: z.boolean(),
  pending: z.object({ events: z.array(ResourceEventSchema).min(1).max(2), incidentState }).strict().nullable(),
}).strict();
type State = z.infer<typeof StateSchema>;
const EnvelopeSchema = z.object({ checksum: z.string().regex(/^[a-f0-9]{64}$/), state: StateSchema }).strict();
type Failure = "summary-invalid" | "summary-read-failed" | "capture-failed" | "storage-failed" | "ownership-lost" | "corrupt-state" | null;
export interface ResourceActivityBridgeOptions {
  path: string;
  installationId: string;
  brokerId: string;
  activity: AgentActivityPort;
  readSummary(): ResourceSummary;
  assertOwner(): void | Promise<void>;
  now?: () => number;
}
function hash(value: unknown): string {
  const canonical = JSON.stringify(value, (_key, entry: unknown) => entry && typeof entry === "object" && !Array.isArray(entry)
    ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : entry);
  return createHash("sha256").update(canonical).digest("hex");
}
function sourceKey(event: Pick<ResourceEvent, "kind" | "runId" | "eventId">): string {
  return `${event.kind}:${event.runId}:${event.eventId}`;
}
function validateState(input: unknown, installationId: string, brokerId: string): State {
  const envelope = EnvelopeSchema.parse(input), state = envelope.state;
  if (hash(state) !== envelope.checksum || state.installationId !== installationId || state.brokerId !== brokerId) throw new Error("RESOURCE_STATE_INVALID");
  const events = state.pending?.events ?? [];
  if (new Set(events.map(event => event.kind)).size !== events.length
    || events.length === 2 && events[0]?.kind !== "resource.summary") throw new Error("RESOURCE_STATE_INVALID");
  for (const event of events) {
    const { sourceHash, ...body } = event;
    if (event.runId !== installationId || event.sessionId !== brokerId || event.workerId !== brokerId
      || event.sourceKey !== sourceKey(event) || hash(body) !== sourceHash) throw new Error("RESOURCE_STATE_INVALID");
  }
  const incident = events.find(event => event.kind === "resource.incident");
  if (state.pending) {
    if (!state.pinned) throw new Error("RESOURCE_STATE_INVALID");
    const transition = incident ? resourceIncident(state.incidentState, incident.resource.reason) : undefined;
    if (incident && (!transition?.emit || transition.state !== state.pending.incidentState
      || incident.outcome !== (transition.recovered ? "succeeded" : "observed"))
      || !incident && state.pending.incidentState !== state.incidentState) throw new Error("RESOURCE_STATE_INVALID");
  }
  return state;
}

/** Local durable activity outbox. The caller owns sampling/timers; there is no remote sink here. */
export class ResourceActivityBridge {
  private state: State;
  private failure: Failure = null;
  private blocked = false;
  private closed = false;
  private pinConfirmed = false;
  private ticking: Promise<void> | undefined;
  private readonly now: () => number;
  private constructor(private readonly options: ResourceActivityBridgeOptions) {
    this.now = options.now ?? Date.now;
    this.state = { version: 1, installationId: z.uuid().parse(options.installationId), brokerId: z.uuid().parse(options.brokerId),
      revision: 0, lastSummaryAt: null, incidentState: null, pinned: false, pending: null };
  }
  /** Loads bounded state only. The next tick retries any durable pending events before sampling. */
  static async open(options: ResourceActivityBridgeOptions): Promise<ResourceActivityBridge> {
    const bridge = new ResourceActivityBridge(options);
    if (!await bridge.owner()) return bridge;
    try {
      await ensurePrivateDirectory(dirname(options.path));
      const stored = await bridge.read(options.path), staging = await bridge.read(bridge.stagingPath);
      if (stored) bridge.state = stored;
      if (staging) {
        if (staging.revision !== bridge.state.revision + 1) throw new Error("RESOURCE_STATE_INVALID");
        // A complete fixed staging file is an unambiguous next transaction. Publish it durably
        // before replay, even if the old process crashed before fsync/rename.
        if (!await bridge.owner()) return bridge;
        const file = await open(bridge.stagingPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        try { await file.sync(); } finally { await file.close(); }
        if (!await bridge.owner()) return bridge;
        await rename(bridge.stagingPath, options.path);
        await bridge.syncDirectory();
        bridge.state = staging;
      }
    } catch { bridge.fail("corrupt-state", true); }
    return bridge;
  }
  health(): { degraded: boolean; failure: Failure; pending: number; pinned: boolean; lastSummaryAt: number | null; closed: boolean } {
    return { degraded: this.failure !== null, failure: this.failure, pending: this.state.pending?.events.length ?? 0,
      pinned: this.state.pinned, lastSummaryAt: this.state.lastSummaryAt, closed: this.closed };
  }
  /** Concurrent ticks join the same operation; they never queue stale samples behind one another. */
  tick(): Promise<void> {
    if (this.closed || this.blocked) return Promise.resolve();
    if (this.ticking) return this.ticking;
    const ticking = this.step().finally(() => { if (this.ticking === ticking) this.ticking = undefined; });
    this.ticking = ticking;
    return ticking;
  }
  async close(): Promise<void> { this.closed = true; await this.ticking; }
  private fail(failure: Exclude<Failure, null>, blocked = false): void { this.failure = failure; this.blocked ||= blocked; }
  private async owner(): Promise<boolean> {
    try { await this.options.assertOwner(); return true; }
    catch { this.fail("ownership-lost", true); return false; }
  }
  private async step(): Promise<void> {
    if (!await this.owner()) return;
    // Recovery is independent of a broken sampler. At most the existing two events are retried.
    if (this.state.pending) { await this.flush(); return; }
    if (this.state.pinned) { await this.unpin(); return; }
    let sample: unknown;
    try { sample = this.options.readSummary(); } catch { this.fail("summary-read-failed"); return; }
    const parsed = ResourceSummarySchema.safeParse(sample), now = this.clock();
    if (!parsed.success || now === undefined) { this.fail("summary-invalid"); return; }
    const summary = parsed.data, transition = resourceIncident(this.state.incidentState, summary.reason);
    const events: ResourceEvent[] = [];
    if (this.state.lastSummaryAt === null || now - this.state.lastSummaryAt >= SUMMARY_INTERVAL_MS) events.push(this.event("resource.summary", summary, now, false));
    if (transition.emit) events.push(this.event("resource.incident", { ...summary, reason: transition.recovered ? "recovered" : summary.reason }, now, transition.recovered));
    if (events.length === 0) { this.failure = null; return; }
    if (!await this.persist({ ...this.state, pinned: true, pending: { events, incidentState: transition.state as State["incidentState"] } })) return;
    await this.flush();
  }
  private event(kind: ResourceEvent["kind"], resource: ResourceSummary, now: number, recovered: boolean): ResourceEvent {
    const body = { schemaVersion: 1 as const, eventId: randomUUID(), runId: this.state.installationId,
      workerId: this.state.brokerId, sessionId: this.state.brokerId, observedAt: new Date(now).toISOString(), kind,
      provenance: "broker" as const, coverage: "partial" as const, operation: "resource" as const,
      outcome: recovered ? "succeeded" as const : "observed" as const, resource };
    const sourced = { ...body, sourceKey: sourceKey(body) };
    return ResourceEventSchema.parse({ ...sourced, sourceHash: hash(sourced) });
  }
  private async flush(): Promise<void> {
    const pending = this.state.pending;
    if (!pending) return;
    if (!await this.pin(true)) return;
    for (const event of pending.events) {
      if (!await this.owner()) return;
      try { await this.options.activity.append(structuredClone(event) satisfies ActivityInput); }
      catch { this.fail("capture-failed"); return; }
    }
    // Throttle from actual delivery, including delayed replay; never catch up missed summaries.
    const now = this.clock();
    if (now === undefined) { this.fail("summary-invalid"); return; }
    const lastSummaryAt = pending.events.some(event => event.kind === "resource.summary")
      ? Math.max(this.state.lastSummaryAt ?? 0, now) : this.state.lastSummaryAt;
    if (await this.persist({ ...this.state, lastSummaryAt, incidentState: pending.incidentState, pending: null })) await this.unpin();
  }
  private async pin(pinned: boolean): Promise<boolean> {
    if (!await this.owner()) return false;
    if (pinned && this.pinConfirmed) return true;
    try {
      if (!this.options.activity.pin) throw new Error("RESOURCE_RETENTION_PIN_UNAVAILABLE");
      await this.options.activity.pin(this.state.installationId, pinned);
      this.pinConfirmed = pinned;
      return true;
    } catch { this.fail("capture-failed"); return false; }
  }
  private async unpin(): Promise<void> {
    if (await this.pin(false) && await this.persist({ ...this.state, pinned: false })) this.failure = null;
  }
  private clock(): number | undefined {
    try { const clock = timestamp.safeParse(this.now()); return clock.success ? clock.data : undefined; } catch { return undefined; }
  }
  private get stagingPath(): string { return `${this.options.path}.pending`; }
  private async read(path: string): Promise<State | undefined> {
    let file;
    try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_STATE_BYTES || (stat.mode & 0o077) !== 0) throw new Error("RESOURCE_STATE_INVALID");
      const buffer = Buffer.alloc(MAX_STATE_BYTES + 1), { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      const after = await file.stat();
      if (bytesRead !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error("RESOURCE_STATE_INVALID");
      return validateState(JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")), this.state.installationId, this.state.brokerId);
    } finally { await file.close(); }
  }
  private async persist(next: State): Promise<boolean> {
    if (!await this.owner()) return false;
    next = { ...next, revision: this.state.revision + 1 };
    try {
      const state = StateSchema.parse(next), body = JSON.stringify({ checksum: hash(state), state });
      if (Buffer.byteLength(body) > MAX_STATE_BYTES) throw new Error("RESOURCE_STATE_LIMIT");
      const file = await open(this.stagingPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(body); await file.sync(); } finally { await file.close(); }
      if (!await this.owner()) return false;
      await rename(this.stagingPath, this.options.path);
      await this.syncDirectory();
      this.state = state;
      return true;
    } catch { this.fail("storage-failed", true); return false; }
  }
  private async syncDirectory(): Promise<void> {
    const directory = await open(dirname(this.options.path), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }
}
