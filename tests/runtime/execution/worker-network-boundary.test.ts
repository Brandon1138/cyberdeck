import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { prepareWorkerNetwork, activateWorkerNetwork } from "../../../src/runtime/execution/worker-network-boundary.js";
import { OrbStackClient } from "../../../src/runtime/execution/orbstack-client.js";
import type { ContainerLaunchContext } from "../../../src/runtime/execution/container-launch-context.js";
import type { ExecutionRef } from "../../../src/domain/worker-execution.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "network-gate-")); roots.push(root);
  await mkdir(join(root, "credentials"));
  const context = { hostCredentials: join(root, "credentials"), reportingUrl: "http://host.docker.internal:1234/v1/report" } as ContainerLaunchContext;
  const client = new OrbStackClient("unix:///tmp/fixture");
  const command = vi.spyOn(client, "command").mockImplementation(async args => args[0] === "image" ? "1" : "0.250.250.254");
  const ref = { brokerId: randomUUID(), executionId: randomUUID(), workerId: randomUUID(), backendId: "a".repeat(64), generation: 1 } as ExecutionRef;
  vi.spyOn(client, "inspect").mockResolvedValue({ State: { Running: true } } as never);
  return { context, client, command, ref };
}
it("removes stale activation on every prepare and requires an explicitly capable image and proxy", async () => {
  const { context, client, command } = await fixture();
  await expect(prepareWorkerNetwork(client, "image", context, 0)).rejects.toThrow("WORKER_EGRESS_PROXY_REQUIRED");
  expect(command).not.toHaveBeenCalled();
  await writeFile(join(context.hostCredentials, "network-ready"), "stale");
  await prepareWorkerNetwork(client, "image", context, 2345);
  await expect(readFile(join(context.hostCredentials, "network-ready"))).rejects.toMatchObject({ code: "ENOENT" });
  command.mockResolvedValue("old-image");
  await expect(prepareWorkerNetwork(client, "image", context, 2345)).rejects.toThrow("WORKER_NETWORK_IMAGE_REQUIRED");
});
it("opens the launch gate only after the isolated firewall helper succeeds; failures leave it closed", async () => {
  const { context, client, command, ref } = await fixture();
  await prepareWorkerNetwork(client, "image", context, 2345);
  command.mockRejectedValueOnce(new Error("FIREWALL_UNAVAILABLE"));
  await expect(activateWorkerNetwork(client, "image", ref, context)).rejects.toThrow("FIREWALL_UNAVAILABLE");
  await expect(readFile(join(context.hostCredentials, "network-ready"))).rejects.toMatchObject({ code: "ENOENT" });
  command.mockResolvedValue(JSON.stringify({ version: 1, ipv4: "default-drop", ipv6: "default-drop" }));
  await activateWorkerNetwork(client, "image", ref, context);
  const args = command.mock.calls.at(-1)![0];
  expect(args).toContain(`container:${ref.backendId}`); expect(args).toContain("NET_ADMIN");
  expect(args).toContain("--read-only"); expect(args).not.toContain("--privileged"); expect(args).not.toContain("--mount");
  const policy = JSON.parse(await readFile(join(context.hostCredentials, "network-policy.json"), "utf8"));
  expect(await readFile(join(context.hostCredentials, "network-ready"), "utf8")).toBe(policy.nonce);
});
