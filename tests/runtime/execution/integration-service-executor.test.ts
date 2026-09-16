import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IntegrationServiceExecutor } from "../../../src/runtime/execution/integration-service-executor.js";
import { integrationNames, type IntegrationServiceRequest } from "../../../src/runtime/execution/integration-service-recipe.js";
import { OrbStackClient } from "../../../src/runtime/execution/orbstack-client.js";
import type { ResourceAdmissionPort, ResourceRequest, ResourceReservation } from "../../../src/domain/resource-budget.js";

const roots: string[] = [], image = `sha256:${"a".repeat(64)}`;
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }); });
const request = (): IntegrationServiceRequest => ({ identity: { brokerId: randomUUID(), executionId: randomUUID(),
  workerId: randomUUID(), sessionId: randomUUID(), generation: 1 }, attemptId: randomUUID(), leaseVersion: 1, recipe: "postgres-fixture-v1" });
function fakeEngine() {
  const objects = new Map<string, any>();
  const state = { unavailable: false, healthy: true, runnerExit: 0, oom: false, corruptNetwork: false, corruptLabel: false, siblingNetwork: false, failRemove: false, tick: 0 };
  const run = vi.fn(async (argv: string[]) => {
    if (state.unavailable) throw new Error("daemon unreachable");
    const args = argv.slice(2), command = args[0];
    const value = (flag: string) => args[args.indexOf(flag) + 1]!;
    const values = (flag: string) => args.flatMap((s, index) => s === flag ? [args[index + 1]!] : []);
    const labels = () => Object.fromEntries(values("--label").map(s => [s.slice(0, s.indexOf("=")), s.slice(s.indexOf("=") + 1)]));
    if (command === "context") return JSON.stringify([{ Name: "orbstack", Endpoints: { docker: { Host: "unix:///tmp/integration-test.sock" } } }]);
    if (command === "ps" || args[1] === "ls") {
      const match = value("--filter").replace(/^name=(?:\^\/)?/, "").replace(/\$$/, "");
      return objects.has(match) ? match : "";
    }
    if (command === "inspect" || args[1] === "inspect") return JSON.stringify([objects.get(args.at(-1)!) ]);
    if (command === "network" && args[1] === "create") {
      const name = args.at(-1)!;
      objects.set(name, { Name: name, Id: name, Labels: labels(), Internal: !state.corruptNetwork, Driver: "bridge", Containers: {} }); return name;
    }
    if (command === "volume" && args[1] === "create") {
      const name = args.at(-1)!; objects.set(name, { Name: name, Labels: labels(), Driver: "local",
        Options: Object.fromEntries(values("--opt").map(s => [s.slice(0, s.indexOf("=")), s.slice(s.indexOf("=") + 1)])) }); return name;
    }
    if (command === "create") {
      const name = value("--name"), runner = name.endsWith("-test"), id = (runner ? "c" : "b").repeat(64);
      objects.set(name, { Id: id, Name: `/${name}`, Config: { Labels: { ...labels(), ...(state.corruptLabel ? { "cyberdeck.attempt": randomUUID() } : {}) }, Image: image, User: "postgres" },
        State: { Running: false, ExitCode: runner ? state.runnerExit : 0, OOMKilled: false },
        HostConfig: { Memory: Number(value("--memory")), MemorySwap: Number(value("--memory-swap")), NanoCpus: Number(value("--cpus")) * 1e9,
          PidsLimit: Number(value("--pids-limit")), Privileged: false, ReadonlyRootfs: true, NetworkMode: value("--network"),
          PidMode: "", IpcMode: "private", CapAdd: null, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges"], PortBindings: null, Binds: null, Devices: [] },
        Mounts: runner ? [] : [{ Type: "volume", Name: value("--mount").split("src=")[1]!.split(",")[0], Destination: "/var/lib/postgresql/data" }],
        NetworkSettings: { Networks: { [value("--network")]: {}, ...(state.siblingNetwork ? { "sibling-network": {} } : {}) } } }); return id;
    }
    const found = [...objects].find(([, item]) => item.Id === args.at(-1));
    if (command === "start" && found) {
      const [name, item] = found; item.State.Running = !name.endsWith("-test"); item.State.OOMKilled = state.oom;
      item.State.Health = { Status: state.healthy ? "healthy" : "starting" }; return item.Id;
    }
    if (command === "stop" && found) { found[1].State.Running = false; return found[1].Id; }
    if (command === "logs") return "cyberdeck-integration-pass";
    if (command === "rm" || args[1] === "rm") {
      if (state.failRemove) throw new Error("engine lost while removing");
      objects.delete(found?.[0] ?? args.at(-1)!); return "";
    }
    throw new Error(`Unexpected command ${command}`);
  });
  return { run, objects, state };
}
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "integration-executor-")); roots.push(directory);
  const fake = fakeEngine();
  const admission: ResourceAdmissionPort = { request: vi.fn(async (input: ResourceRequest) => ({ state: "admitted" as const, reservationId: "reserved", demand: input.demand })),
    cancel: vi.fn(async () => {}), release: vi.fn(async () => {}) };
  const authorize = vi.fn(async () => ({ installationId: "installation", familyId: "canonical-family" }));
  const backend = new IntegrationServiceExecutor({ client: new OrbStackClient("unix:///tmp/integration-test.sock", fake.run),
    admission, image, evidenceDirectory: directory, authorize, now: () => fake.state.tick, pause: async ms => { fake.state.tick += ms; } });
  return { backend, admission, authorize, directory, ...fake };
}
describe("broker-owned integration services", () => {
  it("runs the accounted fixed SQL recipe and preserves evidence before selective teardown", async () => {
    const f = await setup(), input = request();
    const result = await f.backend.run(input);
    expect(result).toMatchObject({ state: "completed", outcome: "verified-pass", cleanupComplete: true });
    expect(f.admission.request).toHaveBeenCalledWith(expect.objectContaining({ owner: expect.objectContaining({ familyId: "canonical-family", kind: "service" }),
      demand: expect.objectContaining({ memoryBytes: 640 * 1024 ** 2, pidLimit: 128 }) }));
    expect(f.objects.size).toBe(0);
    const manifest = JSON.parse(await readFile(join(f.directory, `${integrationNames(input).key}.json`), "utf8"));
    expect(manifest.observations).toHaveLength(2); expect(manifest.cleanupComplete).toBe(true);
    const creates = f.run.mock.calls.map(([args]) => args).filter(args => args[2] === "create");
    expect(creates).toHaveLength(2);
    for (const args of creates) {
      expect(args).toContain("--read-only"); expect(args).toContain("--pids-limit"); expect(args).toContain("--memory-swap");
      expect(args).not.toContain("--publish"); expect(args.join(" ")).not.toContain("docker.sock");
    }
    expect(creates[1]?.join(" ")).toContain("rollback mismatch");
    const credentials = creates[0]!.find(s => s.startsWith("POSTGRES_PASSWORD="))!.slice("POSTGRES_PASSWORD=".length);
    expect(JSON.stringify(manifest)).not.toContain(credentials);
    expect(f.admission.release).toHaveBeenCalledTimes(1);
    const resource = vi.mocked(f.admission.request).mock.calls[0]![0];
    const held = { request: resource, reservationId: "reserved" } as ResourceReservation;
    const evidence = vi.mocked(f.admission.release).mock.calls[0]![0].terminationEvidenceId;
    expect(await f.backend.verifyTermination(held, evidence)).toBe(true);
    expect(await f.backend.verifyTermination({ ...held, reservationId: "sibling" }, evidence)).toBe(false);
    expect(await f.backend.verifyTermination(held, "wrong-hash")).toBe(false);
  });
  it("refuses unpinned images and injected engine authority before touching Docker", async () => {
    const f = await setup();
    expect(() => new IntegrationServiceExecutor({ client: new OrbStackClient("unix:///tmp/integration-test.sock", f.run), admission: f.admission,
      image: "postgres:latest", evidenceDirectory: f.directory, authorize: f.authorize })).toThrow("INTEGRATION_IMAGE_NOT_PINNED");
    await expect(f.backend.run({ ...request(), network: "host", command: ["docker", "ps"] } as IntegrationServiceRequest)).rejects.toThrow();
    await expect(f.backend.run({ ...request(), attemptId: "../../foreign" })).rejects.toThrow();
    expect(f.run).not.toHaveBeenCalled(); expect(f.authorize).not.toHaveBeenCalled();
  });
  it("refuses an unexpected sibling network before the service starts", async () => {
    const f = await setup(); f.state.siblingNetwork = true;
    expect(await f.backend.run(request())).toMatchObject({ outcome: "infrastructure-error", cleanupComplete: true });
    expect(f.run.mock.calls.some(([args]) => args[2] === "start")).toBe(false);
  });
  it("issues distinct credentials and isolated endpoints for sibling runs", async () => {
    const f = await setup(), first = request(), second = { ...first, attemptId: randomUUID() };
    await f.backend.run(first); await f.backend.run(second);
    const services = f.run.mock.calls.map(([args]) => args).filter(args => args[2] === "create" && args.some(s => s.startsWith("POSTGRES_PASSWORD=")));
    expect(services).toHaveLength(2);
    expect(services[0]!.find(s => s.startsWith("POSTGRES_PASSWORD="))).not.toBe(services[1]!.find(s => s.startsWith("POSTGRES_PASSWORD=")));
    expect(integrationNames(first).network).not.toBe(integrationNames(second).network);
  });
  it("honors capacity queue and cancellation without provisioning", async () => {
    const f = await setup(), input = request();
    vi.mocked(f.admission.request).mockResolvedValue({ state: "waiting-capacity", reason: "reserved-capacity", queuedAt: new Date().toISOString() });
    expect(await f.backend.run(input)).toMatchObject({ state: "waiting-capacity" });
    expect(f.run).not.toHaveBeenCalled();
    await f.backend.recover(input);
    expect(f.admission.cancel).toHaveBeenCalledWith(integrationNames(input).key);
    expect(f.admission.release).not.toHaveBeenCalled();
  });
  it.each(["corruptNetwork", "corruptLabel"] as const)("retains reservation on malicious %s ownership/boundary", async field => {
    const f = await setup(); f.state[field] = true;
    expect(await f.backend.run(request())).toMatchObject({ outcome: "infrastructure-error", cleanupComplete: false });
    expect(f.admission.release).not.toHaveBeenCalled();
    expect(f.run.mock.calls.some(([args]) => args[2] === "start")).toBe(false);
  });
  it("retains capacity while teardown is incomplete and recovers the exact run after restart", async () => {
    const f = await setup(), input = request(); f.state.failRemove = true;
    expect(await f.backend.run(input)).toMatchObject({ cleanupComplete: false });
    expect(f.admission.release).not.toHaveBeenCalled();
    f.state.unavailable = true;
    expect(await f.backend.recover(input)).toMatchObject({ cleanupComplete: false });
    expect(f.admission.release).not.toHaveBeenCalled();
    f.state.unavailable = false; f.state.failRemove = false;
    expect(await f.backend.recover(input)).toMatchObject({ cleanupComplete: true });
    expect(f.objects.size).toBe(0); expect(f.admission.release).toHaveBeenCalledTimes(1);
  });
  it("does not recover a sibling attempt or reveal its credentials", async () => {
    const f = await setup(), input = request(); f.state.failRemove = true;
    await f.backend.run(input); const count = f.run.mock.calls.length;
    await expect(f.backend.recover({ ...input, attemptId: randomUUID() })).rejects.toThrow("INTEGRATION_RECOVERY_UNKNOWN");
    expect(f.run.mock.calls).toHaveLength(count);
    const privateManifest = JSON.parse(await readFile(join(f.directory, `${integrationNames(input).key}.credentials.json`), "utf8"));
    expect(privateManifest.network).toBe(integrationNames(input).network);
    expect(privateManifest.password).toHaveLength(64);
  });
  it("enumerates exact persisted bindings and rejects malformed inventory before any recovery mutation", async () => {
    const f = await setup(), input = request(); f.state.failRemove = true;
    await f.backend.run(input); f.state.failRemove = false;
    const malformed = join(f.directory, `${"0".repeat(64)}.json`);
    await writeFile(malformed, "{}"); const count = f.run.mock.calls.length;
    await expect(f.backend.reconcileAll()).rejects.toThrow();
    expect(f.run.mock.calls).toHaveLength(count);
    await rm(malformed);
    expect(await f.backend.reconcileAll()).toEqual([{ request: input, result: expect.objectContaining({ cleanupComplete: true }) }]);
    expect(f.objects.size).toBe(0);
  });
  it("rechecks current lease authority before starting any test and cleans after revocation", async () => {
    const f = await setup(); f.authorize.mockResolvedValueOnce({ installationId: "installation", familyId: "canonical-family" }).mockRejectedValue(new Error("stale lease"));
    expect(await f.backend.run(request())).toMatchObject({ outcome: "infrastructure-error", cleanupComplete: true });
    expect(f.run.mock.calls.some(([args]) => args[2] === "create")).toBe(false);
  });
  it.each(["oom", "deadline", "test-failure", "cancel"])("classifies %s and cleans only its resources", async mode => {
    const f = await setup(), controller = new AbortController();
    f.objects.set("supabase_db_deuce", { Name: "supabase_db_deuce", Id: "foreign", State: { Running: true } });
    if (mode === "oom") f.state.oom = true;
    if (mode === "deadline") f.state.healthy = false;
    if (mode === "test-failure") f.state.runnerExit = 1;
    if (mode === "cancel") f.authorize.mockImplementation(async () => { if (f.objects.size > 1) controller.abort(); return { installationId: "installation", familyId: "canonical-family" }; });
    expect(await f.backend.run(request(), controller.signal)).toMatchObject({ cleanupComplete: true,
      outcome: mode === "cancel" ? "cancelled" : mode === "test-failure" ? "verified-fail" : "infrastructure-error" });
    expect([...f.objects.keys()]).toEqual(["supabase_db_deuce"]);
    expect(f.run.mock.calls.some(([args]) => args.includes("foreign") || args.includes("prune"))).toBe(false);
  });
});
