import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StrigoiLifecycle } from "../../src/orchestration/strigoi-lifecycle.js";
import { OrchestratorStore } from "../../src/persistence/orchestrator-store.js";
import { OrchestratorManager } from "../../src/orchestration/orchestrator-manager.js";
import type { SessionRecord } from "../../src/domain/session.js";
import type { SessionStartPort } from "../../src/orchestration/session/session-ports.js";

const selection = { provider: "codex" as const, model: "gpt-5.6-sol", cwd: "/repo" };
const roots: string[] = [], residents: StrigoiLifecycle[] = [];
afterEach(async () => { residents.splice(0).forEach((r) => r.dispose()); vi.useRealTimers(); for (const p of roots.splice(0)) await rm(p, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "strigoi-lifecycle-")); roots.push(root);
  const bindings = new OrchestratorStore(root), records = new Map<string, SessionRecord>();
  let modal = false;
  const start = vi.fn<SessionStartPort["start"]>(async (request, prompt, activate, _instruction, admit, reservation) => {
    expect(prompt).toBeUndefined(); expect(reservation).toBeDefined();
    const record = { ...request, id: reservation!.sessionId, generation: 7, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      executionState: "active", attachmentState: "detached", pid: 42, exitCode: null, childIds: [] } as SessionRecord;
    await admit!(async () => { await activate!(record); records.set(record.id, record); });
    return record;
  });
  const registry = { start, get: (id: string) => { const r = records.get(id); if (!r) throw new Error("missing"); return r; },
    resume: vi.fn(), ownsProcess: (id: string) => records.has(id), stopResidentProcess: vi.fn(async (id: string) => { records.delete(id); }),
    workerTruth: () => ({ modalOpen: modal }), submit: vi.fn() };
  const manager = new OrchestratorManager(registry, bindings, undefined, undefined, async () => []);
  const admission = { freeze: vi.fn(async () => {}), reopen: vi.fn(async () => {}), run: vi.fn(), instruction: vi.fn() };
  const options = { repository: bindings.strigoi, bindings, registry, manager, admission };
  const make = () => { const r = new StrigoiLifecycle(options); residents.push(r); return r; };
  const resident = make();
  return { resident, make, start, registry, admission, bindings, records, setModal: (v: boolean) => { modal = v; } };
}

describe("passive Strigoi lifecycle", () => {
  it("repeated reconciliation starts once with native guidance and actual generation, never inference", async () => {
    vi.useFakeTimers();
    const f = await fixture(); await f.resident.configure(selection, "configure");
    await Promise.all([f.resident.reconcile(), f.resident.reconcile(), f.resident.reconcile()]);
    const state = (await f.resident.inspect()).state;
    expect(f.start).toHaveBeenCalledOnce(); expect(f.registry.submit).not.toHaveBeenCalled();
    expect(state.activeGeneration).toBe(7); expect(state.activeBinding?.kind).toBe("resident");
    expect(f.start.mock.calls[0]![0]).toMatchObject({ name: "Strigoi", kind: "orchestrator", providerInstructions: expect.stringContaining("Alfred") });
    await vi.advanceTimersByTimeAsync(3_600_000); await f.resident.inspect();
    expect(f.start).toHaveBeenCalledOnce(); expect(f.registry.submit).not.toHaveBeenCalled();
  });
  it("suspension survives restart without launch", async () => {
    const f = await fixture(); await f.resident.configure(selection, "configure");
    await f.resident.setDesired("suspended", "suspend"); f.resident.dispose();
    await f.make().reconcile(); expect(f.start).not.toHaveBeenCalled();
  });
  it("persists the three transient failure delays across restarts, then holds", async () => {
    vi.useFakeTimers(); const f = await fixture();
    f.start.mockRejectedValue(Object.assign(new Error("temporary preparation failure"), { code: "ETIMEDOUT" }));
    await f.resident.configure(selection, "configure"); let resident = f.resident;
    for (const delay of [1000, 5000, 30000]) {
      await resident.reconcile();
      const state = (await resident.inspect()).state;
      expect(Date.parse(state.transition!.nextAttemptAt!) - Date.now()).toBe(delay);
      resident.dispose(); resident = f.make(); await resident.reconcile();
      await vi.advanceTimersByTimeAsync(delay);
      // A scheduled reconciliation can be waiting on fsync; join it before the next assertion.
      await resident.reconcile();
    }
    expect(f.start).toHaveBeenCalledTimes(3);
    expect((await resident.inspect()).state.hold?.code).toBe("launch-retries-exhausted");
  });
  it.each(["AUTHENTICATION_REQUIRED", "INVALID_SESSION_CWD", "PROVIDER_NOT_REGISTERED"])("holds %s immediately", async (code) => {
    const f = await fixture(); f.start.mockRejectedValue(Object.assign(new Error(code), { code }));
    await f.resident.configure(selection, "configure"); await f.resident.reconcile(); await f.resident.reconcile();
    expect(f.start).toHaveBeenCalledOnce(); expect((await f.resident.inspect()).state.hold?.code).toBe(code);
  });
  it("rejects unsupported configuration without enabling", async () => {
    const f = await fixture();
    await expect(f.resident.configure({ ...selection, provider: "claude" } as never, "bad")).rejects.toThrow();
    expect((await f.resident.inspect()).state.desired).toBe("disabled");
  });
  it("explicit resume starts a fresh bounded episode after a preparation hold", async () => {
    const f = await fixture(); const launch = f.start.getMockImplementation()!;
    f.start.mockRejectedValueOnce(Object.assign(new Error("credentials"), { code: "AUTHENTICATION_REQUIRED" }));
    await f.resident.configure(selection, "configure"); await f.resident.reconcile();
    await f.resident.setDesired("enabled", "resume"); f.start.mockImplementation(launch); await f.resident.reconcile();
    expect(f.start).toHaveBeenCalledTimes(2); expect((await f.resident.inspect()).state.transition?.attempts).toBe(1);
  });
  it("holds wrapped credential failure immediately", async () => {
    const f = await fixture();
    f.start.mockRejectedValue(Object.assign(new Error("RC unavailable", { cause: Object.assign(new Error("login required"), { code: "AUTHENTICATION_REQUIRED" }) }), { code: "CODEX_REMOTE_CONTROL_UNAVAILABLE" }));
    await f.resident.configure(selection, "configure"); await f.resident.reconcile();
    expect((await f.resident.inspect()).state.hold?.code).toBe("AUTHENTICATION_REQUIRED");
    expect((await f.resident.inspect()).state.transition?.nextAttemptAt).toBeUndefined();
  });
  it("does not trust or kill a persisted PID when the current broker owns no process", async () => {
    const f = await fixture(); await f.resident.configure(selection, "configure"); await f.resident.reconcile();
    f.registry.ownsProcess = () => false;
    f.resident.dispose(); const restarted = f.make(); await restarted.reconcile();
    expect((await restarted.inspect()).state.hold?.code).toBe("launch-ownership-unresolved");
    await restarted.setDesired("suspended", "suspend");
    expect(f.registry.stopResidentProcess).not.toHaveBeenCalled(); expect(f.start).toHaveBeenCalledOnce();
  });
  it("lost spawn response holds the assigned identity through restart without duplicate launch", async () => {
    const f = await fixture();
    f.start.mockImplementationOnce(async (_request, _prompt, activate, _instruction, admit, reservation) => {
      await admit!(async () => { await activate!({ id: reservation!.sessionId, generation: 1 } as SessionRecord); });
      throw new Error("spawn response lost");
    });
    await f.resident.configure(selection, "configure"); await f.resident.reconcile(); f.resident.dispose();
    const restarted = f.make(); await restarted.reconcile();
    expect((await restarted.inspect()).state.hold?.code).toBe("launch-ownership-unresolved");
    expect(f.start).toHaveBeenCalledOnce();
  });
  it("suspension wins a late launch result and stops only the owned process", async () => {
    const f = await fixture(); let release!: () => void, entered!: () => void;
    const ready = new Promise<void>((r) => { entered = r; }), wait = new Promise<void>((r) => { release = r; });
    const original = f.start.getMockImplementation()!;
    f.start.mockImplementationOnce(async (...args) => { const record = await original(...args); entered(); await wait; return record; });
    await f.resident.configure(selection, "configure"); const launch = f.resident.reconcile(); await ready;
    await f.resident.setDesired("suspended", "suspend"); release(); await launch;
    const state = (await f.resident.inspect()).state;
    expect(state.desired).toBe("suspended"); expect(state.activeBinding).toBeUndefined(); expect(f.registry.stopResidentProcess).toHaveBeenCalled();
  });
  it("permission modal holds without answering or starting another process", async () => {
    const f = await fixture(); f.setModal(true); await f.resident.configure(selection, "configure"); await f.resident.reconcile();
    await f.resident.reconcile(); expect(f.start).toHaveBeenCalledOnce();
    expect((await f.resident.inspect()).state.hold?.code).toBe("provider-permission-modal");
    expect(f.registry.submit).not.toHaveBeenCalled();
  });
});
