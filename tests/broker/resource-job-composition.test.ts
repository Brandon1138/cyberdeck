import { randomUUID } from "node:crypto";
import { expect, test, vi } from "vitest";
import { composeJobDispatchAdapters } from "../../src/broker/main.js";
import { DispatchRequestSchema } from "../../src/domain/dispatch.js";
import type { ResourceJobLaunchPort } from "../../src/orchestration/resource-job-launch.js";

function fixture(resourceLaunch?: ResourceJobLaunchPort, containerDefault = false) {
  // Every provider must reach admission before it can prepare a lease or spawn a process.
  const context = { leases: { acquire: vi.fn(() => { throw new Error("PREPARE_BYPASSED_ADMISSION"); }) }, artifacts: {},
    resourceManaged: true, ...(resourceLaunch ? { resourceLaunch } : {}),
    ...(containerDefault ? { executionPolicy: { defaultExecutor: "orbstack-container", hostProfile: "host-compatible", containerProfile: "ordinary" } } : {}) };
  return composeJobDispatchAdapters(context as unknown as Parameters<typeof composeJobDispatchAdapters>[0]);
}
test("all broker-composed job providers require and invoke the same admission port before preparation", async () => {
  const start = vi.fn(async () => { throw new Error("CAPACITY_WAIT_TEST"); });
  const adapters = fixture({ start, cancelStart: () => false });
  expect(adapters.map(a => a.provider)).toEqual(["codex", "claude", "cursor", "antigravity"]);
  for (const adapter of adapters) {
    const request = DispatchRequestSchema.parse({ jobId: randomUUID(), correlationId: randomUUID(),
      request: { provider: adapter.provider, cwd: "/tmp/never-launched", sandbox: "workspace-write", instruction: "inspect" } });
    await expect(adapter.dispatch(request)).rejects.toThrow("CAPACITY_WAIT_TEST");
    expect(start).toHaveBeenLastCalledWith(request, expect.any(Function));
  }
  expect(start).toHaveBeenCalledTimes(4);
});
test("managed job composition refuses every provider when admission is absent", async () => {
  for (const adapter of fixture()) await expect(adapter.dispatch(DispatchRequestSchema.parse({
    jobId: randomUUID(), correlationId: randomUUID(), request: { provider: adapter.provider,
      cwd: "/tmp/never-launched", sandbox: "read-only", instruction: "inspect" },
  }))).rejects.toThrow("RESOURCE_JOB_EXECUTION_UNSUPPORTED");
});
test("an admitted native job never silently substitutes for a configured container default", async () => {
  const start = vi.fn(async () => { throw new Error("unexpected admission"); });
  for (const adapter of fixture({ start, cancelStart: () => false }, true)) await expect(adapter.dispatch(DispatchRequestSchema.parse({
    jobId: randomUUID(), correlationId: randomUUID(), request: { provider: adapter.provider,
      cwd: "/tmp/never-launched", sandbox: "read-only", instruction: "inspect" },
  }))).rejects.toThrow("JOB_EXECUTOR_UNSUPPORTED");
  expect(start).not.toHaveBeenCalled();
});
