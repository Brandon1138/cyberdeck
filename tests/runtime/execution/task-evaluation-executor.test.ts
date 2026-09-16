import { afterEach, expect, test } from "vitest";
import { rm, readFile, writeFile, symlink } from "node:fs/promises";
import { fixture } from "./task-evaluation-executor-fixture.js";
import { EvaluatorFiles } from "../../../src/runtime/execution/task-evaluation-executor-state.js";

const contexts: Awaited<ReturnType<typeof fixture>>[] = [];
async function setup(options?: Parameters<typeof fixture>[0]) { const f = await fixture(options); contexts.push(f); return f; }
afterEach(async () => { for (const f of contexts.splice(0)) { f.store.close(); await rm(f.directory, { recursive: true, force: true }); } });

test("reconciliation and admission gate all container creation; pinned fixed profile excludes host capabilities", async () => {
  const f = await setup();
  expect((await f.executor.runNext()).reason).toBe("reconciliation-required");
  await f.executor.reconcile(); f.control.waiting = true;
  expect((await f.executor.runNext()).state).toBe("waiting"); expect(f.calls).toEqual([]);
  f.control.waiting = false;
  expect((await f.executor.runNext()).state).toBe("finished");
  expect(f.store.result(f.key)?.disposition).toBe("verified-pass"); expect(f.releases).toHaveLength(1);
  expect(f.reservations[0]!.request.owner.familyId).toBe("historical-family");
  expect(f.reservations[0]!.request.demand.memoryBytes).toBe(768 * 1024 ** 2);
  const args = f.calls.find(a => a[0] === "create")!;
  expect(args).toContain("--read-only"); expect(args).toContain("none"); expect(args).toContain("never");
  expect(args.join(" ")).not.toMatch(/docker.sock|credential|API_KEY|--privileged|--volume/);
  const state = (await f.files.inventory())[0]!.state;
  expect(await readFile(f.files.path(state.runId, "input.json"), "utf8")).not.toContain(state.claim.token);
  expect(f.store.health()).toMatchObject({ pending: 0, pinned: 0, unacknowledged: 0 });
});

test.each([
  [{ passed: false }, "verified-fail"], [{ complete: false }, "unverified"], [{ source: "worker" }, "unverified"],
  [{ checks: [] }, "unverified"], [{ event: { kind: "profile.settled", outcome: "unknown" } }, "infrastructure-error"],
  [{ event: { kind: "profile.settled", outcome: "succeeded" }, checks: ["missing"] }, "unverified"],
  [{ event: { outcome: "cancelled" } }, "cancelled"],
] as const)("independent host grading handles %j as %s", async (options, disposition) => {
  const f = await setup({ ...options, ...("checks" in options ? { checks: [...options.checks] } : {}) });
  await f.executor.reconcile(); await f.executor.runNext(); expect(f.store.result(f.key)?.disposition).toBe(disposition);
});

test.each(["forgedOutput", "forgedHash", "malformed", "oversized", "oom"] as const)("%s cannot yield a pass", async mode => {
  const f = await setup(); f.control[mode] = true; await f.executor.reconcile(); await f.executor.runNext();
  expect(f.store.result(f.key)?.disposition).toBe(mode === "forgedOutput" ? "unverified" : "infrastructure-error");
  expect(f.releases).toHaveLength(1);
});

test.each(["network", "privileged", "writable"])("rejects %s boundary mutation before start and cleans owned container", async mode => {
  const f = await setup(); f.control.tamper = c => {
    if (mode === "network") c.HostConfig.NetworkMode = "host";
    if (mode === "privileged") c.HostConfig.Privileged = true;
    if (mode === "writable") c.Mounts[0]!.RW = true;
  };
  await f.executor.reconcile(); await f.executor.runNext();
  expect(f.calls.some(a => a[0] === "start")).toBe(false); expect(f.store.result(f.key)?.disposition).toBe("infrastructure-error");
});

test("foreign ownership is neither started nor removed; reservation remains held", async () => {
  const f = await setup(); f.control.tamper = c => { c.Config.Labels!["cyberdeck.installation"] = "foreign"; };
  await f.executor.reconcile(); expect((await f.executor.runNext()).state).toBe("blocked");
  expect(f.calls.some(a => ["start", "stop", "rm"].includes(a[0]!))).toBe(false); expect(f.releases).toEqual([]);
});

test("timeout terminates and confirms the cgroup before releasing", async () => {
  const f = await setup(); f.control.stuck = true; await f.executor.reconcile(); await f.executor.runNext();
  expect(f.store.result(f.key)).toMatchObject({ disposition: "infrastructure-error", reason: "evaluator-timeout" });
  expect(f.calls.some(a => a[0] === "stop")).toBe(true); expect(f.releases).toHaveLength(1);
});

test.each(["removeFails", "stoppedPid"] as const)("%s retains reservation until restart reconciliation proves absence", async mode => {
  const f = await setup(); if (mode === "removeFails") f.control.removeFails = true; else f.control.stoppedPid = 123;
  await f.executor.reconcile(); expect((await f.executor.runNext()).state).toBe("blocked");
  expect(f.store.result(f.key)).toBeUndefined(); expect(f.releases).toEqual([]);
  f.control.removeFails = false; if (f.container) f.container.State.Pid = 0;
  expect((await f.restart().reconcile()).state).toBe("empty"); expect(f.releases).toHaveLength(1);
  expect(f.calls.filter(a => a[0] === "create")).toHaveLength(1);
});

test("expired capacity claim stays pending and can be reclaimed without an infrastructure grade", async () => {
  const f = await setup(); f.control.waiting = true; await f.executor.reconcile(); await f.executor.runNext();
  f.control.now = 300001; expect((await f.executor.runNext()).reason).toBe("claim-expired-reclaimable");
  expect(f.store.result(f.key)).toBeUndefined(); expect(f.store.health().pending).toBe(1);
  f.control.waiting = false; await f.executor.runNext(); expect(f.store.result(f.key)?.disposition).toBe("verified-pass");
});

test("reserve-before-save crash recovers same admission identity and leaves unstarted task pending", async () => {
  const f = await setup(); f.control.waiting = true; await f.executor.reconcile(); await f.executor.runNext();
  const state = (await f.files.inventory())[0]!.state; f.control.waiting = false; await f.admission.request(state.resource);
  await f.restart().reconcile(); expect(f.reservations).toHaveLength(1); expect(f.releases).toHaveLength(1);
  expect(f.calls.some(a => a[0] === "create")).toBe(false); expect(f.store.result(f.key)).toBeUndefined();
});

test("fresh verifier fails closed on daemon outage and a resurrected name", async () => {
  const f = await setup(); await f.executor.reconcile(); await f.executor.runNext();
  expect(await f.executor.verifyTermination(f.reservations[0]!, f.releases[0]!)).toBe(true);
  f.control.unavailable = true; expect(await f.executor.verifyTermination(f.reservations[0]!, f.releases[0]!)).toBe(false);
  f.control.unavailable = false;
  const state = (await f.files.inventory())[0]!.state;
  f.container = { Id: "c".repeat(64) } as NonNullable<typeof f.container>;
  expect(await f.executor.verifyTermination(f.reservations[0]!, f.releases[0]!)).toBe(false);
  expect((await f.restart().reconcile()).state).toBe("blocked");
  expect(state.released).toBe(true);
});

test("input symlink/tampering fails closed before launch", async () => {
  const f = await setup(); f.control.waiting = true; await f.executor.reconcile(); await f.executor.runNext();
  const state = (await f.files.inventory())[0]!.state, path = f.files.path(state.runId, "input.json");
  await rm(path); await symlink(f.files.path(state.runId, "state.json"), path); f.control.waiting = false;
  expect((await f.executor.runNext()).state).toBe("blocked"); expect(f.calls.some(a => a[0] === "create")).toBe(false);
});

test("durable identity corruption blocks reconciliation without Docker mutations", async () => {
  const f = await setup(); f.control.waiting = true; await f.executor.reconcile(); await f.executor.runNext();
  const state = (await f.files.inventory())[0]!.state; state.resource.owner.workloadId = "foreign";
  await writeFile(f.files.path(state.runId, "state.json"), JSON.stringify(state));
  expect((await f.restart().reconcile()).reason).toBe("EVALUATOR_STATE_MISMATCH"); expect(f.calls).toEqual([]);
});

test("result-write-before-ack restart recovers without repeating evaluation", async () => {
  const f = await setup(), acknowledge = f.store.acknowledge.bind(f.store);
  f.store.acknowledge = () => { throw new Error("simulated crash"); };
  await f.executor.reconcile(); expect((await f.executor.runNext()).state).toBe("blocked");
  expect(f.store.unacknowledged()).toHaveLength(1); expect(f.store.health().pinned).toBe(1);
  f.store.acknowledge = acknowledge;
  await f.restart().reconcile(); expect(f.store.unacknowledged()).toEqual([]); expect(f.store.health().pinned).toBe(0);
  expect(f.calls.filter(a => a[0] === "create")).toHaveLength(1);
});

test("abort after reservation never starts evaluator and still verifies removal", async () => {
  const f = await setup(), controller = new AbortController(); controller.abort();
  await f.executor.reconcile(); await f.executor.runNext(controller.signal);
  expect(f.calls.some(a => a[0] === "create")).toBe(false); expect(f.releases).toHaveLength(1);
  expect(f.store.result(f.key)?.disposition).toBe("infrastructure-error");
});

test("cleanup retry never creates another container", async () => {
  const f = await setup(); f.control.removeFails = true; await f.executor.reconcile(); await f.executor.runNext();
  f.control.removeFails = false; expect((await f.executor.runNext()).state).toBe("finished");
  expect(f.calls.filter(a => a[0] === "create")).toHaveLength(1); expect(f.releases).toHaveLength(1);
});

test("retention refuses an active run and only prunes settled evidence with fresh absence", async () => {
  const f = await setup(); f.control.waiting = true; await f.executor.reconcile(); await f.executor.runNext();
  const state = (await f.files.inventory())[0]!.state, reportPath = f.files.path(state.runId, "report.json");
  const capped = new EvaluatorFiles(f.evidence, 4 * 1024 ** 2);
  // Inflate a fixture to exercise total accounting without starting a workload.
  await writeFile(reportPath, "x".repeat(3 * 1024 ** 2));
  await expect(capped.reserveDisk(async () => true)).rejects.toThrow("RETENTION_CAP");
  state.cleanupConfirmed = state.released = state.settled = true; state.reclaimable = true; state.phase = "retained";
  await f.files.save(state);
  await expect(capped.reserveDisk(async () => false)).rejects.toThrow("RETIRED_CONTAINER_PRESENT");
  expect(await f.files.inventory()).toHaveLength(1);
  await capped.reserveDisk(async () => true); expect(await f.files.inventory()).toEqual([]);
});

test("regular-file input tampering cannot launch; unknown retention paths block pruning", async () => {
  const f = await setup(); f.control.waiting = true; await f.executor.reconcile(); await f.executor.runNext();
  const state = (await f.files.inventory())[0]!.state, path = f.files.path(state.runId, "input.json");
  await rm(path); await writeFile(path, "{}"); f.control.waiting = false;
  await f.executor.runNext(); expect(f.calls.some(a => a[0] === "create")).toBe(false);
  expect(f.store.result(f.key)?.disposition).toBe("infrastructure-error");
  await writeFile(`${f.evidence}/operator-data`, "preserve");
  await expect(f.files.reserveDisk(async () => true)).rejects.toThrow("DIRECTORY_INVALID");
  expect(await readFile(`${f.evidence}/operator-data`, "utf8")).toBe("preserve");
});

test("non-schema insertion order in a stored intent remains valid across capacity wait and restart", async () => {
  const f = await setup({ reversedIntent: true }); f.control.waiting = true;
  await f.executor.reconcile(); expect((await f.executor.runNext()).state).toBe("waiting");
  expect((await f.restart().reconcile()).state).toBe("empty");
  f.control.now = 300001; f.control.waiting = false;
  expect((await f.executor.runNext()).state).toBe("finished"); expect(f.store.result(f.key)?.disposition).toBe("verified-pass");
});
