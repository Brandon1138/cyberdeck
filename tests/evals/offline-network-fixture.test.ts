import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("../../evals/harness/broker-fixture.js", () => ({
  brokerFixture: async (root: string) => ({ brokerId: randomUUID(), cwd: root,
    worker: { id: randomUUID(), sandbox: "read-only", provider: "scripted" }, close: async () => {} }),
}));
import { backendScenario } from "../../evals/harness/runtime-scenarios.js";

const paths: string[] = [];
afterEach(async () => { for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true }); });
test.each(["oom", "cross-worker"] as const)("offline %s prepares the production network boundary without launching a guest", async scenario => {
  const root = await mkdtemp(join(tmpdir(), "offline-network-fixture-")); paths.push(root);
  const result = await backendScenario(root, scenario);
  expect(Object.values(result.checks).every(Boolean)).toBe(true);
  if (!("commands" in result.facts)) throw new Error("OFFLINE_ENGINE_FACTS_REQUIRED");
  expect(result.facts.fixtureMode).toBe("scripted-engine-no-containers");
  const { commands, records, networkPolicies } = result.facts;
  expect(commands.filter(command => command[0] === "image")).toHaveLength(2);
  const helpers = commands.filter(command => command[0] === "run");
  expect(helpers).toHaveLength(2);
  for (const helper of helpers) {
    const value = (flag: string) => helper[helper.indexOf(flag) + 1];
    expect(value("--user")).toBe("1000:1000");
    expect(value("--cap-drop")).toBe("ALL");
    expect(value("--memory")).toBe("134217728");
    expect(value("--memory-swap")).toBe("134217728");
    expect(value("--pids-limit")).toBe("32");
    expect(value("--cpus")).toBe("0.25");
    expect(helper).toContain("--read-only"); expect(helper).toContain("--rm");
    expect(helper).toContain(`cyberdeck.broker=${result.brokerId}`);
    expect(helper.some(arg => arg.startsWith("cyberdeck.network-helper="))).toBe(true);
    expect(helper).not.toContain("--privileged"); expect(helper).not.toContain("--cap-add");
  }
  expect(commands.some(command => command[0] === "start")).toBe(false);
  expect(networkPolicies).toHaveLength(2);
  expect(new Set(networkPolicies.map(policy => policy.nonce)).size).toBe(2);
  for (const record of records) {
    expect(record.HostConfig.NetworkMode).toBe("bridge");
    expect(record.HostConfig.ExtraHosts).toEqual(["host.docker.internal:192.0.2.1"]);
    expect(record.Mounts.find(mount => mount.Destination === "/workspace")?.RW).toBe(false);
    const credentials = record.Mounts.find(mount => mount.Destination === "/run/credentials")!;
    expect(credentials.RW).toBe(false);
    const launch = JSON.parse(await readFile(join(credentials.Source, "launch.json"), "utf8"));
    expect(launch.networkRestricted).toBe(true);
    await expect(readFile(join(credentials.Source, "network-ready"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(dirname(credentials.Source)).toMatch(root);
  }
});
