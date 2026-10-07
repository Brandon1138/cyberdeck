import type { FleetProjectionReply } from "../../domain/fleet-projection.js";
import type { FleetSnapshot, InteractiveFleetTransport } from "./state.js";
import { collectFleetSnapshot } from "./transport.js";

/** One outstanding refresh and one pending invalidation, independently of visual frame wakeups. */
export class FleetSnapshotFeed {
  snapshot: FleetSnapshot = { threads: [] };
  error: string | undefined;
  private version: string | undefined;
  private compact = true;
  private inFlight: Promise<void> | undefined;
  private pending = false;
  private disposed = false;
  private disconnected = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private coalesce: ReturnType<typeof setTimeout> | undefined;
  private unsubscribe: (() => void)[] = [];
  private lastRefresh = 0;
  private notify = () => {};
  private reconnect: (() => Promise<InteractiveFleetTransport>) | undefined;
  private connected = (_client: InteractiveFleetTransport) => {};
  private closed = () => {};
  constructor(private client: InteractiveFleetTransport) { this.compact = client.fleetProjection === true; }

  start(notify: () => void, options: {
    reconnect?: () => Promise<InteractiveFleetTransport>;
    connected?: (client: InteractiveFleetTransport) => void;
    closed?: () => void;
  } = {}): void {
    this.notify = notify; this.reconnect = options.reconnect;
    this.connected = options.connected ?? this.connected; this.closed = options.closed ?? this.closed;
    this.listen();
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

  refresh(): Promise<void> {
    if (this.inFlight !== undefined) { this.pending = true; return this.inFlight; }
    this.pending = false;
    const operation = this.collect().then(() => {
      this.error = undefined;
      if (!this.disposed) this.notify();
    }).catch((error: unknown) => {
      this.error = `Fleet refresh failed; showing cached data: ${error instanceof Error ? error.message : String(error)}`;
      if (!this.disposed) this.notify();
      throw error;
    });
    this.inFlight = operation.finally(() => {
      this.inFlight = undefined;
      this.lastRefresh = Date.now();
      if (this.pending) this.invalidate();
    });
    return this.inFlight;
  }

  private async collect(): Promise<void> {
    if (this.disconnected) {
      if (this.reconnect === undefined) return;
      const client = await this.reconnect();
      if (this.disposed) { client.close(); return; }
      this.client = client; this.disconnected = false; this.version = undefined; this.compact = client.fleetProjection === true;
      this.connected(client); this.listen();
    }
    if (!this.compact) { this.snapshot = await collectFleetSnapshot(this.client); return; }
    let reply: FleetProjectionReply;
    try { reply = await this.client.request("fleet.snapshot", { version: this.version }); }
    catch (error) {
      if (!(typeof error === "object" && error !== null && "code" in error && error.code === "METHOD_NOT_FOUND")) throw error;
      this.compact = false; this.snapshot = await collectFleetSnapshot(this.client); return;
    }
    // Structural fallback also supports simple older transports; only the wire broker sends versions.
    if (typeof reply !== "object" || reply === null || !("kind" in reply)) {
      this.compact = false; this.snapshot = await collectFleetSnapshot(this.client); return;
    }
    if (this.disposed) return;
    if (reply.kind === "full") this.snapshot = reply.snapshot;
    else if (reply.kind === "delta") {
      if (reply.baseVersion !== this.version) { this.version = undefined; this.pending = true; return; }
      const threads = new Map(this.snapshot.threads.map((thread) => [thread.record.id, thread]));
      for (const id of reply.remove) threads.delete(id);
      for (const thread of reply.upsert) threads.set(thread.record.id, thread);
      this.snapshot = { threads: [...threads.values()], ...(reply.projects === undefined ? {} : { projects: reply.projects }) };
    } else if (reply.version !== this.version) { this.version = undefined; this.pending = true; return; }
    this.version = reply.version;
  }

  private listen(): void {
    for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
    this.unsubscribe.push(this.client.onFrame((frame) => {
      if (frame.type === "fleet-invalidated") this.invalidate();
    }), this.client.onClose(() => {
      this.disconnected = true; this.version = undefined;
      if (this.reconnect === undefined) this.closed();
      else { this.error = "Broker disconnected; showing cached Fleet while reconnecting."; this.notify(); this.invalidate(); }
    }));
    void this.client.request("fleet.subscribe", {}).then(() => this.invalidate()).catch(() => {});
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    if (this.coalesce !== undefined) clearTimeout(this.coalesce);
    for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
    if (!this.disconnected) void this.client.request("fleet.unsubscribe", {}).catch(() => {});
  }
}
