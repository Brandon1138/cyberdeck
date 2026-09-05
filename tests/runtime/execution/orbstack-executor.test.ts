import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrbStackClient } from "../../../src/runtime/execution/orbstack-client.js";
import { OrbStackExecutor, networkProfileSupport } from "../../../src/runtime/execution/orbstack-executor.js";
import type { SessionRecord } from "../../../src/domain/session.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const image = `sha256:${"a".repeat(64)}`;
function executor(network: "egress" | "none", run = vi.fn(async () => { throw new Error("DOCKER_MUST_NOT_RUN"); })) {
  const client = new OrbStackClient("unix:///tmp/orbstack.sock", run);
  const contexts = { prepare: vi.fn(async () => { throw new Error("CONTEXT_MUST_NOT_PREPARE"); }), get: vi.fn(async () => { throw new Error("CONTEXT_UNKNOWN"); }) };
  return { run, contexts, backend: new OrbStackExecutor({ client, profile: { image, cpus: 1, memoryBytes: 256 * 1024 * 1024, slots: 1, network }, contexts, attach: () => { throw new Error("ATTACH_MUST_NOT_RUN"); }, evidenceDirectory: "/nonexistent", onFailure: () => {} }) };
}
describe("OrbStack network profiles", () => {
  it("reports the none profile as unsupported with its reason, never as a silent egress launch", async () => {
    expect(networkProfileSupport("egress")).toEqual({ supported: true });
    expect(networkProfileSupport("none").supported).toBe(false);
    const root = await mkdtemp(join(tmpdir(), "orbstack-none-")); roots.push(root);
    const { backend, run, contexts } = executor("none");
    expect(backend.support()).toMatchObject({ network: "none", supported: false });
    const id = randomUUID();
    const record: SessionRecord = { id, provider: "codex", executor: "orbstack-container", kind: "worker", cwd: root, sandbox: "read-only", detached: true,
      generation: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), executionState: "starting", attachmentState: "detached", pid: 0, exitCode: null, childIds: [] };
    await expect(backend.prepare({ record, request: { executor: "orbstack-container", profile: "ordinary" },
      identity: { brokerId: randomUUID(), executionId: randomUUID(), workerId: id, sessionId: id, generation: 1 },
      launch: { executable: "node", args: [], cwd: "/workspace", env: {}, transport: "pty" } })).rejects.toThrow("CONTAINER_NETWORK_PROFILE_UNSUPPORTED");
    expect(run).not.toHaveBeenCalled();
    expect(contexts.prepare).not.toHaveBeenCalled();
    expect(backend.slots.snapshot()).toEqual({ running: [], queued: [], capacity: 1 });
  });
  it("keeps the egress profile supported", () => {
    expect(executor("egress").backend.support()).toEqual({ network: "egress", supported: true });
  });
});
