import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorkerCoordinationService,
  type EventSubmissionInput,
} from "../../src/broker/worker-coordination.js";
import type {
  ControllerIdentity,
  EventAck,
  OwnershipMutationResult,
  OwnershipOutcome,
  WorkerEvent,
  WorkerLifecycle,
} from "../../src/domain/worker-coordination.js";
import { WorkerCoordinationStore } from "../../src/persistence/worker-coordination-store.js";

export const BASE_MS = Date.parse("2026-07-27T10:00:00.000Z");

const temporaryDirectories: string[] = [];

/** Remove every directory this harness created. Call from `afterEach`. */
export async function cleanupBrokers(): Promise<void> {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
}

export interface BrokerOptions {
  leaseDurationMs?: number;
  gracePeriodMs?: number;
  eventRateLimit?: number;
  eventRateWindowMs?: number;
  maxQueuedEventsPerWorker?: number;
  maxProjectionPageSize?: number;
}

export interface OpenBrokerOptions extends BrokerOptions {
  directory?: string;
  nowMs?: number;
}

/**
 * A broker process standing in front of one durable state directory.
 *
 * `restart()` drops the live store and service and replays the transaction log from disk, which is
 * the only honest way to assert that durable state — not in-memory bookkeeping — carries a
 * scenario across a broker lifetime.
 */
export class IntegrationBroker {
  store!: WorkerCoordinationStore;
  service!: WorkerCoordinationService;
  private clockMs: number;
  private settings: BrokerOptions;

  private constructor(readonly directory: string, nowMs: number, settings: BrokerOptions) {
    this.clockMs = nowMs;
    this.settings = settings;
  }

  static async open(options: OpenBrokerOptions = {}): Promise<IntegrationBroker> {
    const directory = options.directory
      ?? await mkdtemp(join(tmpdir(), "cyberdeck-coordination-integration-"));
    if (options.directory === undefined) temporaryDirectories.push(directory);
    const broker = new IntegrationBroker(directory, options.nowMs ?? BASE_MS, options);
    await broker.restart();
    return broker;
  }

  now(): string {
    return new Date(this.clockMs).toISOString();
  }

  advance(milliseconds: number): void {
    this.clockMs += milliseconds;
  }

  async restart(overrides: BrokerOptions = {}): Promise<void> {
    this.settings = { ...this.settings, ...overrides };
    this.store = new WorkerCoordinationStore(this.directory);
    this.service = buildService(this.store, () => this.now(), this.settings);
    await this.service.initialize();
  }
}

function buildService(
  store: WorkerCoordinationStore,
  now: () => string,
  settings: BrokerOptions,
): WorkerCoordinationService {
  return new WorkerCoordinationService({
    store,
    now,
    leaseDurationMs: settings.leaseDurationMs ?? 30_000,
    gracePeriodMs: settings.gracePeriodMs ?? 5_000,
    ...(settings.eventRateLimit === undefined ? {} : { eventRateLimit: settings.eventRateLimit }),
    ...(settings.eventRateWindowMs === undefined
      ? {}
      : { eventRateWindowMs: settings.eventRateWindowMs }),
    ...(settings.maxQueuedEventsPerWorker === undefined
      ? {}
      : { maxQueuedEventsPerWorker: settings.maxQueuedEventsPerWorker }),
    ...(settings.maxProjectionPageSize === undefined
      ? {}
      : { maxProjectionPageSize: settings.maxProjectionPageSize }),
  });
}

export function controller(name: string): ControllerIdentity {
  return {
    controllerId: `controller:${name}`,
    familyId: `family:${name}`,
    scope: { kind: "worktree", scopeId: `repo:${name}`, worktreePath: `/tmp/${name}` },
  };
}

export const BROKER_ACTOR = controller("broker-sweeper");

export interface RegisteredWorker {
  workerId: string;
  taskId: string;
  waveId: string | undefined;
  token: string | undefined;
  version: number | undefined;
  result: OwnershipMutationResult;
}

export async function registerWorker(
  service: WorkerCoordinationService,
  input: {
    workerId?: string;
    controller?: ControllerIdentity;
    actor?: ControllerIdentity;
    taskId?: string;
    waveId?: string;
    lifecycle?: WorkerLifecycle;
    mutationId?: string;
  } = {},
): Promise<RegisteredWorker> {
  const workerId = input.workerId ?? randomUUID();
  const taskId = input.taskId ?? `task:${workerId}`;
  const actor = input.actor ?? input.controller ?? controller("origin");
  const result = await service.registerSubject({
    mutationId: input.mutationId ?? `register:${workerId}`,
    actor,
    subjectId: workerId,
    origin: {
      creatorControllerId: actor.controllerId,
      creatorSessionId: randomUUID(),
      taskId,
      ...(input.waveId === undefined ? {} : { waveId: input.waveId }),
      threadId: `thread:${workerId}`,
      createdAt: new Date(BASE_MS).toISOString(),
    },
    lifecycle: input.lifecycle ?? "working",
    resources: {
      sessionId: workerId,
      worktreePath: `/tmp/worktrees/${workerId}`,
      taskPayloadRef: `task-payload:${workerId}`,
      transcriptRef: `transcript:${workerId}`,
      resultStateRef: `result:${workerId}`,
      eventStreamId: `stream:${workerId}`,
    },
    ...(input.controller === undefined ? {} : { controller: input.controller }),
    reason: "integration registration",
  });
  return {
    workerId,
    taskId,
    waveId: input.waveId,
    token: result.outcomes[0]?.leaseToken,
    version: result.outcomes[0]?.leaseVersion,
    result,
  };
}

export function workerEvent(
  worker: Pick<RegisteredWorker, "workerId" | "taskId" | "waveId">,
  leaseVersion: number,
  sequence: number,
  overrides: Partial<WorkerEvent> = {},
): WorkerEvent {
  return {
    schemaVersion: 1,
    eventId: `event:${worker.workerId}:${sequence}:${randomUUID()}`,
    sequence,
    workerId: worker.workerId,
    taskId: worker.taskId,
    ...(worker.waveId === undefined ? {} : { waveId: worker.waveId }),
    controllerLeaseVersion: leaseVersion,
    kind: "PROGRESS",
    severity: "info",
    interventionRequired: false,
    summary: `progress ${sequence}`,
    evidenceRefs: [],
    changedAssumptions: [],
    continuation: "continuing",
    timestamp: new Date(BASE_MS + sequence).toISOString(),
    ...overrides,
  };
}

export async function submit(
  service: WorkerCoordinationService,
  actor: ControllerIdentity,
  token: string,
  event: WorkerEvent,
  mutationId = `submit:${event.eventId}`,
): Promise<EventAck> {
  const input: EventSubmissionInput = { mutationId, controller: actor, leaseToken: token, event };
  return service.submitEvent(input);
}

/** Outcome codes keyed by subject, for asserting whole-wave results without ordering noise. */
export function outcomeCodes(result: OwnershipMutationResult): Map<string, string> {
  return new Map(result.outcomes.map((outcome) => [outcome.subjectId, outcome.code]));
}

export function outcomeFor(
  result: OwnershipMutationResult,
  subjectId: string,
): OwnershipOutcome {
  const outcome = result.outcomes.find((entry) => entry.subjectId === subjectId);
  if (outcome === undefined) throw new Error(`no outcome for ${subjectId}`);
  return outcome;
}

export function tokenFor(result: OwnershipMutationResult, subjectId: string): string {
  const token = outcomeFor(result, subjectId).leaseToken;
  if (token === undefined) throw new Error(`no lease token for ${subjectId}`);
  return token;
}
