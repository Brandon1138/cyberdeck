import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeToolExecutor } from "../../../src/runtime/execution/native-tool-executor.js";
import { nativeManifestHash } from "../../../src/runtime/execution/native-tool-workspace.js";
import type { NativeCommandResult, NativeProcessSupervisor, NativeToolRecipe, NativeToolRequest } from "../../../src/runtime/execution/native-tool-types.js";
import { workspaceManifest } from "../../../src/runtime/execution/workspace-manifest.js";
import type { ResourceRuntimeBinding } from "../../../src/domain/resource-runtime.js";
import { realAuxiliaryAdmission } from "./auxiliary-admission-fixture.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const request: NativeToolRequest = { requestId: "run1", attemptId: "attempt1", executionId: "execution1", generation: 1, recipeId: "fixture" };
const uuid = "AE0B5449-E850-4AE2-AD47-FB773382F1A8";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "native-profile-test-")); roots.push(root);
  const source = join(root, "source"); await mkdir(source);
  await writeFile(join(source, "input.swift"), "trusted source");
  const manifest = await workspaceManifest(source);
  const recipe: NativeToolRecipe = { id: "fixture", inputManifestSha256: nativeManifestHash(manifest), project: "Fixture.xcodeproj",
    scheme: "Fixture", developerDirectory: "/Applications/Xcode.app/Contents/Developer", simulatorRuntime: "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
    simulatorDeviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17", action: "test", timeoutMs: 10000,
    maxInputBytes: 1024, maxArtifactBytes: 1024 * 1024, demand: { memoryBytes: 1024 ** 3, cpuWeight: 100, pidLimit: 100, profileId: "native", profileVersion: "v1" } };
  const bindings = new Map<string, ResourceRuntimeBinding>();
  const admission = { request: vi.fn().mockResolvedValue({ state: "admitted", reservationId: "reserve1", demand: recipe.demand }),
    release: vi.fn().mockResolvedValue(undefined), cancel: vi.fn().mockResolvedValue(undefined) };
  const authorize = vi.fn().mockResolvedValue({ familyId: "family1", writeAllowed: true, workspaceRoot: source, inputManifest: manifest });
  const result: NativeCommandResult = { exitCode: 0, signal: null, cancelled: false, timedOut: false, reason: null,
    cleanup: "terminated", identities: [{ kind: "native", pid: 123, startTime: "libproc:123.000001" }], uncertainty: [] };
  const run = vi.fn<NativeProcessSupervisor["run"]>().mockImplementation(async (command, context) => {
    await context.identities(result.identities);
    await writeFile(command.logPath, command.args[1] === "create" ? `${uuid}\n` : "tool output\n");
    return structuredClone(result);
  });
  const settled = vi.fn().mockResolvedValue(undefined);
  const options = { rootDirectory: join(root, "runs"), installationId: "installation1", recipes: [recipe], admission,
    bindings: { list: () => [...bindings.values()], get: (id: string) => bindings.get(id),
      put: async (binding: ResourceRuntimeBinding) => { bindings.set(binding.request.requestId, structuredClone(binding)); } },
    authorize, supervisor: { run }, settled };
  return { root, source, recipe, options, bindings, admission, authorize, run, settled, result };
}

describe("broker-owned native execution", () => {
  it("runs fixed unsigned Xcode commands over a pinned copy and deletes only its own simulator", async () => {
    const f = await fixture();
    const result = await new NativeToolExecutor(f.options).execute(request);
    expect(result.state).toBe("finished");
    const commands = f.run.mock.calls.map(([command]) => command);
    expect(commands.map(command => command.executable)).toEqual(["/usr/bin/xcrun", "/usr/bin/xcodebuild", "/usr/bin/xcrun", "/usr/bin/xcrun"]);
    expect(commands[0]!.args).toEqual(["simctl", "create", "cyberdeck-run1", f.recipe.simulatorDeviceType, f.recipe.simulatorRuntime]);
    expect(commands[1]!.args).toContain("CODE_SIGNING_ALLOWED=NO");
    expect(commands[1]!.args).toContain(`platform=iOS Simulator,id=${uuid}`);
    expect(commands[2]!.args).toEqual(["simctl", "shutdown", uuid]);
    expect(commands[3]!.args).toEqual(["simctl", "delete", uuid]);
    expect(Object.keys(commands[1]!.env).sort()).toEqual(["DEVELOPER_DIR", "HOME", "PATH", "TMPDIR"]);
    expect(await readFile(join(commands[1]!.cwd, "input.swift"), "utf8")).toBe("trusted source");
    expect(f.admission.release).not.toHaveBeenCalled();
    expect(f.settled).toHaveBeenCalledWith(expect.objectContaining({ isolation: "native-user-filesystem",
      result: expect.objectContaining({ cleanup: "unproven" }) }));
  });
  it("releases only after explicit whole-lifetime and simulator termination proof", async () => {
    const f = await fixture(); const proveTermination = vi.fn().mockResolvedValue(true);
    await new NativeToolExecutor({ ...f.options, proveTermination }).execute(request);
    expect(proveTermination).toHaveBeenCalledOnce();
    expect(f.admission.release).toHaveBeenCalledOnce();
    expect(f.bindings.get("native-run1")?.phase).toBe("terminated");
  });
  it("refuses readonly authority, stale generation, unknown recipes and arbitrary command/cwd fields before admission", async () => {
    const f = await fixture(); const executor = new NativeToolExecutor(f.options);
    f.authorize.mockResolvedValueOnce({ ...await f.authorize(request), writeAllowed: false });
    await expect(executor.execute(request)).rejects.toThrow("native-write-policy-refused");
    f.authorize.mockRejectedValueOnce(new Error("stale-generation"));
    await expect(executor.execute(request)).rejects.toThrow("stale-generation");
    await expect(executor.execute({ ...request, recipeId: "arbitrary" })).rejects.toThrow("native-recipe-unavailable");
    await expect(executor.execute({ ...request, cwd: "/" } as NativeToolRequest)).rejects.toThrow();
    expect(f.admission.request).not.toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled();
  });
  it("returns durable waiting state with no workspace or tool and rechecks authority before launch", async () => {
    const f = await fixture(); const executor = new NativeToolExecutor(f.options);
    f.admission.request.mockResolvedValueOnce({ state: "waiting-capacity", reason: "full", queuedAt: new Date().toISOString() });
    expect(await executor.execute(request)).toMatchObject({ state: "waiting-capacity" });
    expect(f.run).not.toHaveBeenCalled();
    f.authorize.mockResolvedValueOnce(await f.authorize(request)).mockRejectedValueOnce(new Error("stale-generation"));
    await expect(executor.execute(request)).rejects.toThrow("stale-generation");
    expect(f.run).not.toHaveBeenCalled(); expect(f.admission.release).toHaveBeenCalledOnce();
  });
  it("refuses modified pinned source and symlinks without launching", async () => {
    const f = await fixture();
    await writeFile(join(f.source, "input.swift"), "hostile script");
    await expect(new NativeToolExecutor(f.options).execute(request)).rejects.toThrow("native-input-changed");
    expect(f.run).not.toHaveBeenCalled(); expect(f.admission.release).toHaveBeenCalledOnce();
    const second = await fixture();
    await rm(join(second.source, "input.swift")); await symlink("/etc/passwd", join(second.source, "input.swift"));
    await expect(new NativeToolExecutor(second.options).execute(request)).rejects.toThrow();
    expect(second.run).not.toHaveBeenCalled();
  });
  it("retains artifacts and capacity on interrupted builds, runs scoped cleanup and persists terminal evidence", async () => {
    const f = await fixture();
    const original = f.run.getMockImplementation()!;
    f.run.mockImplementation(async (command, context) => {
      const result = await original(command, context);
      return command.executable === "/usr/bin/xcodebuild" ? { ...result, timedOut: true, exitCode: null, signal: "SIGTERM" } : result;
    });
    const result = await new NativeToolExecutor(f.options).execute(request);
    expect(result).toMatchObject({ state: "finished", result: { timedOut: true, cleanup: "unproven" } });
    expect(f.run).toHaveBeenCalledTimes(4); expect(f.admission.release).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(join(f.options.rootDirectory, "run1", "result.json"), "utf8"))).toMatchObject({ request });
  });
  it("never replays an already launched request and keeps reservation when terminal persistence fails", async () => {
    const f = await fixture(); const executor = new NativeToolExecutor(f.options);
    f.settled.mockRejectedValueOnce(new Error("outbox-full"));
    await expect(executor.execute(request)).rejects.toThrow("outbox-full");
    await expect(executor.execute(request)).rejects.toThrow("native-request-already-launched");
    expect(f.run).toHaveBeenCalledTimes(4); expect(f.admission.release).not.toHaveBeenCalled();
  });
  it("gives sibling native requests unique workload IDs without losing attempt attribution", async () => {
    const f = await fixture(), real = await realAuxiliaryAdmission(f.root, "installation1", async () => false);
    try {
      // The canonical worker may already hold this initial attempt ID at the same generation.
      await real.admission.request({ requestId: "active-worker", owner: { installationId: "installation1", workloadId: request.attemptId,
        kind: "worker", generation: 1, familyId: "family1" }, demand: f.recipe.demand, priority: "interactive" });
      const executor = new NativeToolExecutor({ ...f.options, admission: real.admission, bindings: real.bindings });
      await executor.execute(request); await executor.execute({ ...request, requestId: "run2" });
      expect(real.admission.health().reservations.map(r => r.request.owner.workloadId)).toEqual([request.attemptId, "native-run1", "native-run2"]);
      expect(JSON.parse(await readFile(join(f.options.rootDirectory, "run2", "request.json"), "utf8")).request.attemptId).toBe(request.attemptId);
    } finally { await real.store.close(); }
  });
  it.each([false, true])("retires stale queued authority without launching, including already-admitted=%s", async admitted => {
    const f = await fixture();
    const real = await realAuxiliaryAdmission(f.root, "installation1", async (reservation, evidence) => {
      const binding = real.bindings.get(reservation.request.requestId);
      return evidence === `${reservation.request.requestId}-not-launched` && binding?.phase === "terminated" && !binding.identities.length;
    });
    try {
      real.control.available = false;
      const options = { ...f.options, admission: real.admission, bindings: real.bindings }, executor = new NativeToolExecutor(options);
      expect(await executor.execute(request)).toMatchObject({ state: "waiting-capacity" });
      f.authorize.mockRejectedValue(new Error("stale authority"));
      if (admitted) { real.control.available = true; await real.admission.refresh(); expect(real.admission.health().reservedBytes).toBe(f.recipe.demand.memoryBytes); }
      await expect(executor.execute(request)).rejects.toThrow("stale authority");
      // A fresh executor owns recovery after restart; no current authority is consulted.
      expect(await new NativeToolExecutor(options).recover(request)).toMatchObject({ cleanupComplete: true });
      expect(real.admission.health()).toMatchObject({ reservedBytes: 0, queue: [] }); expect(f.run).not.toHaveBeenCalled();
      expect(await executor.cancelPending(request)).toMatchObject({ cleanupComplete: true });
    } finally { await real.store.close(); }
  });
  it("launched native recovery keeps capacity and never substitutes PID-table absence for lifetime proof", async () => {
    const f = await fixture(), real = await realAuxiliaryAdmission(f.root, "installation1", async () => false);
    try {
      const options = { ...f.options, admission: real.admission, bindings: real.bindings };
      await new NativeToolExecutor(options).execute(request); const calls = f.run.mock.calls.length;
      f.authorize.mockRejectedValue(new Error("stale authority"));
      expect(await new NativeToolExecutor(options).recover(request)).toMatchObject({ cleanupComplete: false, result: { state: "finished", result: { exitCode: 0 } } });
      expect(real.admission.health().reservedBytes).toBe(f.recipe.demand.memoryBytes); expect(f.run).toHaveBeenCalledTimes(calls);
    } finally { await real.store.close(); }
  });
});
