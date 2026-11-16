import { afterEach, expect, it, vi } from "vitest";
import { StrigoiLegacyRetirement } from "../../src/orchestration/strigoi-legacy-retirement.js";
import { StrigoiLifecycle } from "../../src/orchestration/strigoi-lifecycle.js";
import { OrchestratorStore } from "../../src/persistence/orchestrator-store.js";
import { legacyRetirementFingerprint, type LegacyRetirementRequest } from "../../src/domain/strigoi-legacy-retirement.js";
import { recoveryFixture, NEXT } from "./strigoi-worker-recovery-fixture.js";
import { cleanupAttentionHarnesses } from "../support/attention-harness.js";

const fixtures: Awaited<ReturnType<typeof recoveryFixture>>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) f.liveness.dispose(); await cleanupAttentionHarnesses(); });
async function fixture() {
  const f = await recoveryFixture(); fixtures.push(f);
  await f.seal(); await f.cutover(); f.attention.stop(); await f.attention.flush();
  await f.mutate({ desired: "suspended" });
  f.records.set(NEXT, { ...f.records.get(NEXT)!, executor: "host", pid: 4242, codexActorMarker: true,
    executionState: "cancelled", exitCode: -1, launchRecord: { mode: "launch", transport: "pty", resolvedAt: f.now(),
      executable: "/node", args: ["/app/providers/codex/remote-mcp-launch.js", "--actor-session", NEXT, "--", "--remote", "unix://"],
      cwd: "/repo", cyberdeckEnv: {}, inheritedEnvCount: 0, truncated: false } });
  const registry = { ...f.registry, ownsProcess: vi.fn(() => false), residentRetirement: vi.fn(async () => "unknown" as const) };
  const proof = { kind: "host-group-absent-and-managed-daemon-empty" as const, observedAt: f.now(),
    homeDirectory: "/managed", socketPath: "/socket", daemonPid: 1234, daemonIdentitySha256: "a".repeat(64) };
  const probe = vi.fn(async () => proof);
  const service = new StrigoiLegacyRetirement({ repository: f.repository, bindings: f.bindings, registry: registry as never, probe });
  const state = await f.repository.read();
  const request: LegacyRetirementRequest = { sessionId: NEXT, generation: 1, pid: 4242, transitionId: state.transition!.id,
    expectedRevision: state.revision, recordSha256: legacyRetirementFingerprint(registry.get(NEXT)),
    mutationId: "verified-legacy-retirement", confirmHostPtyProvenance: true, provenance: "Operator verified the exact legacy PTY and managed daemon provenance.",
    managedHome: "/managed", confirmManagedDaemonProvenance: true };
  return { ...f, registry, probe, proof, service, request };
}

it("records a replayable separate retirement receipt, preserves the unknown exit, and remains suspended", async () => {
  const f = await fixture(), before = await f.repository.read();
  expect(await f.service.inspect()).toMatchObject({ sessionId: NEXT, pid: 4242, expectedRevision: before.revision });
  expect((await f.repository.read()).revision).toBe(before.revision);
  const receipt = await f.service.confirm(f.request);
  expect(receipt.contract).toBe("operator-audited-node-pty-setsid");
  expect(await f.service.confirm(f.request)).toEqual(receipt);
  const reloaded = new OrchestratorStore(f.directory).strigoi;
  expect(await reloaded.read()).toMatchObject({ desired: "suspended", revision: before.revision + 1, legacyRetirements: [receipt] });
  expect(f.registry.get(NEXT)).toMatchObject({ exitCode: -1 });
  expect(f.registry.get(NEXT).recoveryProcessGroup).toBeUndefined();
  const lifecycle = new StrigoiLifecycle({ repository: reloaded, registry: f.registry } as never);
  expect(await lifecycle.retirement(NEXT, 1)).toBe("confirmed");
  expect(await lifecycle.retirement(NEXT, 2)).toBe("unknown");
  f.registry.ownsProcess.mockReturnValue(true);
  expect(await lifecycle.retirement(NEXT, 1)).toBe("unknown");
});

it.each(["expectedRevision", "pid", "generation", "recordSha256", "transitionId"] as const)("rejects stale %s before probing or writing", async key => {
  const f = await fixture(), before = await f.repository.read();
  const request = { ...f.request, [key]: typeof f.request[key] === "number" ? Number(f.request[key]) + 1 : key === "recordSha256" ? "f".repeat(64) : "stale" };
  await expect(f.service.confirm(request)).rejects.toThrow("STRIGOI_STALE_LEGACY_EVIDENCE");
  expect(f.probe).not.toHaveBeenCalled(); expect(await f.repository.read()).toEqual(before);
});

it.each(["owned", "worker", "pipe", "known-group", "enabled"])("refuses %s targets without manufacturing evidence", async mode => {
  const f = await fixture();
  const record = f.registry.get(NEXT);
  if (mode === "owned") f.registry.ownsProcess.mockReturnValue(true);
  if (mode === "worker") f.records.set(NEXT, { ...record, kind: "worker" });
  if (mode === "pipe") f.records.set(NEXT, { ...record, launchRecord: { ...record.launchRecord!, transport: "pipe" } });
  if (mode === "known-group") f.records.set(NEXT, { ...record, recoveryProcessGroup: record.pid });
  if (mode === "enabled") await f.mutate({ desired: "enabled" });
  await expect(f.service.confirm(f.request)).rejects.toThrow();
  expect((await f.repository.read()).legacyRetirements).toBeUndefined(); expect(f.probe).not.toHaveBeenCalled();
});

it.each(["unavailable", "identity-race", "owned-race"])("holds on %s after inspection and before commit", async mode => {
  const f = await fixture(), before = await f.repository.read();
  f.probe.mockImplementation(async () => {
    if (mode === "unavailable") throw new Error("daemon unknown");
    if (mode === "identity-race") f.records.set(NEXT, { ...f.registry.get(NEXT), generation: 2 });
    if (mode === "owned-race") f.registry.ownsProcess.mockReturnValue(true);
    return f.proof;
  });
  await expect(f.service.confirm(f.request)).rejects.toThrow();
  expect(await f.repository.read()).toEqual(before);
});

it("rejects another empty daemon home or absent explicit historical daemon attribution", async () => {
  const f = await fixture();
  await expect(f.service.confirm({ ...f.request, managedHome: "/other-home" })).rejects.toThrow("STRIGOI_LEGACY_MANAGED_HOME_MISMATCH");
  await expect(f.service.confirm({ ...f.request, confirmManagedDaemonProvenance: false } as never)).rejects.toThrow();
  expect((await f.repository.read()).legacyRetirements).toBeUndefined();
});

it.each(["before", "after"])("reconciles a lost receipt append response %s durable publication", async side => {
  const f = await fixture(), cas = f.repository.compareAndSwap.bind(f.repository);
  vi.spyOn(f.repository, "compareAndSwap").mockImplementationOnce(async (...args) => {
    if (side === "after") await cas(...args);
    throw new Error("lost append response");
  });
  await expect(f.service.confirm(f.request)).rejects.toThrow("lost append response");
  await f.service.confirm(f.request);
  expect((await new OrchestratorStore(f.directory).strigoi.read()).legacyRetirements).toHaveLength(1);
  await expect(f.service.confirm({ ...f.request, provenance: "Different operator confirmation conflicts with the original mutation." }))
    .rejects.toThrow("STRIGOI_MUTATION_CONFLICT");
});
