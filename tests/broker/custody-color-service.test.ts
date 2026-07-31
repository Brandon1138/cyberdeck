import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CustodyColorService } from "../../src/broker/custody-color-service.js";
import {
  fleetOrchestratorCustodyColors,
  fleetWorkerCoordinationView,
} from "../../src/broker/worker-coordination-view.js";
import { CUSTODY_COLOR_SLOT_COUNT, CustodyColorTableSchema } from "../../src/domain/custody-color.js";
import type { OrchestratorBinding } from "../../src/domain/orchestrator.js";
import type { LeaseState, OwnershipSubject } from "../../src/domain/worker-coordination.js";
import { OwnershipSubjectSchema } from "../../src/domain/worker-coordination.js";
import { CustodyColorStore } from "../../src/persistence/custody-color-store.js";

const directories: string[] = [];
const baseMs = Date.parse("2026-07-28T09:00:00.000Z");

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function at(offsetMs: number): string {
  return new Date(baseMs + offsetMs).toISOString();
}

function worker(input: {
  sessionId?: string;
  controllerId?: string;
  state?: LeaseState;
  endedAt?: string;
}): OwnershipSubject {
  const state = input.state ?? "active";
  return OwnershipSubjectSchema.parse({
    schemaVersion: 1,
    subjectId: randomUUID(),
    subjectKind: "worker",
    origin: {
      creatorControllerId: input.controllerId ?? "orchestrator:fleet",
      taskId: "task-1",
      threadId: "thread-1",
      createdAt: at(0),
    },
    lifecycle: state === "active" ? "working" : "done",
    resources: { sessionId: input.sessionId ?? randomUUID(), eventStreamId: "stream-1" },
    lease: {
      leaseId: randomUUID(),
      version: 1,
      state,
      ...(input.controllerId === undefined ? {} : {
        controller: {
          controllerId: input.controllerId,
          familyId: input.controllerId,
          scope: { kind: "fleet", scopeId: "fleet" },
        },
      }),
      issuedAt: at(0),
      renewedAt: at(0),
      expiresAt: at(60_000),
      ...(state === "released" ? { releasedAt: input.endedAt ?? at(1_000) } : {}),
    },
    updatedAt: at(0),
  });
}

async function service(subjects: OwnershipSubject[] = []): Promise<CustodyColorService> {
  const directory = await mkdtemp(join(tmpdir(), "cyberdeck-custody-service-"));
  directories.push(directory);
  let nowMs = baseMs;
  return new CustodyColorService({
    store: new CustodyColorStore(directory),
    subjects: { listSubjects: () => subjects },
    now: () => new Date((nowMs += 1_000)).toISOString(),
  });
}

describe("CustodyColorService", () => {
  it("assigns a slot per controller and reports it back", async () => {
    const colors = await service();

    await expect(colors.assign("orchestrator:fleet")).resolves.toBe(0);
    await expect(colors.assign("orchestrator:workspace:/repo")).resolves.toBe(1);
    await expect(colors.slotFor("orchestrator:workspace:/repo")).resolves.toBe(1);
    await expect(colors.slotFor("orchestrator:unknown")).resolves.toBeUndefined();
  });

  it("gives concurrent spawns distinct slots", async () => {
    const colors = await service();

    const slots = await Promise.all(
      Array.from({ length: CUSTODY_COLOR_SLOT_COUNT }, (_, index) =>
        colors.assign(`orchestrator:workspace:/repo/${index}`)),
    );

    expect(new Set(slots).size).toBe(CUSTODY_COLOR_SLOT_COUNT);
  });

  it("survives a restart by replaying the ledger", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cyberdeck-custody-service-"));
    directories.push(directory);
    const first = new CustodyColorService({ store: new CustodyColorStore(directory) });
    await first.assign("orchestrator:fleet");
    await first.assign("orchestrator:workspace:/repo");

    const restarted = new CustodyColorService({ store: new CustodyColorStore(directory) });

    await expect(restarted.slotFor("orchestrator:fleet")).resolves.toBe(0);
    await expect(restarted.assign("orchestrator:fleet")).resolves.toBe(0);
  });

  it("releases without freeing, and does not rewrite the ledger for an unheld slot", async () => {
    const colors = await service();
    await colors.assign("orchestrator:fleet");

    await colors.release("orchestrator:fleet");
    const released = await colors.table();
    await colors.release("orchestrator:fleet");
    await colors.release("orchestrator:absent");

    expect(released[0]?.releasedAt).toBeDefined();
    expect(await colors.table()).toBe(released);
  });

  it("keeps a slot away from a newcomer while workers still fade on it", async () => {
    const fading = worker({ controllerId: "orchestrator:fleet", state: "released" });
    const colors = await service([fading]);
    await colors.assign("orchestrator:fleet");
    await colors.release("orchestrator:fleet");

    await expect(colors.assign("orchestrator:workspace:/repo")).resolves.toBe(1);
  });
});

describe("CustodyColorService reconciliation", () => {
  async function primed(table: Parameters<typeof CustodyColorTableSchema.parse>[0]) {
    const directory = await mkdtemp(join(tmpdir(), "cyberdeck-custody-service-"));
    directories.push(directory);
    const store = new CustodyColorStore(directory);
    await store.write(CustodyColorTableSchema.parse(table));
    return store;
  }

  it("reclaims a slot on load when its holder has no live binding", async () => {
    const store = await primed([{ slot: 0, controllerId: "orchestrator:dead", assignedAt: at(0) }]);

    const colors = new CustodyColorService({
      store,
      orchestratorBindings: { list: async () => [] },
      now: () => at(1_000),
    });

    const table = await colors.table();
    expect(table[0]).toMatchObject({ slot: 0, releasedAt: at(1_000) });
  });

  it("never reclaims a slot from a controller with a live binding", async () => {
    const store = await primed([{ slot: 0, controllerId: "orchestrator:fleet", assignedAt: at(0) }]);

    const colors = new CustodyColorService({
      store,
      orchestratorBindings: { list: async () => [{ key: "fleet" }] },
      now: () => at(1_000),
    });

    const table = await colors.table();
    expect(table[0]?.releasedAt).toBeUndefined();
  });

  it("presents a reclaimed slot as faded rather than dropping it to neutral", async () => {
    const store = await primed([{ slot: 0, controllerId: "orchestrator:dead", assignedAt: at(0) }]);
    const colors = new CustodyColorService({
      store,
      orchestratorBindings: { list: async () => [] },
      now: () => at(1_000),
    });
    const table = await colors.table();

    const [view] = fleetWorkerCoordinationView(
      [worker({ controllerId: "orchestrator:dead", state: "released", endedAt: at(1_000) })],
      { custodyColors: table, now: at(2_000) },
    );

    expect(view?.custodyColor).toEqual({ slot: 0, intensity: "faded" });
  });

  it("recovers allocation after every slot was leaked by dead peers", async () => {
    const store = await primed(
      Array.from({ length: CUSTODY_COLOR_SLOT_COUNT }, (_, slot) => ({
        slot,
        controllerId: `orchestrator:workspace:/repo/${slot}`,
        assignedAt: at(0),
      })),
    );

    const colors = new CustodyColorService({
      store,
      orchestratorBindings: { list: async () => [] },
      now: () => at(1_000),
    });

    await expect(colors.assign("orchestrator:newcomer")).resolves.toBeDefined();
  });
});

describe("fleetWorkerCoordinationView custody color", () => {
  it("paints held leases active and ended leases faded", async () => {
    const colors = await service();
    await colors.assign("orchestrator:fleet");
    const table = await colors.table();

    const [held, ended] = fleetWorkerCoordinationView([
      worker({ controllerId: "orchestrator:fleet", state: "active" }),
      worker({ controllerId: "orchestrator:fleet", state: "released", endedAt: at(1_000) }),
    ], { custodyColors: table, now: at(2_000) });

    expect(held?.custodyColor).toEqual({ slot: 0, intensity: "active" });
    expect(ended?.custodyColor).toEqual({ slot: 0, intensity: "faded" });
  });

  it("omits the field for a controller holding no slot", () => {
    const [view] = fleetWorkerCoordinationView([
      worker({ controllerId: "orchestrator:fleet", state: "active" }),
    ], { custodyColors: [], now: at(0) });

    expect(view).not.toHaveProperty("custodyColor");
  });
});

describe("fleetOrchestratorCustodyColors", () => {
  const binding = (key: string, sessionId: string): OrchestratorBinding => ({
    key,
    sessionId,
    provider: "codex",
    cwd: "/repo",
    sandbox: "read-only",
    scope: { kind: "workspace", cwd: "/repo" },
    grant: {
      subjectSessionId: sessionId,
      capabilities: ["thread.list"],
      scope: { kind: "workspace", cwd: "/repo" },
    },
    createdAt: at(0),
    updatedAt: at(0),
  });

  it("maps each bound orchestrator session to its controller family's slot", async () => {
    const colors = await service();
    await colors.assign("orchestrator:fleet");
    await colors.assign("orchestrator:workspace:/repo");
    const fleetSession = randomUUID();
    const workspaceSession = randomUUID();

    const views = fleetOrchestratorCustodyColors([
      binding("fleet", fleetSession),
      binding("workspace:/repo", workspaceSession),
      binding("workspace:/repo:peer:two", randomUUID()),
    ], await colors.table());

    expect(views).toEqual([
      { sessionId: fleetSession, slot: 0 },
      { sessionId: workspaceSession, slot: 1 },
    ]);
  });
});
