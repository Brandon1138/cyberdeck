import { describe, expect, it, vi } from "vitest";
import { RuntimeParkingService, parkingRefusal, type ParkingRecord, type ParkingSnapshot,
  type RuntimeParkingPort } from "../../src/orchestration/runtime-parking-service.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(grace = 0) {
  let now = 1000;
  const current: ParkingSnapshot = { sessionId: "worker", generation: 1, executionId: "execution", workspaceId: "workspace",
    conversationId: "native-conversation", authorityEpoch: "lease-1", revision: 1, runtime: "running",
    truth: { state: "idle", terminal: false, canonicalTurns: 1, completedTurns: 1, pendingInstructions: 0,
      composerOccupied: false, modalOpen: false, detail: "idle after canonical receipt" },
    instructions: ["completed"], settled: true, outstandingTools: 0, pendingReports: 0, operatorAttached: false, resumeSupported: true };
  const records = new Map<string, ParkingRecord>();
  let claimed = false;
  const port: RuntimeParkingPort = {
    snapshot: () => structuredClone(current),
    claim: vi.fn(expected => {
      if (claimed || JSON.stringify(expected) !== JSON.stringify(current)) return undefined;
      claimed = true; return { token: "claim", expected };
    }),
    release: vi.fn(() => { claimed = false; }),
    restoreParked: vi.fn(() => true),
    stop: vi.fn(async () => { current.runtime = "stopped"; }),
    awaitStopped: vi.fn(async () => "stopped" as const),
    resume: vi.fn(async () => { current.runtime = "running"; current.generation++; return structuredClone(current); }),
    flush: vi.fn(async () => {}),
  };
  const store = { get: (id: string) => records.get(id), put: vi.fn(async (record: ParkingRecord) => {
    records.set(record.sessionId, structuredClone(record));
  }) };
  const service = new RuntimeParkingService(port, store, { idleGraceMs: grace, now: () => now });
  return { current, records, port, store, service, setNow: (value: number) => { now = value; } };
}

describe("resource-aware runtime parking", () => {
  it.each([
    ["rendered input", { instructions: ["rendered"] }], ["submitted input", { instructions: ["submitted"] }],
    ["uncommitted turn", { settled: false }], ["unknown settlement", { settled: null }],
    ["pending tool", { outstandingTools: 1 }], ["unknown tools", { outstandingTools: null }],
    ["pending report", { pendingReports: 1 }], ["unknown reports", { pendingReports: null }],
    ["operator attachment", { operatorAttached: true }], ["unsupported resume", { resumeSupported: false }],
    ["missing native conversation", { conversationId: null }],
  ])("refuses %s despite an idle/done presentation", async (_label, overrides) => {
    const f = fixture(); Object.assign(f.current, overrides);
    expect(await f.service.consider("worker")).toMatchObject({ state: "skipped" });
    expect(f.port.stop).not.toHaveBeenCalled(); expect(f.port.resume).not.toHaveBeenCalled();
  });
  it("refuses screen-only completion and enforces uninterrupted idle grace", async () => {
    const f = fixture(100);
    f.current.truth.canonicalTurns = 0;
    expect(parkingRefusal(f.current)).toBe("canonical-turn-unsettled"); f.current.truth.canonicalTurns = 1;
    expect(await f.service.consider("worker")).toMatchObject({ reason: "idle-grace" });
    f.setNow(1100); f.current.revision++;
    expect(await f.service.consider("worker")).toMatchObject({ reason: "idle-grace" });
    f.setNow(1200);
    expect(await f.service.consider("worker")).toEqual({ state: "parked" });
    expect(f.port.stop).toHaveBeenCalledOnce();
  });
  it("retains queued input arriving during the durable park write without stopping", async () => {
    const f = fixture(); const barrier = deferred();
    const original = f.store.put.getMockImplementation()!;
    f.store.put.mockImplementationOnce(async record => { await original(record); await barrier.promise; });
    const park = f.service.consider("worker");
    await vi.waitFor(() => expect(f.records.get("worker")?.phase).toBe("parking"));
    f.current.instructions.push("accepted"); const wake = f.service.inputQueued("worker");
    barrier.resolve();
    expect(await park).toMatchObject({ state: "skipped" }); expect(await wake).toEqual({ state: "active" });
    expect(f.port.stop).not.toHaveBeenCalled(); expect(f.port.resume).not.toHaveBeenCalled();
    expect(f.port.flush).toHaveBeenCalledOnce();
  });
  it("immediate input during stop waits for settlement, resumes exactly once and flushes the existing queue", async () => {
    const f = fixture(); const stopped = deferred();
    vi.mocked(f.port.awaitStopped).mockImplementation(async () => { await stopped.promise; return "stopped"; });
    const park = f.service.consider("worker"); await vi.waitFor(() => expect(f.port.stop).toHaveBeenCalledOnce());
    f.current.instructions.push("queued"); const wake1 = f.service.inputQueued("worker"), wake2 = f.service.inputQueued("worker");
    expect(f.port.resume).not.toHaveBeenCalled(); stopped.resolve();
    expect(await park).toEqual({ state: "parked" }); await Promise.all([wake1, wake2]);
    expect(f.port.resume).toHaveBeenCalledOnce(); expect(f.current.generation).toBe(2);
    expect(f.current.conversationId).toBe("native-conversation"); expect(f.current.workspaceId).toBe("workspace");
    expect(f.current.instructions).toEqual(["completed", "queued"]); // service never consumes, rewrites or duplicates a payload
  });
  it("never wakes a replacement generation after a stale stop callback", async () => {
    const f = fixture();
    vi.mocked(f.port.awaitStopped).mockImplementation(async () => { f.current.generation = 2; return "stopped"; });
    expect(await f.service.consider("worker")).toMatchObject({ state: "intervention", reason: "runtime-replaced" });
    await f.service.inputQueued("worker"); expect(f.port.resume).not.toHaveBeenCalled(); expect(f.port.flush).not.toHaveBeenCalled();
  });
  it("cancels a stale authority claim before stop, but a later handoff can wake the same parked worker", async () => {
    const f = fixture(); const original = f.store.put.getMockImplementation()!;
    f.store.put.mockImplementationOnce(async record => { await original(record); f.current.authorityEpoch = "lease-2"; });
    expect(await f.service.consider("worker")).toMatchObject({ reason: "authority-or-generation-changed" });
    expect(f.port.stop).not.toHaveBeenCalled();
    const g = fixture(); await g.service.consider("worker"); g.current.authorityEpoch = "lease-2";
    expect(await g.service.inputQueued("worker")).toEqual({ state: "active" });
    expect(vi.mocked(g.port.resume).mock.calls[0]![0].expected.authorityEpoch).toBe("lease-2");
  });
  it("does not advertise parking when stop/settlement cannot be confirmed", async () => {
    const f = fixture(); vi.mocked(f.port.awaitStopped).mockResolvedValue("unknown");
    expect(await f.service.consider("worker")).toMatchObject({ state: "intervention", reason: "stop-unknown" });
    expect(f.port.resume).not.toHaveBeenCalled();
  });
  it("retains failed wakes and their instruction queue without automatic retry", async () => {
    const f = fixture(); await f.service.consider("worker"); f.current.instructions.push("queued");
    vi.mocked(f.port.resume).mockRejectedValue(new Error("auth-renewal-required"));
    expect(await f.service.inputQueued("worker")).toMatchObject({ state: "intervention", reason: "resume-failed" });
    await f.service.inputQueued("worker"); expect(f.port.resume).toHaveBeenCalledOnce();
    expect(f.current.instructions).toContain("queued"); expect(f.port.flush).not.toHaveBeenCalled();
    await f.service.recover("worker"); expect(f.port.resume).toHaveBeenCalledOnce();
  });
  it("restores the parked input fence after restart and reconciles a recorded successful wake", async () => {
    const f = fixture(); await f.service.consider("worker");
    const replacement = new RuntimeParkingService(f.port, f.store, { idleGraceMs: 0 });
    expect(await replacement.recover("worker")).toEqual({ state: "parked" }); expect(f.port.restoreParked).toHaveBeenCalledOnce();
    const parked = f.records.get("worker")!; f.records.set("worker", { ...parked, phase: "waking" });
    f.current.generation = 2; f.current.runtime = "running";
    expect(await replacement.recover("worker")).toEqual({ state: "active" }); expect(f.port.resume).not.toHaveBeenCalled();
    expect(f.port.flush).toHaveBeenCalledOnce();
  });
  it("recovers a successful resume whose active-state write failed without duplicating the provider", async () => {
    const f = fixture(); await f.service.consider("worker");
    const original = f.store.put.getMockImplementation()!;
    f.store.put.mockImplementation(async record => {
      if (record.phase === "active") throw new Error("disk-full");
      await original(record);
    });
    expect(await f.service.inputQueued("worker")).toMatchObject({ state: "intervention", reason: "wake-settlement-failed" });
    expect(f.records.get("worker")?.phase).toBe("waking");
    f.store.put.mockImplementation(original);
    expect(await f.service.recover("worker")).toEqual({ state: "active" });
    expect(f.port.resume).toHaveBeenCalledOnce(); expect(f.port.flush).toHaveBeenCalledOnce();
  });
});
