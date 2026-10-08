import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { BrokerEvent } from "../../src/domain/events.js";
import {
  ORCHESTRATOR_GRANT_CAPABILITIES,
  orchestratorKey,
  type CreatePeerOrchestratorRequest,
  type PeerApproval,
  type OrchestratorBinding,
} from "../../src/domain/orchestrator.js";
import type { SessionRecord } from "../../src/domain/session.js";
import {
  AgentCreateOrchestratorParamsSchema,
  OrchestratorPeerService,
  peerRemoteControlNote,
} from "../../src/orchestration/orchestrator-peer-service.js";
import { OrchestratorManager, type OrchestratorManagerResult } from "../../src/orchestration/orchestrator-manager.js";
import { OrchestratorStore } from "../../src/persistence/orchestrator-store.js";

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
} = {}) {
  const binding = overrides.binding ?? fleetBinding;
  const records = new Map<string, SessionRecord>([
    [ACTOR, overrides.actor ?? actorRecord],
    ...(overrides.records ?? []).map((record) => [record.id, record] as const),
  ]);
  const stored = [binding, ...(overrides.bindings ?? [])];
  const events: BrokerEvent[] = [];
  let launched = 0;
  let launchesInFlight = 0;
  let maxConcurrentLaunches = 0;
  const createPeer = vi.fn(async (request: CreatePeerOrchestratorRequest) => {
    if (overrides.createPeer instanceof Error) throw overrides.createPeer;
    if (overrides.createPeer !== undefined) return overrides.createPeer;
    // The real manager writes the binding before launch resolves, which durable retries observe.
    maxConcurrentLaunches = Math.max(maxConcurrentLaunches, ++launchesInFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const id = launched++ === 0 ? PEER : `${launched + 1}${PEER.slice(1)}`;
    const session = { ...actorRecord, id, cwd: request.cwd, name: "peer" };
    records.set(id, session);
    const created: OrchestratorManagerResult = {
      session,
      created: true,
      binding: {
        ...peerBinding(id),
        provider: request.provider as OrchestratorBinding["provider"],
        cwd: request.cwd,
        createdBy: request.createdBy,
        scope: request.scope === "fleet" ? { kind: "fleet" } : { kind: "workspace", cwd: request.cwd },
        grant: {
          subjectSessionId: id,
          capabilities: [...request.capabilities],
          scope: request.scope === "fleet" ? { kind: "fleet" } : { kind: "workspace", cwd: request.cwd },
        },
      },
    };
    stored.push(created.binding);
    launchesInFlight--;
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
      get: async (key: string) => stored.find((entry) => entry.key === key),
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
  });
  return { service, createPeer, enqueue, events, stored, get maxConcurrentLaunches() { return maxConcurrentLaunches; } };
}

const approval: PeerApproval = {
  kind: "per-create",
  quote: "  yes, create it  ",
  channel: "remote-control",
  grantedAt: now,
};

const request = {
  actorSessionId: ACTOR,
  provider: "codex" as const,
  model: "gpt-6.1-sol",
  effort: "high" as const,
  cwd: "/repo/two",
  reason: "continue from the phone on a fresh provider",
  approval,
};

describe("OrchestratorPeerService", () => {
  it("creates a peer with per-create approval and the full grant, persists lineage, delivers the brief, and audits both halves", async () => {
    const { service, createPeer, enqueue, events, stored } = harness();

    const result = await service.create({ ...request, name: "codex successor", brief: "Pick up PR #61" });

    expect(result).toMatchObject({
      outcome: "CREATED",
      sessionId: PEER,
      bindingKey: `fleet:peer:${PEER}`,
      provider: "codex",
      model: "gpt-6.1-sol",
      scope: { kind: "fleet" },
      createdBy: { sessionId: ACTOR, approval, depth: 1 },
      brief: { delivery: "queued", instructionId: "44444444-4444-4444-8444-444444444444" },
      remoteControl: peerRemoteControlNote("codex"),
      warnings: [],
    });
    expect((result as { grant: string[] }).grant).toEqual(ORCHESTRATOR_GRANT_CAPABILITIES);
    expect(stored.find(({ sessionId }) => sessionId === PEER)?.createdBy)
      .toEqual({ sessionId: ACTOR, approval, depth: 1 });
    expect(createPeer).toHaveBeenCalledWith(expect.objectContaining({
      provider: "codex",
      model: "gpt-6.1-sol",
      effort: "high",
      cwd: "/repo/two",
      scope: "fleet",
      name: "codex successor",
      createdBy: { sessionId: ACTOR, approval, depth: 1 },
    }));
    expect(events[0]!.data).not.toHaveProperty("brief");
    expect(JSON.stringify(events)).not.toContain("Pick up PR #61");
    const granted = (createPeer.mock.calls[0]![0] as { capabilities: string[] }).capabilities;
    expect(granted).toEqual(ORCHESTRATOR_GRANT_CAPABILITIES);
    expect(enqueue).toHaveBeenCalledWith({ actorSessionId: ACTOR, targetSessionId: PEER, message: "Pick up PR #61" });
    expect(events.map(({ type }) => type)).toEqual([
      "orchestrator.create.requested",
      "orchestrator.create.result",
    ]);
    expect(events[0]).toMatchObject({ sessionId: ACTOR, data: { reason: request.reason, approval, depth: 1, briefRequested: true } });
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

  it.each(["fleet", "workspace"] as const)("enforces the durable %s scope kill-switch for primary, peer and descendant across service reloads", async (scope) => {
    const directory = await mkdtemp(join(tmpdir(), "cyberdeck-peer-create-switch-"));
    const store = new OrchestratorStore(directory);
    const records = new Map<string, SessionRecord>();
    let sequence = 0;
    const registry = {
      get: (sessionId: string) => records.get(sessionId)!,
      start: vi.fn(async (
        input: Partial<SessionRecord>,
        _initialPrompt?: string,
        activate?: (record: SessionRecord) => Promise<void>,
      ) => {
        const session = {
          ...actorRecord, ...input,
          id: `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
        };
        records.set(session.id, session);
        await activate?.(session);
        return session;
      }),
    };
    const manager = new OrchestratorManager(registry as never, store);
    const service = new OrchestratorPeerService({ registry, bindings: store, manager });
    const standing: PeerApproval = {
      kind: "standing", quote: "create orchestrators as you need for this task", channel: "terminal",
    };
    try {
      const primary = await manager.ensure({ provider: "claude", model: "fable", cwd: "/repo/one", scope });
      const create = (actorSessionId: string, mutationId: string) => ({
        ...request, provider: "claude" as const, model: "fable", effort: undefined,
        cwd: "/repo/one", scope, actorSessionId, mutationId, approval: standing,
      });
      const peer = await service.create(create(primary.session.id, "peer"));
      if (peer.outcome !== "CREATED") throw new Error(`Peer creation failed: ${peer.outcome}`);
      const descendant = await service.create(create(peer.sessionId, "descendant"));
      if (descendant.outcome !== "CREATED") throw new Error(`Descendant creation failed: ${descendant.outcome}`);
      expect(descendant.createdBy.depth).toBe(2);
      const peerGrant = (await store.findBySessionId(peer.sessionId))!.grant;
      const descendantGrant = (await store.findBySessionId(descendant.sessionId))!.grant;

      await expect(manager.peerCreate({ scope, cwd: "/repo/one", enabled: false }))
        .resolves.toMatchObject({ enabled: false });
      const startsBeforeOff = registry.start.mock.calls.length;
      await expect(service.create(create(primary.session.id, "primary-off")))
        .resolves.toMatchObject({ outcome: "DENIED", code: "CAPABILITY_DENIED" });
      const scopeDenied = {
        outcome: "DENIED", code: "SCOPE_PEER_CREATE_OFF",
        reason: expect.stringContaining("cyberdeck orchestrator peer-create off"),
      };
      for (const sessionId of [peer.sessionId, descendant.sessionId]) {
        await expect(service.create(create(sessionId, "off"))).resolves.toMatchObject(scopeDenied);
      }
      const reloadedStore = new OrchestratorStore(directory);
      const freshService = new OrchestratorPeerService({ registry, bindings: reloadedStore, manager });
      for (const sessionId of [peer.sessionId, descendant.sessionId]) {
        await expect(freshService.create(create(sessionId, "reloaded-off"))).resolves.toMatchObject(scopeDenied);
      }
      // Replaying an existing peer while OFF does not admit or launch a fresh create.
      await expect(freshService.create(create(primary.session.id, "peer")))
        .resolves.toMatchObject({ outcome: "CREATED", sessionId: peer.sessionId, retrieval: "replay" });
      expect(registry.start).toHaveBeenCalledTimes(startsBeforeOff);
      expect((await reloadedStore.findBySessionId(peer.sessionId))!.grant).toEqual(peerGrant);
      expect((await reloadedStore.findBySessionId(descendant.sessionId))!.grant).toEqual(descendantGrant);

      await manager.peerCreate({ scope, cwd: "/repo/one", enabled: true });
      for (const actorSessionId of [primary.session.id, peer.sessionId, descendant.sessionId]) {
        await expect(service.create(create(actorSessionId, "on"))).resolves.toMatchObject({ outcome: "CREATED" });
        await expect(freshService.create(create(actorSessionId, "reloaded-on"))).resolves.toMatchObject({ outcome: "CREATED" });
      }

      const legacy = (await store.findBySessionId(peer.sessionId))!;
      await store.put({
        ...legacy,
        createdBy: { sessionId: primary.session.id },
        grant: { ...legacy.grant, capabilities: legacy.grant.capabilities.filter((entry) => entry !== "orchestrator.create") },
      });
      await manager.peerCreate({ scope, cwd: "/repo/one", enabled: false });
      await manager.peerCreate({ scope, cwd: "/repo/one", enabled: true });
      await expect(freshService.create(create(peer.sessionId, "legacy-on")))
        .resolves.toMatchObject({ outcome: "DENIED", code: "CAPABILITY_DENIED" });
      expect((await reloadedStore.findBySessionId(peer.sessionId))!.grant.capabilities).not.toContain("orchestrator.create");
      expect((await reloadedStore.get(orchestratorKey(primary.binding.scope)))!.grant.capabilities).toContain("orchestrator.create");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("accepts an RFC 3339 offset through the create-request schema and preserves it through admission", async () => {
    const { service, createPeer, events, stored } = harness();
    const offsetApproval = { ...approval, grantedAt: "2026-10-08T15:00:00+03:00" };
    const parsed = AgentCreateOrchestratorParamsSchema.parse({ ...request, approval: offsetApproval });
    expect(parsed.approval).toEqual(offsetApproval);
    await expect(service.create(parsed)).resolves.toMatchObject({
      outcome: "CREATED", createdBy: { approval: offsetApproval },
    });
    expect(createPeer).toHaveBeenCalledWith(expect.objectContaining({ createdBy: expect.objectContaining({ approval: offsetApproval }) }));
    expect(events[0]?.data.approval).toEqual(offsetApproval);
    expect(stored.at(-1)?.createdBy?.approval).toEqual(offsetApproval);
  });

  it("refuses an inactive or unbound caller", async () => {
    const stopped = harness({ actor: { ...actorRecord, executionState: "cancelled", exitCode: 0 } });
    await expect(stopped.service.create({ ...request, approval: undefined })).resolves.toMatchObject({
      outcome: "DENIED",
      code: "ACTOR_NOT_ACTIVE",
    });

    const unbound = harness({ binding: peerBinding(OTHER_PEER, OTHER_PEER) });
    await expect(unbound.service.create({ ...request, approval: undefined })).resolves.toMatchObject({
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

  it.each([undefined, "", " \t\n "])("refuses absent or blank approval (%j), launches nothing, and audits the refusal", async (quote) => {
    const { service, createPeer, events } = harness();
    const result = await service.create({ ...request, approval: quote === undefined ? undefined : { ...approval, quote } });

    expect(result).toEqual({
      outcome: "APPROVAL_REQUIRED",
      reason: "ask the operator in your current conversation and pass their express approval verbatim as approval.quote",
    });
    expect(createPeer).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "orchestrator.create.result",
      sessionId: ACTOR,
      data: { outcome: "APPROVAL_REQUIRED", detail: result.outcome === "APPROVAL_REQUIRED" ? result.reason : "" },
    });
  });

  it("asks for approval before checking the creation capability", async () => {
    const { service, createPeer } = harness({
      binding: { ...fleetBinding, grant: { ...fleetBinding.grant, capabilities: [] } },
    });
    await expect(service.create({ ...request, approval: undefined })).resolves.toMatchObject({ outcome: "APPROVAL_REQUIRED" });
    expect(createPeer).not.toHaveBeenCalled();
  });

  it("accepts and journals standing approval on every covered create", async () => {
    const { service, events, stored } = harness();
    const standing: PeerApproval = { kind: "standing", quote: "create orchestrators as you need for this task", channel: "terminal" };
    for (const mutationId of ["standing-1", "standing-2"]) {
      await expect(service.create({ ...request, approval: standing, mutationId })).resolves.toMatchObject({
        outcome: "CREATED", createdBy: { sessionId: ACTOR, depth: 1, approval: standing },
      });
    }
    expect(events.filter(({ type }) => type === "orchestrator.create.requested").map(({ data }) => data.approval))
      .toEqual([standing, standing]);
    expect(stored.filter(({ kind }) => kind === "peer").map(({ createdBy }) => createdBy?.approval))
      .toEqual([standing, standing]);
  });

  it("creates three live peers from one creator without a ceiling", async () => {
    const { service, createPeer, stored } = harness();
    const results = await Promise.all(["one", "two", "three"].map((mutationId) => service.create({ ...request, mutationId })));
    expect(results.map(({ outcome }) => outcome)).toEqual(["CREATED", "CREATED", "CREATED"]);
    expect(new Set(stored.filter(({ kind }) => kind === "peer").map(({ sessionId }) => sessionId)).size).toBe(3);
    expect(createPeer).toHaveBeenCalledTimes(3);
  });

  it("lets a peer with its creator's full grant create a third orchestrator at depth two with its own approval", async () => {
    const { service, events, stored } = harness();
    await service.create(request);
    const peer = stored.find(({ sessionId }) => sessionId === PEER)!;
    expect(peer.grant.capabilities).toEqual(fleetBinding.grant.capabilities);
    expect(peer.grant.capabilities).toContain("orchestrator.create");
    await expect(service.create({ ...request, actorSessionId: PEER, approval: undefined }))
      .resolves.toMatchObject({ outcome: "APPROVAL_REQUIRED" });
    const peerApproval: PeerApproval = { kind: "per-create", quote: "yes, create another orchestrator", channel: "fleet" };
    const result = await service.create({ ...request, actorSessionId: PEER, approval: peerApproval });
    expect(result).toMatchObject({ outcome: "CREATED", createdBy: { sessionId: PEER, approval: peerApproval, depth: 2 } });
    expect(stored.at(-1)?.createdBy).toEqual({ sessionId: PEER, approval: peerApproval, depth: 2 });
    expect(stored.at(-1)?.grant.capabilities).toEqual(fleetBinding.grant.capabilities);
    expect(events.filter(({ type }) => type === "orchestrator.create.requested").at(-1))
      .toMatchObject({ sessionId: PEER, data: { approval: peerApproval, depth: 2 } });
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

  it("serializes concurrent creates from one actor so each launch records before the next can replay", async () => {
    const state = harness();
    const { service, createPeer } = state;

    const [first, second] = await Promise.all([
      service.create({ ...request, mutationId: "a" }),
      service.create({ ...request, mutationId: "b" }),
    ]);

    expect(first).toMatchObject({ outcome: "CREATED", sessionId: PEER });
    expect(second).toMatchObject({ outcome: "CREATED", sessionId: `3${PEER.slice(1)}` });
    expect(createPeer).toHaveBeenCalledTimes(2);
    expect(state.maxConcurrentLaunches).toBe(1);
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
      createdBy: { sessionId: ACTOR, mutationId: "durable", approval, depth: 1 },
    }));

    // A fresh service with an empty replay map, reading the same binding log.
    const restarted = harness({ bindings: first.stored.filter((entry) => entry.sessionId !== ACTOR) });
    await expect(restarted.service.create({ ...request, approval: { ...approval, quote: "a later quote" }, mutationId: "durable", brief: "hello" })).resolves.toMatchObject({
      outcome: "CREATED",
      sessionId: PEER,
      bindingKey: `fleet:peer:${PEER}`,
      brief: { delivery: "replayed" },
      retrieval: "replay",
      createdBy: { sessionId: ACTOR, approval, depth: 1 },
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
