import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile, readFile, rm, lstat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { BrokerContainerContexts } from "../../../src/runtime/execution/broker-container-contexts.js";
import { WorkerGateway } from "../../../src/broker/worker-gateway.js";
import { trustedGit } from "../../../src/runtime/execution/trusted-git.js";
import { contentHash } from "../../../src/runtime/execution/workspace-manifest.js";
import type { SessionRecord } from "../../../src/domain/session.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it("prepares selected dirty input, reuses private state on resume, and retires only staged credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "broker-contexts-")); roots.push(root);
  const source = join(root, "source"), selectedKey = join(root, "selected-key"); await mkdir(source);
  await trustedGit(source, ["init", "-b", "main"]);
  await trustedGit(source, ["config", "user.name", "Fixture"]); await trustedGit(source, ["config", "user.email", "fixture@example.invalid"]);
  await writeFile(join(source, "answer.txt"), "before");
  await trustedGit(source, ["add", "."]); await trustedGit(source, ["commit", "-m", "fixture"]);
  await writeFile(join(source, "answer.txt"), "selected input", { mode: 0o600 });
  await writeFile(selectedKey, "SYNTHETIC_PROVIDER_KEY", { mode: 0o600 });
  const id = randomUUID(), identity = { brokerId: randomUUID(), workerId: id, sessionId: id, executionId: randomUUID(), generation: 1 };
  const record: SessionRecord = { id, provider: "claude", executor: "orbstack-container", kind: "worker", cwd: source, sandbox: "workspace-write", detached: true,
    generation: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), executionState: "starting", attachmentState: "detached", pid: 0, exitCode: null, childIds: [],
    workspace: { provisioning: "cyberdeck-provisioned", branch: "worker/fixture", baseRef: "HEAD", writableRoots: [], selectedInputs: [{ path: "answer.txt", action: "write", executable: false, sha256: contentHash("selected input") }] },
  };
  const gateway = new WorkerGateway({ submit: async () => { throw new Error("unused"); } }, () => true);
  const contexts = new BrokerContainerContexts(join(root, "broker"), { claude: selectedKey }, gateway, 1234);
  const input = { record, identity, request: { executor: "orbstack-container" as const, profile: "ordinary" }, launch: { executable: "claude", args: [], cwd: "/workspace", env: {} } };
  const first = await contexts.prepare(input);
  expect(record.workspace?.storage).toBe("independent-clone");
  expect(await readFile(join(first.workspace.hostPath, "answer.txt"), "utf8")).toBe("selected input");
  await writeFile(join(first.workspace.hostPath, "answer.txt"), "worker output");
  const resumed = await contexts.prepare({ ...input, identity: { ...identity, generation: 2 } });
  expect(resumed.workspace.hostPath).toBe(first.workspace.hostPath);
  expect(await readFile(join(resumed.workspace.hostPath, "answer.txt"), "utf8")).toBe("worker output");
  await contexts.release({ ...identity, generation: 2, executor: "orbstack-container", workspaceId: first.workspace.hostPath });
  await expect(lstat(first.hostCredentials)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(selectedKey, "utf8")).toBe("SYNTHETIC_PROVIDER_KEY");
  expect(await readFile(join(source, "answer.txt"), "utf8")).toBe("selected input");
  await gateway.close();
});
