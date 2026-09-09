import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeAtomicPrivateFile } from "../../persistence/atomic-private-file.js";
import type { ExecutionRef } from "../../domain/worker-execution.js";
import type { ContainerLaunchContext } from "./container-launch-context.js";
import { OrbStackClient, containerName } from "./orbstack-client.js";

export async function prepareWorkerNetwork(client: OrbStackClient, image: string, context: ContainerLaunchContext, proxyPort: number): Promise<string> {
  if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) throw new Error("WORKER_EGRESS_PROXY_REQUIRED");
  const label = (await client.command(["image", "inspect", image, "--format", '{{index .Config.Labels "cyberdeck.network-boundary"}}'])).trim();
  if (label !== "1") throw new Error("WORKER_NETWORK_IMAGE_REQUIRED");
  const hostAddress = (await client.command(["run", "--rm", "--user", "1000:1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--read-only", "--network", "bridge", "--entrypoint", "node", image, "-e",
    'require("dns").lookup("host.docker.internal",{family:4},(e,a)=>{if(e)process.exit(1);console.log(a)})'])).trim();
  if (isIP(hostAddress) !== 4) throw new Error("WORKER_NETWORK_HOST_UNRESOLVED");
  await rm(join(context.hostCredentials, "network-ready"), { force: true });
  await writeAtomicPrivateFile(join(context.hostCredentials, "network-policy.json"), JSON.stringify({
    version: 1, nonce: randomUUID(), hostAddress, proxyPort, reportPort: Number(new URL(context.reportingUrl).port),
  }));
  return hostAddress;
}
export async function activateWorkerNetwork(client: OrbStackClient, image: string, ref: ExecutionRef, context: ContainerLaunchContext): Promise<void> {
  const policy = JSON.parse(await readFile(join(context.hostCredentials, "network-policy.json"), "utf8"));
  const helper = `${containerName(ref)}-firewall`;
  // docker start --attach is asynchronous; wait for the trusted launcher, not provider execution.
  const deadline = Date.now() + 15_000;
  while (!(await client.inspect(ref))?.State.Running) {
    if (Date.now() >= deadline) throw new Error("WORKER_NETWORK_START_TIMEOUT");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const output = await client.command(["run", "--rm", "--name", helper, "--label", `cyberdeck.network-helper=${ref.executionId}`,
    "--network", `container:${ref.backendId}`, "--user", "0:0", "--cap-drop", "ALL", "--cap-add", "NET_ADMIN",
    "--security-opt", "no-new-privileges", "--read-only", "--pids-limit", "32", "--memory", "134217728", "--cpus", "0.25",
    "--tmpfs", "/run:rw,nosuid,nodev,size=1048576",
    "--entrypoint", "node", image, "/opt/cyberdeck/firewall.mjs", String(policy.reportPort), String(policy.proxyPort), policy.hostAddress]);
  const evidence = JSON.parse(output);
  if (evidence.version !== 1 || evidence.ipv4 !== "default-drop" || evidence.ipv6 !== "default-drop") throw new Error("WORKER_NETWORK_UNVERIFIED");
  await writeAtomicPrivateFile(join(context.hostCredentials, "network-evidence.json"), JSON.stringify(evidence));
  await writeAtomicPrivateFile(join(context.hostCredentials, "network-ready"), policy.nonce);
}
