import { describe, expect, it, vi } from "vitest";
import type { BrokerEvent } from "../../src/domain/events.js";
import {
  MAX_LIVE_PEERS_PER_CREATOR,
  ORCHESTRATOR_GRANT_CAPABILITIES,
  type OrchestratorBinding,
} from "../../src/domain/orchestrator.js";
import type { SessionRecord } from "../../src/domain/session.js";
import {
  OrchestratorPeerService,
  peerRemoteControlNote,
} from "../../src/orchestration/orchestrator-peer-service.js";
import type { OrchestratorManagerResult } from "../../src/orchestration/orchestrator-manager.js";

const ACTOR = "11111111-1111-4111-8111-111111111111";
const PEER = "22222222-2222-4222-8222-222222222222";
const OTHER_PEER = "33333333-3333-4333-8333-333333333333";
const now = "2026-10-07T12:00:00.000Z";

const actorRecord: SessionRecord = {
  id: ACTOR,
  provider: "claude",
  model: "fable",
  cwd: "/repo/one",
  detached: true,
  sandbox: "read-only",
  role: "orchestrator",
  kind: "orchestrator",
  orchestratorScope: "fleet",
  createdAt: now,
  updatedAt: now,
  executionState: "active",
  attachmentState: "detached",
  pid: 11,
  exitCode: null,
  childIds: [],
};

const fleetBinding: OrchestratorBinding = {
  key: "fleet",
  kind: "primary",
  sessionId: ACTOR,
  provider: "claude",
  model: "fable",
  cwd: "/repo/one",
  sandbox: "read-only",
  scope: { kind: "fleet" },
  grant: {
    subjectSessionId: ACTOR,
    capabilities: [...ORCHESTRATOR_GRANT_CAPABILITIES],
    scope: { kind: "fleet" },
  },
  createdAt: now,
  updatedAt: now,
};

function peerBinding(sessionId: string, createdBy = ACTOR): OrchestratorBinding {
  return {
    ...fleetBinding,
    key: `fleet:peer:${sessionId}`,
    kind: "peer",
    sessionId,
    grant: { ...fleetBinding.grant, subjectSessionId: sessionId },
    createdBy: { sessionId: createdBy },
  };
}

function harness(overrides: {
  actor?: SessionRecord;
  binding?: OrchestratorBinding;
  bindings?: OrchestratorBinding[];
  records?: SessionRecord[];
  createPeer?: OrchestratorManagerResult | Error;
  instructions?: boolean;
  briefStatus?: string;
  failAudit?: (event: BrokerEvent) => boolean;
  maxLivePeers?: number;
} = {}) {
  const binding = overrides.binding ?? fleetBinding;
  const records = new Map<string, SessionRecord>([
    [ACTOR, overrides.actor ?? actorRecord],
    ...(overrides.records ?? []).map((record) => [record.id, record] as const),
  ]);
  const stored = [binding, ...(overrides.bindings ?? [])];
  const events: BrokerEvent[] = [];
  let launched = 0;
  const createPeer = vi.fn(async (request: { cwd: string; model: string; provider: string; capabilities: string[]; }) => {
    if (overrides.createPeer instanceof Error) throw overrides.createPeer;
    if (overrides.createPeer !== undefined) return overrides.createPeer;
    // The real manager writes the binding during launch, before `start` resolves; a second create
    // that queued behind this one must see it, which is what the cap test relies on.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const id = launched++ === 0 ? PEER : `${launched}${PEER.slice(1)}`;
    const session = { ...actorRecord, id, cwd: request.cwd, name: "peer" };
    records.set(id, session);
    const created: OrchestratorManagerResult = {
      session,
      created: true,
      binding: {
        ...peerBinding(id),
        provider: request.provider as OrchestratorBinding["provider"],
        cwd: request.cwd,
        grant: {
          subjectSessionId: id,
          capabilities: ORCHESTRATOR_GRANT_CAPABILITIES.filter((entry) => entry !== "orchestrator.create"),
          scope: { kind: "fleet" },
        },
      },
    };
    stored.push(created.binding);
    return created;
  });
  const enqueue = vi.fn(async (input: { targetSessionId: string; message: string; }) => ({
    id: "44444444-4444-4444-8444-444444444444",
    targetSessionId: input.targetSessionId,
    message: input.message,
    status: overrides.briefStatus ?? "accepted",
  }));
  const service = new OrchestratorPeerService({
    registry: {
      get: (sessionId: string) => {
        const record = records.get(sessionId);
        if (record === undefined) throw Object.assign(new Error("missing"), { code: "SESSION_NOT_FOUND" });
        return record;
      },
    },
    bindings: {
      findBySessionId: async (sessionId: string) => stored.find((entry) => entry.sessionId === sessionId),
      list: async () => stored,
    },
    manager: { createPeer: createPeer as never },
    ...(overrides.instructions === false ? {} : { instructions: { enqueue: enqueue as never } }),
    audit: {
      append: async (event) => {
        if (overrides.failAudit?.(event)) throw new Error("journal disk full");
        events.push(event);
      },
    },
    now: () => Date.parse(now),
    ...(overrides.maxLivePeers === undefined ? {} : { maxLivePeers: overrides.maxLivePeers }),
  });
  return { service, createPeer, enqueue, events, stored };
}

const request = {
  actorSessionId: ACTOR,
  provider: "codex" as const,
  model: "gpt-6.1-sol",
  effort: "high" as const,
  cwd: "/repo/two",
  reason: "continue from the phone on a fresh provider",
};

describe("OrchestratorPeerService", () => {
  it("creates a peer with the creator's grant minus orchestrator.create, delivers the brief, and audits both halves", async () => {
    const { service, createPeer, enqueue, events } = harness();

    const result = await service.create({ ...request, name: "codex successor", brief: "Pick up PR #61" });

    expect(result).toMatchObject({
      outcome: "CREATED",
      sessionId: PEER,
      bindingKey: `fleet:peer:${PEER}`,
      provider: "codex",
      model: "gpt-6.1-sol",
      scope: { kind: "fleet" },
      createdBy: ACTOR,
      brief: { delivery: "queued", instructionId: "44444444-4444-4444-8444-444444444444" },
      remoteControl: peerRemoteControlNote("codex"),
      warnings: [],
    });
    expect((result as { grant: string[] }).grant).not.toContain("orchestrator.create");
    expect(createPeer).toHaveBeenCalledWith(expect.objectContaining({
      provider: "codex",
      model: "gpt-6.1-sol",
      effort: "high",
      cwd: "/repo/two",
      scope: "fleet",
      name: "codex successor",
      createdBy: { sessionId: ACTOR },
    }));
    expect(events[0]!.data).not.toHaveProperty("brief");
    expect(JSON.stringify(events)).not.toContain("Pick up PR #61");
    const granted = (createPeer.mock.calls[0]![0] as { capabilities: string[] }).capabilities;
    expect(granted).toEqual(ORCHESTRATOR_GRANT_CAPABILITIES.filter((entry) => entry !== "orchestrator.create"));
    expect(enqueue).toHaveBeenCalledWith({ actorSessionId: ACTOR, targetSessionId: PEER, message: "Pick up PR #61" });
    expect(events.map(({ type }) => type)).toEqual([
      "orchestrator.create.requested",
      "orchestrator.create.result",
    ]);
    expect(events[0]).toMatchObject({ sessionId: ACTOR, data: { reason: request.reason, briefRequested: true } });
    expect(events[1]).toMatchObject({ sessionId: PEER, data: { outcome: "CREATED", brief: "queued" } });
  });

  it("refuses a caller whose grant lacks orchestrator.create and names the operator toggle", async () => {
    const { service, createPeer, events } = harness({
      binding: {
        ...fleetBinding,
        grant: {
          ...fleetBinding.grant,
          capabilities: ORCHESTRATOR_GRANT_CAPABILITIES.filter((entry) => entry !== "orchestrator.create"),
        },
      },
    });

    await expect(service.create(request)).resolves.toMatchObject({
      outcome: "DENIED",
      code: "CAPABILITY_DENIED",
      reason: expect.stringContaining("peer-create on"),
    });
    expect(createPeer).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("refuses an inactive or unbound caller", async () => {
    const stopped = harness({ actor: { ...actorRecord, executionState: "cancelled", exitCode: 0 } });
    await expect(stopped.service.create(request)).resolves.toMatchObject({
      outcome: "DENIED",
      code: "ACTOR_NOT_ACTIVE",
    });

    const unbound = harness({ binding: peerBinding(OTHER_PEER, OTHER_PEER) });
    await expect(unbound.service.create(request)).resolves.toMatchObject({
      outcome: "DENIED",
      code: "ACTOR_NOT_AUTHORIZED",
    });
  });

  it("lets a workspace creator make a peer only in its own workspace, never fleet-wide", async () => {
    const workspace: OrchestratorBinding = {
      ...fleetBinding,
      key: "workspace:/repo/one",
      scope: { kind: "workspace", cwd: "/repo/one" },
      grant: { ...fleetBinding.grant, scope: { kind: "workspace", cwd: "/repo/one" } },
    };
    const { service, createPeer } = harness({ binding: workspace });

    await expect(service.create({ ...request, cwd: "/repo/two", scope: "workspace" })).resolves.toMatchObject({
      outcome: "DENIED",
      code: "CAPABILITY_DENIED",
    });
    await expect(service.create({ ...request, cwd: "/repo/one", scope: "fleet" })).resolves.toMatchObject({
      outcome: "DENIED",
      code: "SCOPE_WIDENS",
    });
    await expect(service.create({ ...request, cwd: "/repo/one", scope: "workspace" })).resolves.toMatchObject({
      outcome: "CREATED",
    });
    expect(createPeer).toHaveBeenCalledOnce();
  });

  it("caps live peers per creator and names the ones still running", async () => {
    const live = { ...actorRecord, id: OTHER_PEER };
    const ended = { ...actorRecord, id: PEER, executionState: "exited" as const, exitCode: 0 };
    const { service, createPeer } = harness({
      bindings: [peerBinding(OTHER_PEER), peerBinding(PEER)],
      records: [live, ended],
      maxLivePeers: 1,
    });

    await expect(service.create(request)).resolves.toEqual({
      outcome: "PEER_LIMIT",
      reason: expect.stringContaining("1 live peer"),
      livePeerIds: [OTHER_PEER],
      limit: 1,
    });
    expect(createPeer).not.toHaveBeenCalled();
    expect(MAX_LIVE_PEERS_PER_CREATOR).toBe(2);
  });

  it("does not count an errored peer whose dead process still has no exit code", async () => {
    const errored = { ...actorRecord, id: OTHER_PEER, executionState: "errored" as const, exitCode: null };
    const { service } = harness({
      bindings: [peerBinding(OTHER_PEER)],
      records: [errored],
      maxLivePeers: 1,
    });

    await expect(service.create(request)).resolves.toMatchObject({ outcome: "CREATED" });
  });

  it("does not count peers another orchestrator created", async () => {
    const live = { ...actorRecord, id: OTHER_PEER };
    const { service } = harness({
      bindings: [peerBinding(OTHER_PEER, OTHER_PEER)],
      records: [live],
      maxLivePeers: 1,
    });

    await expect(service.create(request)).resolves.toMatchObject({ outcome: "CREATED" });
  });

  it("reports an unsupported selection as an outcome and audits the failure", async () => {
    const { service, events } = harness({
      createPeer: Object.assign(new Error("Unsupported orchestrator selection: codex:nope"), {
        code: "ORCHESTRATOR_SELECTION_UNSUPPORTED",
      }),
    });

    await expect(service.create({ ...request, model: "nope" })).resolves.toEqual({
      outcome: "SELECTION_UNSUPPORTED",
      code: "ORCHESTRATOR_SELECTION_UNSUPPORTED",
      reason: "Unsupported orchestrator selection: codex:nope",
    });
    expect(events.map(({ type }) => type)).toEqual([
      "orchestrator.create.requested",
      "orchestrator.create.result",
    ]);
    expect(events[1]).toMatchObject({ data: { outcome: "SELECTION_UNSUPPORTED" } });
  });

  it("reports any other launch error as LAUNCH_FAILED", async () => {
    const { service } = harness({ createPeer: new Error("pty spawn failed") });

    await expect(service.create(request)).resolves.toEqual({
      outcome: "LAUNCH_FAILED",
      reason: "pty spawn failed",
    });
  });

  it("keeps the peer when the brief cannot be queued and says how to send it", async () => {
    const { service } = harness({ instructions: false });

    await expect(service.create({ ...request, brief: "hello" })).resolves.toMatchObject({
      outcome: "CREATED",
      brief: { delivery: "failed", detail: expect.stringContaining("cyberdeck_thread_message") },
    });
  });

  it("serializes concurrent creates from one actor so the cap cannot be raced", async () => {
    const { service, createPeer } = harness({ maxLivePeers: 1 });

    const [first, second] = await Promise.all([
      service.create({ ...request, mutationId: "a" }),
      service.create({ ...request, mutationId: "b" }),
    ]);

    expect(first).toMatchObject({ outcome: "CREATED", sessionId: PEER });
    expect(second).toMatchObject({ outcome: "PEER_LIMIT", livePeerIds: [PEER] });
    expect(createPeer).toHaveBeenCalledOnce();
  });

  it("makes an in-flight retry with the same mutationId wait for, then replay, the first result", async () => {
    const { service, createPeer } = harness();

    const [first, retry] = await Promise.all([
      service.create({ ...request, mutationId: "m-2" }),
      service.create({ ...request, mutationId: "m-2" }),
    ]);

    expect(first).toMatchObject({ outcome: "CREATED" });
    expect(retry).toEqual({ ...first, retrieval: "replay" });
    expect(createPeer).toHaveBeenCalledOnce();
  });

  it("persists the mutationId on the binding and replays from the log after the broker forgot", async () => {
    const first = harness();
    const created = await first.service.create({ ...request, mutationId: "durable", brief: "hello" });
    expect(created).toMatchObject({ outcome: "CREATED" });
    expect(first.createPeer).toHaveBeenCalledWith(expect.objectContaining({
      createdBy: { sessionId: ACTOR, mutationId: "durable" },
    }));

    // A fresh service with an empty replay map, reading the same binding log.
    const restarted = harness({ bindings: first.stored.filter((entry) => entry.sessionId !== ACTOR) });
    const peer = first.stored.find((entry) => entry.sessionId === PEER)!;
    peer.createdBy = { sessionId: ACTOR, mutationId: "durable" };
    await expect(restarted.service.create({ ...request, mutationId: "durable", brief: "hello" })).resolves.toMatchObject({
      outcome: "CREATED",
      sessionId: PEER,
      bindingKey: `fleet:peer:${PEER}`,
      brief: { delivery: "replayed" },
      retrieval: "replay",
    });
    expect(restarted.createPeer).not.toHaveBeenCalled();
    expect(restarted.enqueue).not.toHaveBeenCalled();
  });

  it("records the replay before journaling, so a failed result audit cannot launch a second peer", async () => {
    const { service, createPeer } = harness({
      failAudit: (event) => event.type === "orchestrator.create.result",
    });

    const first = await service.create({ ...request, mutationId: "m-3" });
    expect(first).toMatchObject({
      outcome: "CREATED",
      warnings: [expect.stringContaining("could not be journaled")],
    });
    await expect(service.create({ ...request, mutationId: "m-3" })).resolves.toMatchObject({
      outcome: "CREATED",
      retrieval: "replay",
    });
    expect(createPeer).toHaveBeenCalledOnce();
  });

  it("reports a brief the peer went terminal before consuming as failed, not queued", async () => {
    const { service } = harness({ briefStatus: "undelivered" });

    await expect(service.create({ ...request, brief: "hello" })).resolves.toMatchObject({
      outcome: "CREATED",
      brief: { delivery: "failed", detail: expect.stringContaining("undelivered") },
    });
  });

  it("tells the caller which providers reach the phone", () => {
    expect(peerRemoteControlNote("claude")).toContain("Remote Control");
    expect(peerRemoteControlNote("codex")).toContain("Codex app");
    expect(peerRemoteControlNote("cursor")).toContain("no phone-reachable surface");
  });

  it("replays a recorded result for the same mutationId instead of starting a second peer", async () => {
    const { service, createPeer } = harness();

    const first = await service.create({ ...request, mutationId: "m-1" });
    const second = await service.create({ ...request, mutationId: "m-1" });

    expect(first).toMatchObject({ outcome: "CREATED" });
    expect(second).toEqual({ ...first, retrieval: "replay" });
    expect(createPeer).toHaveBeenCalledOnce();
  });
});
