import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WorkerCoordinationService,
  type EventSubmissionInput,
} from "../../src/broker/worker-coordination.js";
import type {
  ControllerIdentity,
  OwnershipSubject,
  WorkerEvent,
  WorkerLifecycle,
} from "../../src/domain/worker-coordination.js";
import { ControllerIdentitySchema } from "../../src/domain/worker-coordination.js";
import { WorkerCoordinationStore } from "../../src/persistence/worker-coordination-store.js";

const directories: string[] = [];
const baseMs = Date.parse("2026-07-27T10:00:00.000Z");

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function controller(name: string): ControllerIdentity {
  return {
    controllerId: `controller:${name}`,
    familyId: `family:${name}`,
    scope: { kind: "worktree", scopeId: `repo:${name}`, worktreePath: `/tmp/${name}` },
  };
}

async function harness(options: {
  nowMs?: number;
  leaseDurationMs?: number;
  gracePeriodMs?: number;
  eventRateLimit?: number;
  maxQueuedEventsPerWorker?: number;
  maxProjectionPageSize?: number;
  directory?: string;
} = {}) {
  const directory = options.directory ?? await mkdtemp(join(tmpdir(), "cyberdeck-coordination-"));
  if (options.directory === undefined) directories.push(directory);
  let nowMs = options.nowMs ?? baseMs;
  const store = new WorkerCoordinationStore(directory);
  const service = new WorkerCoordinationService({
    store,
    now: () => new Date(nowMs).toISOString(),
    leaseDurationMs: options.leaseDurationMs ?? 30_000,
    gracePeriodMs: options.gracePeriodMs ?? 5_000,
    ...(options.eventRateLimit === undefined ? {} : { eventRateLimit: options.eventRateLimit }),
    ...(options.maxQueuedEventsPerWorker === undefined
      ? {}
      : { maxQueuedEventsPerWorker: options.maxQueuedEventsPerWorker }),
    ...(options.maxProjectionPageSize === undefined
      ? {}
      : { maxProjectionPageSize: options.maxProjectionPageSize }),
  });
  await service.initialize();
  return {
    directory,
    store,
    service,
    advance: (milliseconds: number) => { nowMs += milliseconds; },
    now: () => new Date(nowMs).toISOString(),
  };
}

async function register(
  service: WorkerCoordinationService,
  input: {
    workerId?: string;
    owner?: ControllerIdentity;
    waveId?: string;
    taskId?: string;
    lifecycle?: WorkerLifecycle;
    mutationId?: string;
  } = {},
) {
  const workerId = input.workerId ?? randomUUID();
  const actor = input.owner ?? controller("origin");
  const result = await service.registerSubject({
    mutationId: input.mutationId ?? `register:${workerId}`,
    actor,
    subjectId: workerId,
    origin: {
      creatorControllerId: actor.controllerId,
      creatorSessionId: randomUUID(),
      taskId: input.taskId ?? `task:${workerId}`,
      ...(input.waveId === undefined ? {} : { waveId: input.waveId }),
      threadId: `thread:${workerId}`,
      createdAt: new Date(baseMs).toISOString(),
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
    ...(input.owner === undefined ? {} : { controller: input.owner }),
    reason: "test registration",
  });
  return {
    workerId,
    result,
    token: result.outcomes[0]?.leaseToken,
    version: result.outcomes[0]?.leaseVersion,
  };
}

function outcomeCodesOf(result: { outcomes: { subjectId: string; code: string }[] }): Map<string, string> {
  return new Map(result.outcomes.map((outcome) => [outcome.subjectId, outcome.code]));
}

function event(
  workerId: string,
  leaseVersion: number,
  sequence: number,
  overrides: Partial<WorkerEvent> = {},
): WorkerEvent {
  return {
    schemaVersion: 1,
    eventId: `event:${workerId}:${sequence}:${randomUUID()}`,
    sequence,
    workerId,
    taskId: `task:${workerId}`,
    controllerLeaseVersion: leaseVersion,
    kind: "PROGRESS",
    severity: "info",
    interventionRequired: false,
    summary: `progress ${sequence}`,
    evidenceRefs: [],
    changedAssumptions: [],
    continuation: "continuing",
    timestamp: new Date(baseMs + sequence).toISOString(),
    ...overrides,
  };
}

/**
 * The handoff request digest exactly as the broker wrote it before `name` left the key.
 *
 * Kept here rather than exported from the broker: production has one derivation for new receipts,
 * and this is the shape of the receipts already on disk that an upgrade has to keep replaying.
 */
function legacyHandoffRequestHash(request: {
  actor: ControllerIdentity;
  recipient: ControllerIdentity;
  recipientSessionId: string;
  directive: string;
  members: readonly { subjectId: string; name?: string }[];
  reason: string;
}): string {
  const canonical = (value: unknown): string => {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
      .join(",")}}`;
  };
  return createHash("sha256").update(canonical({
    actor: request.actor,
    recipient: request.recipient,
    recipientSessionId: request.recipientSessionId,
    directive: request.directive,
    members: request.members.map(({ subjectId, name }) => ({ subjectId, name: name ?? null })),
    reason: request.reason,
    handoffId: null,
  })).digest("hex");
}

/** Rewrite one receipt's stored hash in place, as an older broker build would have written it. */
async function rewriteStoredRequestHash(
  storePath: string,
  mutationId: string,
  requestHash: string,
): Promise<number> {
  const lines = (await readFile(storePath, "utf8")).split("\n");
  let rewritten = 0;
  const patched = lines.map((line) => {
    if (line.trim() === "") return line;
    const entry = JSON.parse(line) as { receipts?: { mutationId: string; requestHash?: string }[] };
    for (const receipt of entry.receipts ?? []) {
      if (receipt.mutationId !== mutationId) continue;
      receipt.requestHash = requestHash;
      rewritten += 1;
    }
    return JSON.stringify(entry);
  });
  await writeFile(storePath, patched.join("\n"));
  return rewritten;
}

describe("WorkerCoordinationService ownership", () => {
  it("rejects conversation UUIDs as stable controller identities", () => {
    expect(() => ControllerIdentitySchema.parse({
      controllerId: randomUUID(),
      familyId: "family:stable",
      scope: { kind: "fleet", scopeId: "fleet" },
    })).toThrow(/stable family\/scope/);
  });

  it("performs graceful handoff, preserves worker resources, and fences stale controller", async () => {
    const { service } = await harness();
    const oldController = controller("old");
    const newController = controller("new");
    const created = await register(service, { owner: oldController });
    const before = service.getSubject(created.workerId)!;

    const transfer = await service.transfer({
      mutationId: "handoff",
      actor: oldController,
      selector: { scope: "single", subjectId: created.workerId },
      controller: oldController,
      leaseToken: created.token!,
      leaseVersion: created.version!,
      newController,
      reason: "graceful handoff",
    });

    expect(transfer.outcomes[0]).toMatchObject({
      code: "TRANSFERRED",
      currentController: newController,
      leaseVersion: 2,
    });
    const after = service.getSubject(created.workerId)!;
    expect(after.origin).toEqual(before.origin);
    expect(after.resources).toEqual(before.resources);
    expect(after.lifecycle).toBe(before.lifecycle);

    const stale = await service.renew({
      mutationId: "stale-return",
      actor: oldController,
      selector: { scope: "single", subjectId: created.workerId },
      controller: oldController,
      leaseToken: created.token!,
      leaseVersion: created.version!,
      reason: "old process returned",
    });
    expect(stale.outcomes[0]).toMatchObject({
      code: "OWNERSHIP_LOST",
      currentController: newController,
      leaseExpiresAt: expect.any(String),
    });
    expect(service.getSubject(created.workerId)?.lease.controller).toEqual(newController);
  });

  it("binds handoff mutation replays to complete request payloads across restarts", async () => {
    const first = await harness();
    const source = controller("handoff-source");
    const recipient = controller("handoff-recipient");
    const otherRecipient = controller("handoff-other-recipient");
    const firstWorker = await register(first.service, { owner: source });
    const secondWorker = await register(first.service, { owner: source });
    const request = {
      mutationId: "payload-bound-handoff",
      actor: controller("handoff-operator"),
      recipient,
      recipientSessionId: "11111111-1111-4111-8111-111111111111",
      directive: "Continue both workers",
      members: [
        { subjectId: firstWorker.workerId },
        { subjectId: secondWorker.workerId },
      ],
      reason: "operator directed handoff",
    };

    const recorded = await first.service.handoffBatch(request);
    const restarted = await harness({ directory: first.directory });
    await expect(restarted.service.handoffBatch(request)).resolves.toEqual({
      ...recorded,
      idempotentReplay: true,
    });

    for (const changed of [
      {
        ...request,
        recipient: otherRecipient,
        recipientSessionId: "22222222-2222-4222-8222-222222222222",
      },
      { ...request, members: request.members.slice(0, 1) },
      { ...request, directive: "Do something different" },
    ]) {
      await expect(restarted.service.handoffBatch(changed)).rejects.toMatchObject({
        code: "MUTATION_ID_COLLISION",
      });
    }
  });

  it("replays a committed handoff when the broker's own name for a member changed", async () => {
    const { service } = await harness();
    const source = controller("renamed-source");
    const recipient = controller("renamed-recipient");
    const first = await register(service, { owner: source });
    const second = await register(service, { owner: source });
    const request = {
      mutationId: "renamed-member-handoff",
      actor: controller("handoff-operator"),
      recipient,
      recipientSessionId: "33333333-3333-4333-8333-333333333333",
      directive: "Keep both going",
      members: [
        { subjectId: first.workerId, name: "docs sweep" },
        { subjectId: second.workerId, name: "test sweep" },
      ],
      reason: "operator directed handoff",
    };

    const committed = await service.handoffBatch(request);
    expect(committed.committed).toBe(true);

    // A worker renamed after the first commit, and one that dropped out of the session registry
    // altogether so the retry can no longer name it: neither is part of what the operator asked
    // for, so neither may turn a retry of the same mutation into a collision.
    for (const members of [
      [
        { subjectId: first.workerId, name: "renamed sweep" },
        { subjectId: second.workerId, name: "test sweep" },
      ],
      [{ subjectId: first.workerId }, { subjectId: second.workerId }],
    ]) {
      await expect(service.handoffBatch({ ...request, members })).resolves.toEqual({
        ...committed,
        idempotentReplay: true,
      });
    }
  });

  it("replays a handoff receipt whose stored hash predates the stable derivation", async () => {
    const first = await harness();
    const source = controller("legacy-source");
    const worker = await register(first.service, { owner: source });
    const request = {
      mutationId: "legacy-hash-handoff",
      actor: controller("handoff-operator"),
      recipient: controller("legacy-recipient"),
      recipientSessionId: "55555555-5555-4555-8555-555555555555",
      directive: "Pick this up",
      members: [{ subjectId: worker.workerId, name: "docs sweep" }],
      reason: "operator directed handoff",
    };
    const committed = await first.service.handoffBatch(request);
    expect(committed.committed).toBe(true);

    // What an upgrade actually finds on disk: a receipt keyed the old way, for a handoff that
    // committed. The identical retry must still be answered with it.
    expect(await rewriteStoredRequestHash(
      first.store.path,
      request.mutationId,
      legacyHandoffRequestHash(request),
    )).toBe(1);

    const upgraded = await harness({ directory: first.directory });
    await expect(upgraded.service.handoffBatch(request)).resolves.toEqual({
      ...committed,
      idempotentReplay: true,
    });

    // Compatibility is not a blanket accept: a different request under that mutation id still
    // collides, against the legacy derivation just as against the stable one.
    await expect(upgraded.service.handoffBatch({
      ...request,
      directive: "Do something else",
    })).rejects.toMatchObject({ code: "MUTATION_ID_COLLISION" });
  });

  it("aborts a handoff when the process bookkeeping reports a member terminal at commit time", async () => {
    const { service } = await harness();
    const source = controller("racing-source");
    const recipient = controller("racing-recipient");
    const live = await register(service, { owner: source });
    const dying = await register(service, { owner: source });

    const result = await service.handoffBatch({
      mutationId: "raced-handoff",
      actor: controller("handoff-operator"),
      recipient,
      recipientSessionId: "77777777-7777-4777-8777-777777777777",
      directive: "Take both",
      members: [{ subjectId: live.workerId }, { subjectId: dying.workerId }],
      reason: "operator directed handoff",
      // Both subjects still read `working`; the process the broker watches has already gone.
      observeLifecycle: (subjectId) => (subjectId === dying.workerId ? "failed" : "working"),
    });

    expect(result.committed).toBe(false);
    expect(outcomeCodesOf(result).get(dying.workerId)).toBe("WORKER_TERMINAL");
    expect(service.getSubject(live.workerId)?.lease.controller).toEqual(source);
    expect(service.listHandoffs()).toEqual([]);
  });

  it("turns broker-observed abrupt death into orphan then allows adoption", async () => {
    const { service, advance } = await harness({ gracePeriodMs: 5_000, leaseDurationMs: 60_000 });
    const owner = controller("dead");
    const adopter = controller("adopter");
    const created = await register(service, { owner });

    await service.observeControllerLiveness({
      mutationId: "dead-observed",
      actor: controller("broker"),
      controller: owner,
      state: "disconnected",
      reason: "connection closed",
    });
    advance(5_001);
    const expired = await service.expireLeases({
      mutationId: "expire-dead",
      reason: "missed heartbeat and grace",
    });
    expect(expired.outcomes[0]?.code).toBe("ORPHANED");
    expect(service.getSubject(created.workerId)?.lease.state).toBe("orphaned");

    const adopted = await service.adopt({
      mutationId: "adopt-dead",
      actor: adopter,
      selector: { scope: "inactive-controller", controllerId: owner.controllerId },
      newController: adopter,
      reason: "recover abandoned work",
    });
    expect(adopted.outcomes[0]).toMatchObject({
      code: "ACQUIRED",
      currentController: adopter,
      leaseVersion: 2,
    });
  });

  it("treats authenticated controller call as broker-observed renewal", async () => {
    const { service, advance } = await harness({ gracePeriodMs: 5_000, leaseDurationMs: 60_000 });
    const owner = controller("reconnected");
    const created = await register(service, { owner });
    await service.observeControllerLiveness({
      mutationId: "temporary-disconnect",
      actor: controller("broker"),
      controller: owner,
      state: "disconnected",
      reason: "transport replacement",
    });
    advance(1_000);
    await service.renew({
      mutationId: "return-before-grace",
      actor: owner,
      selector: { scope: "single", subjectId: created.workerId },
      controller: owner,
      leaseToken: created.token!,
      reason: "authenticated replacement process",
    });
    advance(5_000);
    const expired = await service.expireLeases({
      mutationId: "should-remain-live",
      reason: "sweep",
    });
    expect(expired.outcomes).toEqual([]);
    expect(service.getSubject(created.workerId)?.lease.state).toBe("active");
  });

  it("serializes concurrent takeover attempts and returns conflict context to loser", async () => {
    const { service } = await harness();
    const created = await register(service);
    const first = controller("first");
    const second = controller("second");

    const [left, right] = await Promise.all([
      service.adopt({
        mutationId: "race:first",
        actor: first,
        selector: { scope: "single", subjectId: created.workerId },
        newController: first,
        reason: "race",
      }),
      service.adopt({
        mutationId: "race:second",
        actor: second,
        selector: { scope: "single", subjectId: created.workerId },
        newController: second,
        reason: "race",
      }),
    ]);

    const results = [left.outcomes[0]!, right.outcomes[0]!];
    expect(results.filter(({ code }) => code === "ACQUIRED")).toHaveLength(1);
    const loser = results.find(({ code }) => code === "LEASE_CONFLICT");
    expect(loser).toMatchObject({
      code: "LEASE_CONFLICT",
      currentController: expect.objectContaining({ controllerId: expect.any(String) }),
      leaseExpiresAt: expect.any(String),
    });
  });

  it("adopts eligible part of a wave without failing whole wave", async () => {
    const { service } = await harness();
    const incumbent = controller("incumbent");
    const adopter = controller("wave-adopter");
    const active = await register(service, { owner: incumbent, waveId: "wave-1" });
    const orphan = await register(service, { waveId: "wave-1" });
    const terminal = await register(service, { waveId: "wave-1", lifecycle: "done" });

    const result = await service.adopt({
      mutationId: "partial-wave",
      actor: adopter,
      selector: { scope: "group", waveId: "wave-1" },
      newController: adopter,
      reason: "partial wave recovery",
    });
    expect(new Map(result.outcomes.map((entry) => [entry.subjectId, entry.code]))).toEqual(new Map([
      [active.workerId, "LEASE_CONFLICT"],
      [orphan.workerId, "ACQUIRED"],
      [terminal.workerId, "WORKER_TERMINAL"],
    ]));
  });

  it("rejects an atomic adoption batch when one member is ineligible", async () => {
    const { service } = await harness();
    const adopter = controller("atomic-member-failure");
    const eligible = await register(service, { waveId: "wave-atomic-failure" });
    const terminal = await register(service, {
      waveId: "wave-atomic-failure",
      lifecycle: "done",
    });

    const result = await service.adoptBatch({
      mutationId: "atomic-member-failure",
      actor: adopter,
      newController: adopter,
      members: [
        { subjectId: eligible.workerId, mode: "adopt" },
        { subjectId: terminal.workerId, mode: "adopt" },
      ],
      reason: "batch must reject every member",
    });

    expect(result.committed).toBe(false);
    expect(new Map(result.outcomes.map((outcome) => [outcome.subjectId, outcome.code])))
      .toEqual(new Map([
        [eligible.workerId, "NOT_ELIGIBLE"],
        [terminal.workerId, "WORKER_TERMINAL"],
      ]));
    expect(service.getSubject(eligible.workerId)?.lease.state).toBe("orphaned");
    expect(service.getSubject(terminal.workerId)?.lease.state).toBe("orphaned");
  });

  it("changes no ownership when an atomic adoption append fails", async () => {
    const { service, store } = await harness();
    const adopter = controller("atomic-append-failure");
    const first = await register(service, { waveId: "wave-append-failure" });
    const second = await register(service, { waveId: "wave-append-failure" });
    vi.spyOn(store, "append").mockRejectedValueOnce(new Error("injected append failure"));

    await expect(service.adoptBatch({
      mutationId: "atomic-append-failure",
      actor: adopter,
      newController: adopter,
      members: [
        { subjectId: first.workerId, mode: "adopt" },
        { subjectId: second.workerId, mode: "adopt" },
      ],
      reason: "append must succeed before visibility",
    })).rejects.toThrow("injected append failure");

    expect(service.getSubject(first.workerId)?.lease.state).toBe("orphaned");
    expect(service.getSubject(second.workerId)?.lease.state).toBe("orphaned");
  });

  it("exposes either old or new ownership while an atomic adoption append is pending", async () => {
    const { service, store } = await harness();
    const adopter = controller("atomic-visibility");
    const first = await register(service, { waveId: "wave-visibility" });
    const second = await register(service, { waveId: "wave-visibility" });
    const append = store.append.bind(store);
    let markStarted!: () => void;
    let releaseAppend!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const gate = new Promise<void>((resolve) => { releaseAppend = resolve; });
    vi.spyOn(store, "append").mockImplementationOnce(async (transaction) => {
      markStarted();
      await gate;
      await append(transaction);
    });

    const pending = service.adoptBatch({
      mutationId: "atomic-visibility",
      actor: adopter,
      newController: adopter,
      members: [
        { subjectId: first.workerId, mode: "adopt" },
        { subjectId: second.workerId, mode: "adopt" },
      ],
      reason: "visibility gate",
    });
    await started;

    expect(service.getSubject(first.workerId)?.lease.controller).toBeUndefined();
    expect(service.getSubject(second.workerId)?.lease.controller).toBeUndefined();

    releaseAppend();
    await pending;

    expect(service.getSubject(first.workerId)?.lease.controller).toEqual(adopter);
    expect(service.getSubject(second.workerId)?.lease.controller).toEqual(adopter);
  });

  it("transfers a wave with per-worker lease tokens", async () => {
    const { service } = await harness();
    const owner = controller("wave-owner");
    const next = controller("wave-next");
    const first = await register(service, { owner, waveId: "wave-transfer" });
    const second = await register(service, { owner, waveId: "wave-transfer" });
    const result = await service.transfer({
      mutationId: "transfer-wave",
      actor: owner,
      selector: { scope: "group", waveId: "wave-transfer" },
      controller: owner,
      leaseTokens: {
        [first.workerId]: first.token!,
        [second.workerId]: second.token!,
      },
      newController: next,
      reason: "wave handoff",
    });
    expect(result.outcomes).toHaveLength(2);
    expect(result.outcomes.every(({ code }) => code === "TRANSFERRED")).toBe(true);
    expect(service.getSubject(first.workerId)?.lease.controller).toEqual(next);
    expect(service.getSubject(second.workerId)?.lease.controller).toEqual(next);
  });

  it("makes ownership mutations idempotent and audits actor/controller changes", async () => {
    const { service } = await harness();
    const owner = controller("idempotent");
    const created = await register(service, { owner, mutationId: "same-register" });
    const registerReplay = await register(service, {
      workerId: created.workerId,
      owner,
      mutationId: "same-register",
    });
    expect(registerReplay.result.idempotentReplay).toBe(true);

    const renewInput = {
      mutationId: "same-renew",
      actor: owner,
      selector: { scope: "single" as const, subjectId: created.workerId },
      controller: owner,
      leaseToken: created.token!,
      reason: "heartbeat",
    };
    const first = await service.renew(renewInput);
    const replay = await service.renew(renewInput);
    expect(replay).toEqual({ ...first, idempotentReplay: true });
    expect(service.listAudits(created.workerId).filter((audit) => audit.operation === "renew")).toHaveLength(1);
  });

  it("replays release, acquire, transfer, adopt, lifecycle, liveness, and expiry mutations", async () => {
    const { service, advance } = await harness({ leaseDurationMs: 1_000, gracePeriodMs: 500 });
    const firstOwner = controller("all-first");
    const secondOwner = controller("all-second");
    const created = await register(service, { owner: firstOwner });

    const releaseInput = {
      mutationId: "all-release",
      actor: firstOwner,
      selector: { scope: "single" as const, subjectId: created.workerId },
      controller: firstOwner,
      leaseToken: created.token!,
      reason: "release",
    };
    const released = await service.release(releaseInput);
    expect(await service.release(releaseInput)).toEqual({ ...released, idempotentReplay: true });

    const acquireInput = {
      mutationId: "all-acquire",
      actor: secondOwner,
      selector: { scope: "single" as const, subjectId: created.workerId },
      controller: secondOwner,
      reason: "acquire released worker",
    };
    const acquired = await service.acquire(acquireInput);
    expect(await service.acquire(acquireInput)).toEqual({ ...acquired, idempotentReplay: true });
    const acquiredToken = acquired.outcomes[0]?.leaseToken!;

    const transferInput = {
      mutationId: "all-transfer",
      actor: secondOwner,
      selector: { scope: "single" as const, subjectId: created.workerId },
      controller: secondOwner,
      leaseToken: acquiredToken,
      newController: firstOwner,
      reason: "transfer",
    };
    const transferred = await service.transfer(transferInput);
    expect(await service.transfer(transferInput)).toEqual({ ...transferred, idempotentReplay: true });
    const transferredToken = transferred.outcomes[0]?.leaseToken!;

    const lifecycleInput = {
      mutationId: "all-lifecycle",
      actor: firstOwner,
      selector: { scope: "single" as const, subjectId: created.workerId },
      subjectId: created.workerId,
      controller: firstOwner,
      leaseToken: transferredToken,
      lifecycle: "waiting" as const,
      reason: "waiting",
    };
    const lifecycle = await service.updateLifecycle(lifecycleInput);
    expect(await service.updateLifecycle(lifecycleInput)).toEqual({
      ...lifecycle,
      idempotentReplay: true,
    });

    const livenessInput = {
      mutationId: "all-liveness",
      actor: controller("broker"),
      controller: firstOwner,
      state: "disconnected" as const,
      reason: "disconnect",
    };
    const liveness = await service.observeControllerLiveness(livenessInput);
    expect(await service.observeControllerLiveness(livenessInput)).toEqual({
      ...liveness,
      idempotentReplay: true,
    });

    const orphan = await register(service);
    const adoptInput = {
      mutationId: "all-adopt",
      actor: secondOwner,
      selector: { scope: "single" as const, subjectId: orphan.workerId },
      newController: secondOwner,
      reason: "adopt",
    };
    const adopted = await service.adopt(adoptInput);
    expect(await service.adopt(adoptInput)).toEqual({ ...adopted, idempotentReplay: true });

    advance(1_001);
    const expireInput = { mutationId: "all-expire", reason: "timeout" };
    const expired = await service.expireLeases(expireInput);
    expect(await service.expireLeases(expireInput)).toEqual({ ...expired, idempotentReplay: true });
  });
});

describe("WorkerCoordinationService events and checkpoints", () => {
  async function ownedHarness(options: Parameters<typeof harness>[0] = {}) {
    const state = await harness(options);
    const owner = controller("events");
    const created = await register(state.service, { owner });
    return { ...state, owner, ...created };
  }

  async function submit(
    service: WorkerCoordinationService,
    owner: ControllerIdentity,
    token: string,
    value: WorkerEvent,
    mutationId = `submit:${value.eventId}`,
  ) {
    const input: EventSubmissionInput = {
      mutationId,
      controller: owner,
      leaseToken: token,
      event: value,
    };
    return service.submitEvent(input);
  }

  it("deduplicates event retries and detects sequence gaps", async () => {
    const { service, owner, workerId, token, version } = await ownedHarness();
    const firstEvent = event(workerId, version!, 1);
    const accepted = await submit(service, owner, token!, firstEvent);
    expect(accepted).toMatchObject({ code: "accepted" });
    await expect(submit(service, owner, token!, firstEvent)).resolves.toEqual(accepted);
    await expect(submit(service, owner, token!, firstEvent, "different-retry")).resolves.toMatchObject({
      code: "duplicate",
    });
    const gap = await submit(service, owner, token!, event(workerId, version!, 3));
    expect(gap).toMatchObject({
      code: "accepted",
      sequenceGap: { expected: 2, received: 3 },
    });
    expect(service.projectEvents().events).toHaveLength(1);
  });

  it("coalesces progress but pins interventions across controller transfer", async () => {
    const { service, owner, workerId, token, version } = await ownedHarness();
    const progress1 = event(workerId, version!, 1, {
      evidenceRefs: ["log:1"],
      changedAssumptions: ["old assumption changed"],
    });
    const progress2 = event(workerId, version!, 2, {
      evidenceRefs: ["log:2"],
      structuredFacts: { tests: 4 },
    });
    const exception = event(workerId, version!, 3, {
      kind: "EXCEPTION",
      severity: "error",
      interventionRequired: true,
      summary: "dependency unavailable",
      continuation: "blocked",
    });
    await submit(service, owner, token!, progress1);
    const progressAck = await submit(service, owner, token!, progress2);
    await expect(submit(
      service,
      owner,
      token!,
      progress2,
      "retry-coalesced-progress",
    )).resolves.toMatchObject({ code: "duplicate" });
    await submit(service, owner, token!, exception);
    expect(progressAck.supersededEventIds).toEqual([progress1.eventId]);
    const active = service.projectEvents().events;
    expect(active.map(({ eventId }) => eventId)).toEqual([progress2.eventId, exception.eventId]);
    expect(active[0]).toMatchObject({
      evidenceRefs: ["log:1", "log:2"],
      changedAssumptions: ["old assumption changed"],
      structuredFacts: { tests: 4 },
    });

    const adopter = controller("event-adopter");
    const transfer = await service.transfer({
      mutationId: "event-transfer",
      actor: owner,
      selector: { scope: "single", subjectId: workerId },
      controller: owner,
      leaseToken: token!,
      newController: adopter,
      reason: "handoff with intervention",
    });
    const newToken = transfer.outcomes[0]?.leaseToken;
    expect(service.projectEvents({
      filter: { intervention: "unresolved" },
    }).events.map(({ eventId }) => eventId)).toEqual([exception.eventId]);
    const resolutionInput = {
      mutationId: "resolve-after-transfer",
      controller: adopter,
      leaseToken: newToken!,
      eventId: exception.eventId,
      resolution: "acknowledged" as const,
      reason: "new controller owns intervention",
    };
    const resolved = await service.resolveEvent(resolutionInput);
    expect(resolved).toMatchObject({ code: "accepted" });
    await expect(service.resolveEvent(resolutionInput)).resolves.toEqual(resolved);
  });

  it("rejects oversize payloads and noisy workers with named limits", async () => {
    const { service, owner, workerId, token, version } = await ownedHarness({ eventRateLimit: 2 });
    const oversized = event(workerId, version!, 1, { summary: "x".repeat(17_000) });
    await expect(submit(service, owner, token!, oversized)).resolves.toMatchObject({
      code: "rejected",
      errorCode: "PAYLOAD_LIMIT_EXCEEDED",
      message: expect.stringContaining("16384"),
    });
    await submit(service, owner, token!, event(workerId, version!, 1));
    await submit(service, owner, token!, event(workerId, version!, 2));
    await expect(submit(service, owner, token!, event(workerId, version!, 3))).resolves.toMatchObject({
      code: "rejected",
      errorCode: "RATE_LIMITED",
      message: expect.stringContaining("2 per"),
    });
  });

  it("bounds queues and cursor pages", async () => {
    const { service, owner, workerId, token, version } = await ownedHarness({
      maxQueuedEventsPerWorker: 3,
      maxProjectionPageSize: 2,
      eventRateLimit: 20,
    });
    for (let sequence = 1; sequence <= 5; sequence += 1) {
      await submit(service, owner, token!, event(workerId, version!, sequence, {
        kind: "RISK",
        summary: `risk ${sequence}`,
      }));
    }
    const first = service.projectEvents({ cursor: 0, limit: 99 });
    expect(first.events).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    const second = service.projectEvents({ cursor: first.nextCursor, limit: 99 });
    expect(second.events.length).toBeLessThanOrEqual(2);
    expect([...first.events, ...second.events].filter(({ state }) => state === "active")).toHaveLength(3);
  });

  it("correlates non-blocking and decision-gate checkpoints", async () => {
    const { service, owner, workerId, token, version } = await ownedHarness();
    const nonBlockingInput = {
      mutationId: "checkpoint:nonblocking",
      controller: owner,
      leaseToken: token!,
      correlationId: "correlation:nonblocking",
      workerId,
      focus: "test state",
    };
    const nonBlocking = await service.requestCheckpoint(nonBlockingInput);
    await expect(service.requestCheckpoint(nonBlockingInput)).resolves.toEqual(nonBlocking);
    expect(nonBlocking.mode).toBe("non-blocking");
    expect(service.getSubject(workerId)?.lifecycle).toBe("working");
    expect(service.getSubject(workerId)?.decisionGate.state).toBe("none");

    const response = event(workerId, version!, 1, {
      kind: "CHECKPOINT",
      checkpointCorrelationId: nonBlocking.correlationId,
      summary: "checkpoint response",
    });
    await expect(submit(service, owner, token!, response)).resolves.toMatchObject({ code: "accepted" });
    expect(service.listCheckpoints(workerId)[0]).toMatchObject({
      state: "answered",
      answeredByEventId: response.eventId,
    });

    await service.requestCheckpoint({
      mutationId: "checkpoint:gate",
      controller: owner,
      leaseToken: token!,
      correlationId: "correlation:gate",
      workerId,
      question: "choose path",
      mode: "decision-gate",
    });
    expect(service.getSubject(workerId)?.decisionGate).toMatchObject({
      state: "decision-gate",
      correlationId: "correlation:gate",
    });
    expect(service.getSubject(workerId)?.lifecycle).toBe("working");
  });

  it("clears only the decision gate matching the answered checkpoint", async () => {
    const { service, owner, workerId, token, version } = await ownedHarness();
    await service.requestCheckpoint({
      mutationId: "checkpoint:gate:a",
      controller: owner,
      leaseToken: token!,
      correlationId: "correlation:gate:a",
      workerId,
      mode: "decision-gate",
    });
    await service.requestCheckpoint({
      mutationId: "checkpoint:gate:b",
      controller: owner,
      leaseToken: token!,
      correlationId: "correlation:gate:b",
      workerId,
      mode: "decision-gate",
    });

    await submit(service, owner, token!, event(workerId, version!, 1, {
      kind: "CHECKPOINT",
      checkpointCorrelationId: "correlation:gate:a",
      summary: "answer A",
    }));
    expect(service.getSubject(workerId)?.decisionGate).toMatchObject({
      state: "decision-gate",
      correlationId: "correlation:gate:b",
    });

    await submit(service, owner, token!, event(workerId, version!, 2, {
      kind: "CHECKPOINT",
      checkpointCorrelationId: "correlation:gate:b",
      summary: "answer B",
    }));
    expect(service.getSubject(workerId)?.decisionGate.state).toBe("none");
  });

  it("keeps duplicate checkpoint correlation IDs isolated by worker", async () => {
    const {
      service,
      owner,
      workerId: firstWorkerId,
      token: firstToken,
      version: firstVersion,
    } = await ownedHarness();
    const second = await register(service, { owner });

    await service.requestCheckpoint({
      mutationId: "duplicate-correlation:first",
      controller: owner,
      leaseToken: firstToken!,
      correlationId: "shared-correlation",
      workerId: firstWorkerId,
      question: "first worker status?",
    });
    await service.requestCheckpoint({
      mutationId: "duplicate-correlation:second",
      controller: owner,
      leaseToken: second.token!,
      correlationId: "shared-correlation",
      workerId: second.workerId,
      question: "second worker status?",
    });
    const firstAnswer = event(firstWorkerId, firstVersion!, 1, {
      kind: "CHECKPOINT",
      checkpointCorrelationId: "shared-correlation",
      summary: "first answer",
    });
    const secondAnswer = event(second.workerId, second.version!, 1, {
      kind: "CHECKPOINT",
      checkpointCorrelationId: "shared-correlation",
      summary: "second answer",
    });
    await expect(submit(service, owner, firstToken!, firstAnswer))
      .resolves.toMatchObject({ code: "accepted" });
    await expect(submit(service, owner, second.token!, secondAnswer))
      .resolves.toMatchObject({ code: "accepted" });

    expect(service.listCheckpoints(firstWorkerId)).toEqual([
      expect.objectContaining({
        workerId: firstWorkerId,
        question: "first worker status?",
        answeredByEventId: firstAnswer.eventId,
      }),
    ]);
    expect(service.listCheckpoints(second.workerId)).toEqual([
      expect.objectContaining({
        workerId: second.workerId,
        question: "second worker status?",
        answeredByEventId: secondAnswer.eventId,
      }),
    ]);
    expect(service.getCheckpoint(firstWorkerId, "shared-correlation")?.answeredByEventId)
      .toBe(firstAnswer.eventId);
    expect(service.getCheckpoint(second.workerId, "shared-correlation")?.answeredByEventId)
      .toBe(secondAnswer.eventId);
  });

  it.each([
    ["focus", { focus: "changed focus" }],
    ["question", { question: "changed question" }],
    ["mode", { mode: "decision-gate" as const }],
  ])("rejects checkpoint identity collision when %s changes", async (_field, change) => {
    const { service, owner, workerId, token } = await ownedHarness();
    await service.requestCheckpoint({
      mutationId: "checkpoint-original",
      controller: owner,
      leaseToken: token!,
      correlationId: "collision-correlation",
      workerId,
      focus: "original focus",
      question: "original question",
      mode: "non-blocking",
    });

    await expect(service.requestCheckpoint({
      mutationId: `checkpoint-changed:${_field}`,
      controller: owner,
      leaseToken: token!,
      correlationId: "collision-correlation",
      workerId,
      focus: "original focus",
      question: "original question",
      mode: "non-blocking",
      ...change,
    })).rejects.toMatchObject({ code: "CHECKPOINT_IDENTITY_COLLISION" });
  });

  it("rejects mutation replay when checkpoint request or worker changes", async () => {
    const { service, owner, workerId, token } = await ownedHarness();
    const second = await register(service, { owner });
    await service.requestCheckpoint({
      mutationId: "checkpoint-mutation-identity",
      controller: owner,
      leaseToken: token!,
      correlationId: "mutation-correlation",
      workerId,
      question: "original question",
    });

    await expect(service.requestCheckpoint({
      mutationId: "checkpoint-mutation-identity",
      controller: owner,
      leaseToken: token!,
      correlationId: "mutation-correlation",
      workerId,
      question: "changed question",
    })).rejects.toMatchObject({ code: "CHECKPOINT_IDENTITY_COLLISION" });
    await expect(service.requestCheckpoint({
      mutationId: "checkpoint-mutation-identity",
      controller: owner,
      leaseToken: second.token!,
      correlationId: "mutation-correlation",
      workerId: second.workerId,
      question: "original question",
    })).rejects.toMatchObject({ code: "CHECKPOINT_IDENTITY_COLLISION" });
  });

  it("rejects checkpoint replay by a different controller", async () => {
    const { service, owner, workerId, token } = await ownedHarness();
    await service.requestCheckpoint({
      mutationId: "controller-collision:original",
      controller: owner,
      leaseToken: token!,
      correlationId: "controller-collision",
      workerId,
    });
    const next = controller("checkpoint-next");
    const transferred = await service.transfer({
      mutationId: "controller-collision:transfer",
      actor: owner,
      selector: { scope: "single", subjectId: workerId },
      controller: owner,
      leaseToken: token!,
      newController: next,
      reason: "checkpoint controller collision test",
    });

    await expect(service.requestCheckpoint({
      mutationId: "controller-collision:changed",
      controller: next,
      leaseToken: transferred.outcomes[0]!.leaseToken!,
      correlationId: "controller-collision",
      workerId,
    })).rejects.toMatchObject({ code: "CHECKPOINT_IDENTITY_COLLISION" });
  });

  it("survives broker restart with leases, events, interventions, checkpoints, and receipts", async () => {
    const first = await ownedHarness();
    const intervention = event(first.workerId, first.version!, 1, {
      kind: "DECISION_REQUEST",
      severity: "warning",
      interventionRequired: true,
      continuation: "awaiting-response",
    });
    await submit(first.service, first.owner, first.token!, intervention);
    const checkpoint = await first.service.requestCheckpoint({
      mutationId: "durable-checkpoint",
      controller: first.owner,
      leaseToken: first.token!,
      correlationId: "durable-correlation",
      workerId: first.workerId,
    });
    expect(checkpoint.requestHash).toMatch(/^[a-f0-9]{64}$/);

    const restarted = await harness({ directory: first.directory });
    expect(restarted.service.getSubject(first.workerId)).toMatchObject({
      lease: { controller: first.owner },
    });
    expect(restarted.service.projectEvents({
      filter: { intervention: "unresolved" },
    }).events.map(({ eventId }) => eventId)).toEqual([intervention.eventId]);
    expect(restarted.service.listCheckpoints(first.workerId)).toHaveLength(1);
    await expect(restarted.service.requestCheckpoint({
      mutationId: "durable-checkpoint",
      controller: first.owner,
      leaseToken: first.token!,
      correlationId: "durable-correlation",
      workerId: first.workerId,
    })).resolves.toEqual(expect.objectContaining({ correlationId: "durable-correlation" }));
    await expect(restarted.service.requestCheckpoint({
      mutationId: "durable-checkpoint-changed",
      controller: first.owner,
      leaseToken: first.token!,
      correlationId: "durable-correlation",
      workerId: first.workerId,
      question: "changed after restart",
    })).rejects.toMatchObject({ code: "CHECKPOINT_IDENTITY_COLLISION" });
  });

  it("replays duplicate correlation IDs for both workers after restart", async () => {
    const first = await ownedHarness();
    const second = await register(first.service, { owner: first.owner });
    for (const [workerId, token, mutationId] of [
      [first.workerId, first.token!, "restart-duplicate:first"],
      [second.workerId, second.token!, "restart-duplicate:second"],
    ] as const) {
      await first.service.requestCheckpoint({
        mutationId,
        controller: first.owner,
        leaseToken: token,
        correlationId: "restart-shared-correlation",
        workerId,
      });
    }

    const restarted = await harness({ directory: first.directory });
    expect(restarted.service.listCheckpoints(first.workerId)).toHaveLength(1);
    expect(restarted.service.listCheckpoints(second.workerId)).toHaveLength(1);
  });

  it("detects changed replay requests from compatible v1 records without request hashes", async () => {
    const first = await ownedHarness();
    await first.service.requestCheckpoint({
      mutationId: "legacy-v1:original",
      controller: first.owner,
      leaseToken: first.token!,
      correlationId: "legacy-v1-correlation",
      workerId: first.workerId,
      focus: "original focus",
    });
    const content = await readFile(first.store.path, "utf8");
    const legacy = content
      .split("\n")
      .map((line) => {
        if (line === "") return line;
        const record = JSON.parse(line) as {
          checkpoints?: Array<Record<string, unknown>>;
          receipts?: Array<{ result?: Record<string, unknown> }>;
        };
        for (const checkpoint of record.checkpoints ?? []) delete checkpoint.requestHash;
        for (const receipt of record.receipts ?? []) delete receipt.result?.requestHash;
        return JSON.stringify(record);
      })
      .join("\n");
    await writeFile(first.store.path, legacy, "utf8");

    const restarted = await harness({ directory: first.directory });
    await expect(restarted.service.requestCheckpoint({
      mutationId: "legacy-v1:changed",
      controller: first.owner,
      leaseToken: first.token!,
      correlationId: "legacy-v1-correlation",
      workerId: first.workerId,
      focus: "changed focus",
    })).rejects.toMatchObject({ code: "CHECKPOINT_IDENTITY_COLLISION" });
  });

  it("rejects stale-controller event submission with explicit authority code", async () => {
    const { service, owner, workerId, token, version } = await ownedHarness();
    const next = controller("event-next");
    await service.transfer({
      mutationId: "stale-event-transfer",
      actor: owner,
      selector: { scope: "single", subjectId: workerId },
      controller: owner,
      leaseToken: token!,
      newController: next,
      reason: "handoff",
    });
    await expect(submit(service, owner, token!, event(workerId, version!, 1))).resolves.toMatchObject({
      code: "rejected",
      errorCode: "OWNERSHIP_LOST",
      message: expect.stringContaining(next.controllerId),
    });
    await expect(service.requestCheckpoint({
      mutationId: "stale-checkpoint",
      controller: owner,
      leaseToken: token!,
      correlationId: "stale-correlation",
      workerId,
    })).rejects.toMatchObject({ code: "OWNERSHIP_LOST" });
  });
});
