import { describe, expect, it, vi } from "vitest";
import { BrokerRuntimeConfigSchema } from "../../../src/config.js";
import { SessionRegistry } from "../../../src/broker/session-registry.js";
import type { SessionRuntime } from "../../../src/domain/session-runtime.js";
import { WorkerTurnObservationAdapter } from "../../../src/runtime/worker-turn-observation-adapter.js";

class Runtime implements SessionRuntime {
  readonly pid = 42;
  readonly writes: Buffer[] = [];
  readonly exits = new Set<(code: number) => void>();
  write(bytes: Buffer) { this.writes.push(bytes); }
  resize() {}
  snapshot() { return Buffer.alloc(0); }
  kill() { for (const listener of this.exits) listener(0); }
  onOutput() { return () => {}; }
  onExit(listener: (code: number) => void) { this.exits.add(listener); return () => { this.exits.delete(listener); }; }
}
async function fixture() {
  const runtimes: Runtime[] = [];
  const start = vi.fn(async (_record, launch: () => Promise<SessionRuntime>) => launch());
  const registry = new SessionRegistry({ config: BrokerRuntimeConfigSchema.parse({}),
    adapters: { codex: { id: "codex", buildLaunchSpec: record => ({ executable: "fixture", args: [], cwd: record.cwd, env: {} }),
      buildResumeSpec: record => ({ executable: "fixture", args: ["resume"], cwd: record.cwd, env: {} }) } },
    sessionRuntimeFactory: () => { const runtime = new Runtime(); runtimes.push(runtime); return runtime; },
    workerTurnObservation: new WorkerTurnObservationAdapter(), journal: { append: async () => {} },
    validateCwd: async () => {}, resourceExecution: { start, cancelStart: () => false } });
  const record = await registry.start({ provider: "codex", cwd: "/tmp/parking-fixture", detached: true, sandbox: "read-only" });
  let authorityEpoch = "lease-1";
  const input = vi.fn(), flush = vi.fn(async () => {});
  const port = registry.createParkingPort({ facts: () => ({ authorityEpoch, instructions: [], outstandingTools: 0,
    pendingReports: 0, resumeSupported: true, conversationId: "conversation1" }), onInputQueued: input, flush, stopDeadlineMs: 100 });
  return { registry, record, port, input, runtimes, start, setAuthority: (value: string) => { authorityEpoch = value; } };
}

describe("registry parking fence", () => {
  it("holds instructions and refuses attachment while a claim owns the runtime", async () => {
    const f = await fixture();
    const claim = f.port.claim(f.port.snapshot(f.record.id))!;
    expect(await f.registry.submitInstruction(f.record.id, "next", "broker")).toMatchObject({ state: "queued", hold: "provider-busy" });
    await expect(f.registry.attach(f.record.id, "operator", "watch", () => {})).rejects.toMatchObject({ code: "SESSION_BUSY" });
    expect(f.input).toHaveBeenCalledTimes(2); expect(f.runtimes[0]!.writes).toEqual([]);
    f.port.release(claim); await f.registry.stop(f.record.id);
  });
  it("uses ordinary stop and the same resource start gate on wake while preserving native identity", async () => {
    const f = await fixture(); const claim = f.port.claim(f.port.snapshot(f.record.id))!;
    await f.port.stop(claim); expect(await f.port.awaitStopped(claim)).toBe("stopped"); f.port.release(claim);
    expect(await f.registry.submitInstruction(f.record.id, "queued while parked", "broker")).toMatchObject({ state: "queued" });
    await expect(f.registry.resume(f.record.id)).rejects.toMatchObject({ code: "SESSION_BUSY" });
    const wake = f.port.claim(f.port.snapshot(f.record.id))!;
    const resumed = await f.port.resume(wake); f.port.release(wake);
    expect(resumed.generation).toBe(2); expect(resumed.conversationId).toBe("conversation1");
    expect(resumed.workspaceId).toBe("/tmp/parking-fixture"); expect(f.start).toHaveBeenCalledTimes(2);
    expect(f.start.mock.calls[1]![0].generation).toBe(2); expect(f.runtimes).toHaveLength(2);
    await f.registry.stop(f.record.id);
  });
  it("rejects a stale claim after canonical handoff without touching its runtime", async () => {
    const f = await fixture(); const claim = f.port.claim(f.port.snapshot(f.record.id))!;
    f.setAuthority("lease-2");
    await expect(f.port.stop(claim)).rejects.toMatchObject({ code: "SESSION_BUSY" });
    expect(f.registry.get(f.record.id).executionState).toBe("active");
    f.port.release(claim); await f.registry.stop(f.record.id);
  });
  it("does not take a stale snapshot after operator attachment or handoff", async () => {
    const f = await fixture(); const before = f.port.snapshot(f.record.id);
    await f.registry.attach(f.record.id, "operator", "watch", () => {});
    expect(f.port.claim(before)).toBeUndefined();
    await f.registry.detach(f.record.id, "operator");
    const detached = f.port.snapshot(f.record.id); f.setAuthority("lease-2");
    expect(f.port.claim(detached)).toBeUndefined(); await f.registry.stop(f.record.id);
  });
  it("rechecks canonical authority after queued resource admission and before starting a replacement", async () => {
    const f = await fixture(); const parked = f.port.claim(f.port.snapshot(f.record.id))!;
    await f.port.stop(parked); await f.port.awaitStopped(parked); f.port.release(parked);
    let admitted!: () => void;
    const held = new Promise<void>(resolve => { admitted = resolve; });
    f.start.mockImplementationOnce(async (_record, launch) => { await held; return launch(); });
    const claim = f.port.claim(f.port.snapshot(f.record.id))!;
    const waking = f.port.resume(claim);
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledTimes(2));
    f.setAuthority("lease-2"); admitted();
    await expect(waking).rejects.toMatchObject({ code: "SESSION_BUSY" });
    expect(f.runtimes).toHaveLength(1); expect(f.registry.get(f.record.id).generation).toBe(1);
    f.port.release(claim);
  });
});
