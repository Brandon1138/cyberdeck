import type { FleetProjectionReply } from "../../domain/fleet-projection.js";
import type { FleetSnapshot, InteractiveFleetTransport } from "./state.js";
import { collectFleetSnapshot } from "./transport.js";
import { callerDeadline } from "../../orchestration/caller-deadline.js";

/** One outstanding refresh and one pending invalidation, independently of visual frame wakeups. */
export class FleetSnapshotFeed {
  snapshot: FleetSnapshot = { threads: [] };
  error: string | undefined;
  private version: string | undefined;
  private generation = 0;
  private compact = true;
  private inFlight: Promise<void> | undefined;
  private pending = false;
  private disposed = false;
  private disconnected = false;
  private started = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private coalesce: ReturnType<typeof setTimeout> | undefined;
  private unsubscribe: (() => void)[] = [];
  private lastRefresh = 0;
  private lastSuccess: number | undefined;
  private staleTimer: ReturnType<typeof setTimeout> | undefined;
  private observation: AbortController | undefined;
  private legacyInFlight: Promise<FleetSnapshot> | undefined;
  private legacyGeneration = 0;
  private notify = () => {};
  private reconnect: (() => Promise<InteractiveFleetTransport>) | undefined;
  private connected = (_client: InteractiveFleetTransport) => {};
  private closed = () => {};
  constructor(private client: InteractiveFleetTransport) {
    this.compact = client.fleetProjection === true;
    this.observeClosure();
  }

  start(notify: () => void, options: {
    reconnect?: () => Promise<InteractiveFleetTransport>;
    connected?: (client: InteractiveFleetTransport) => void;
    closed?: () => void;
  } = {}): void {
    this.notify = notify; this.reconnect = options.reconnect;
    this.connected = options.connected ?? this.connected; this.closed = options.closed ?? this.closed;
    this.started = true;
    this.listen();
    if (this.disconnected) this.disconnect();
    // Periodic validation covers external journal edits, lease expiry, and lost invalidations.
    this.timer = setInterval(() => {
      if (Date.now() - this.lastRefresh >= (this.compact ? 2_000 : 100)) {
        if (this.compact) this.invalidate();
        else void this.refresh().catch(() => {});
      }
    }, 100);
  }

  invalidate(): void {
    if (this.disposed) return;
    this.pending = true;
    if (this.inFlight !== undefined || this.coalesce !== undefined) return;
    this.coalesce = setTimeout(() => {
      this.coalesce = undefined;
      void this.refresh().catch(() => { /* Keep cached display; retry on the fallback interval. */ });
    }, 100);
  }

  /** Actions may return a newer full snapshot. Fence pending replies and resync its wire version. */
  resync(snapshot: FleetSnapshot): void {
    this.snapshot = snapshot; this.version = undefined; this.generation++;
    this.invalidate();
  }

  refresh(): Promise<void> {
    if (this.inFlight !== undefined) { this.pending = true; return this.inFlight; }
    this.pending = false;
    this.observation = new AbortController();
    const generation = this.generation;
    this.staleTimer = setTimeout(() => {
      const age = this.lastSuccess === undefined ? "no snapshot yet" : `${Math.floor((Date.now() - this.lastSuccess) / 1_000)}s old`;
      this.error = `Fleet refresh pending; cached data is stale (${age}).`;
      if (!this.disposed) this.notify();
    }, 2_000);
    const operation = callerDeadline(this.collect(generation, performance.now() + 5_000), 5_000, "Fleet refresh", this.observation.signal).then(() => {
      this.error = undefined;
      this.lastSuccess = Date.now();
      if (!this.disposed) this.notify();
    }).catch((error: unknown) => {
      // A late reply must not overwrite a later refresh or an action snapshot.
      this.generation++;
      if (isDisconnected(error)) this.disconnect();
      this.error = `Fleet refresh failed; showing cached data: ${error instanceof Error ? error.message : String(error)}`;
      if (!this.disposed) this.notify();
      throw error;
    });
    this.inFlight = operation.finally(() => {
      if (this.staleTimer !== undefined) clearTimeout(this.staleTimer);
      this.inFlight = undefined;
      this.lastRefresh = Date.now();
      if (this.pending) this.invalidate();
    });
    return this.inFlight;
  }

  private async collect(generation: number, deadline: number): Promise<void> {
    if (this.disconnected) {
      if (this.reconnect === undefined) return;
      const client = await this.reconnect();
      if (this.disposed || generation !== this.generation) { client.close(); return; }
      this.client = client; this.disconnected = false; this.version = undefined; this.compact = client.fleetProjection === true;
      this.connected(client); this.listen();
    }
    if (!this.compact) {
      await this.collectLegacy(generation, deadline);
      return;
    }
    let reply: FleetProjectionReply;
    try { reply = await (this.client.requestWithDeadline === undefined
      ? this.client.request<FleetProjectionReply>("fleet.snapshot", { version: this.version })
      : this.client.requestWithDeadline<FleetProjectionReply>("fleet.snapshot", { version: this.version }, 5_000)); }
    catch (error) {
      if (this.disposed || generation !== this.generation) return;
      if (!(typeof error === "object" && error !== null && "code" in error && error.code === "METHOD_NOT_FOUND")) throw error;
      this.compact = false; await this.collectLegacy(generation, deadline); return;
    }
    if (this.disposed || generation !== this.generation) return;
    // Structural fallback also supports simple older transports; only the wire broker sends versions.
    if (typeof reply !== "object" || reply === null || !("kind" in reply)) {
      this.compact = false; await this.collectLegacy(generation, deadline); return;
    }
    if (this.disposed) return;
    if (generation !== this.generation) { this.pending = true; return; }
    if (reply.kind === "full") this.snapshot = reply.snapshot;
    else if (reply.kind === "delta") {
      if (reply.baseVersion !== this.version) { this.version = undefined; this.pending = true; return; }
      const threads = new Map(this.snapshot.threads.map((thread) => [thread.record.id, thread]));
      for (const id of reply.remove) threads.delete(id);
      for (const thread of reply.upsert) threads.set(thread.record.id, thread);
      if (reply.order !== undefined && (reply.order.length !== threads.size || new Set(reply.order).size !== threads.size || reply.order.some((id) => !threads.has(id)))) {
        this.version = undefined; this.pending = true; return;
      }
      this.snapshot = { ...this.snapshot, threads: reply.order === undefined ? [...threads.values()] : reply.order.map((id) => threads.get(id)!),
        ...(reply.currentLayout === undefined ? {} : { currentLayout: reply.currentLayout }),
        ...(reply.nativeAgentNotice === undefined ? {} : { nativeAgentNotice: reply.nativeAgentNotice ?? undefined }),
        ...(reply.projects === undefined ? {} : { projects: reply.projects }) };
    } else if (reply.version !== this.version) { this.version = undefined; this.pending = true; return; }
    this.version = reply.version;
  }

  private async collectLegacy(generation: number, deadline: number): Promise<void> {
    const client = this.client;
    if (this.legacyInFlight === undefined) this.legacyGeneration = generation;
    const sourceGeneration = this.legacyGeneration;
    const operation = this.legacyInFlight ?? collectFleetSnapshot({ request: <T = unknown>(method: string, params: unknown) => {
      const remaining = Math.max(0, deadline - performance.now());
      if (remaining === 0 || generation !== this.generation || this.disposed) return Promise.reject(new Error("Fleet refresh expired"));
      return client.requestWithDeadline === undefined ? client.request<T>(method, params)
        : client.requestWithDeadline<T>(method, params, remaining);
    } });
    this.legacyInFlight = operation;
    void operation.then(() => { if (this.legacyInFlight === operation) this.legacyInFlight = undefined; },
      () => { if (this.legacyInFlight === operation) this.legacyInFlight = undefined; });
    const snapshot = await operation;
    if (sourceGeneration !== generation) {
      this.pending = true;
      throw new Error("Expired Fleet response discarded; refreshing current data");
    }
    if (generation === this.generation && !this.disposed) this.snapshot = snapshot;
    else this.pending = true;
  }

  private listen(): void {
    for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
    this.observeClosure();
    if (this.disconnected) return;
    this.unsubscribe.push(this.client.onFrame((frame) => {
      if (frame.type === "fleet-invalidated") this.invalidate();
    }));
    const client = this.client;
    void client.request("fleet.subscribe", {}).then(() => { if (client === this.client) this.invalidate(); }).catch((error: unknown) => {
      if (client === this.client && isDisconnected(error)) this.disconnect();
    });
  }

  private observeClosure(): void {
    this.unsubscribe.push(this.client.onClose(() => this.disconnect()));
  }

  private disconnect(): void {
    if (this.disposed) return;
    if (!this.disconnected) {
      this.disconnected = true; this.version = undefined; this.generation++;
    }
    // Initial loading can outlive its transport. Retain closure until start supplies callbacks.
    if (!this.started) return;
    if (this.reconnect === undefined) this.closed();
    else { this.error = "Broker disconnected; showing cached Fleet while reconnecting."; this.notify(); this.invalidate(); }
  }

  dispose(): void {
    this.disposed = true;
    this.observation?.abort();
    this.generation++;
    if (this.staleTimer !== undefined) clearTimeout(this.staleTimer);
    if (this.timer !== undefined) clearInterval(this.timer);
    if (this.coalesce !== undefined) clearTimeout(this.coalesce);
    for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
    if (!this.disconnected) void this.client.request("fleet.unsubscribe", {}).catch(() => {});
  }
}
function isDisconnected(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "BROKER_DISCONNECTED";
}
