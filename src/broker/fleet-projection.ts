import { createHash, randomUUID } from "node:crypto";
import type { FleetProjectionReply, FleetProjectionSnapshot } from "../domain/fleet-projection.js";
import { fleetOrchestratorOwnership, fleetWorkerCoordinationView } from "./worker-coordination-view.js";
import type { BrokerServerOptions } from "./server/options.js";

export interface RetainedFleetProjection { version: string; snapshot: FleetProjectionSnapshot }
/** Per-connection single-generation deltas; missing or older versions always receive a full resync. */
export class FleetProjection {
  readonly epoch = randomUUID();
  constructor(private readonly options: BrokerServerOptions) {}

  async read(baseVersion?: string, previous?: RetainedFleetProjection): Promise<{
    reply: FleetProjectionReply; retained: RetainedFleetProjection;
  }> {
    const sessions = this.options.registry.list();
    const ids = new Set(sessions.map(({ id }) => id));
    const [bindings, projects] = await Promise.all([
      this.options.orchestratorBindings?.list() ?? [],
      this.options.fleetProjects?.list(),
    ]);
    const coordination = new Map(fleetWorkerCoordinationView(
      (this.options.workerCoordination?.listSubjects() ?? [])
        .filter((subject) => ids.has(subject.resources.sessionId ?? "")),
    ).map((entry) => [entry.sessionId, entry]));
    const owners = new Map(fleetOrchestratorOwnership(bindings.filter((binding) => ids.has(binding.sessionId)))
      .map((entry) => [entry.sessionId, entry.controllerId]));
    const snapshot: FleetProjectionSnapshot = {
      threads: sessions.map(({ launchRecord: _launch, providerInstructions: _instructions, imageAttachments: _images, ...record }) => ({
        record: structuredClone(record),
        ...(coordination.has(record.id) ? { coordination: coordination.get(record.id)! } : {}),
        ...(owners.has(record.id) ? { controllerId: owners.get(record.id)! } : {}),
      })),
      ...(projects === undefined ? {} : { projects }),
    };
    const version = `${this.epoch}:${createHash("sha256").update(JSON.stringify(snapshot)).digest("hex")}`;
    const retained = { version, snapshot };
    if (previous === undefined || baseVersion !== previous.version) {
      return { reply: { kind: "full", version, snapshot }, retained };
    }
    if (version === baseVersion) return { reply: { kind: "unchanged", version }, retained };
    const old = new Map(previous.snapshot.threads.map((thread) => [thread.record.id, JSON.stringify(thread)]));
    const reply: FleetProjectionReply = {
      kind: "delta", version, baseVersion,
      upsert: snapshot.threads.filter((thread) => old.get(thread.record.id) !== JSON.stringify(thread)),
      remove: previous.snapshot.threads.filter((thread) => !ids.has(thread.record.id)).map((thread) => thread.record.id),
      ...(projects === undefined ? {} : { projects }),
    };
    // A burst affecting most rows is cheaper as a full resync. Retain only one previous generation.
    const full: FleetProjectionReply = { kind: "full", version, snapshot };
    return { reply: Buffer.byteLength(JSON.stringify(reply)) < Buffer.byteLength(JSON.stringify(full)) ? reply : full, retained };
  }
}
