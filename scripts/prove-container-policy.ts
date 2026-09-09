import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { brokerFixture, eventually } from "../evals/harness/broker-fixture.js";
import { ModalAnswerPolicy } from "../src/orchestration/modal-answer-policy.js";
import { ModalAnswerGrantStore } from "../src/persistence/modal-answer-grant-store.js";
import { GitWorkspaceProbe } from "../src/orchestration/git-workspace-probe.js";
import { trustedGit } from "../src/runtime/execution/trusted-git.js";

// Scripted processes only: exercise the production private-home trust path, source grant
// resolution/revocation, resume generation, and queued cancellation on real OrbStack.
const evidence = await mkdtemp(join(tmpdir(), "cyberdeck-policy-proof-"));
console.log(JSON.stringify({ evidence }));
const commit = (await trustedGit(process.cwd(), ["rev-parse", "HEAD"])).toString().trim();
const dirty = Boolean((await trustedGit(process.cwd(), ["status", "--porcelain"])).length);
const results = [];
for (const provider of ["claude", "codex"] as const) {
  const root = join(evidence, provider), grants = new ModalAnswerGrantStore(join(root, "grants"));
  let broker: Awaited<ReturnType<typeof brokerFixture>> | undefined;
  const policy = new ModalAnswerPolicy({ grants, probe: new GitWorkspaceProbe(),
    resolveSessionCwd: (id, cwd) => broker!.container!.runtime.modalCwd(id, cwd) });
  broker = await brokerFixture(root, { mode: "container-scripted", scriptedProvider: provider,
    allowsWorkspaceTrust: (source) => policy.allowsWorkspaceTrust(source) });
  const container = broker.container!;
  try {
    const home = (id: string) => join(broker!.state, "containers", "provider-state", id);
    const trust = provider === "claude" ? ".claude.json" : ".codex/config.toml";
    await assert.rejects(readFile(join(home(broker.worker.id), trust)), { code: "ENOENT" });
    await grants.set(broker.source, true);
    const second = await broker.startWorker();
    const privateTrust = await readFile(join(home(second.id), trust), "utf8");
    assert.ok(privateTrust.includes("/workspace"));
    assert.ok(!privateTrust.includes(broker.source));
    // Check the actual guest mount sees that exact file, with no provider authentication.
    const guestTrust = await container.client.command(["exec", second.execution!.backendId!, "cat", `/home/worker/${trust}`]);
    assert.equal(guestTrust, privateTrust);
    const input = { cwd: second.cwd, sessionId: second.id, kind: "workspace-trust" as const };
    assert.equal((await policy.evaluate(input)).allowed, true);
    for (const kind of ["login", "unknown", "permission-approval"] as const) assert.equal((await policy.evaluate({ ...input, kind })).allowed, false);
    await grants.set(broker.source, false);
    assert.equal((await policy.evaluate(input)).allowed, false);
    // Both slots occupied: cancellation must remove the third waiter without stopping either.
    const pending = broker.startWorker().then(() => "unexpected-start", (error: Error) => error.message);
    await eventually(() => container.runtime.health().slots?.queued.length === 1, "NO_QUEUED_WORKER", 15000);
    const queued = container.runtime.health().records.find((record) => record.phase === "preparing")!;
    assert.equal(container.executions.cancelStart(queued.ref.sessionId), true);
    assert.equal(await pending, "EXECUTION_QUEUE_CANCELLED");
    assert.equal(container.runtime.health().slots?.running.length, 2);
    assert.equal(container.runtime.health().slots?.queued.length, 0);
    // Resume with a revoked grant preserves the provider's prior choice, without widening it.
    await broker.registry.stop(second.id);
    await eventually(() => broker!.registry.get(second.id).exitCode !== null, "STOP_UNCONFIRMED", 15000);
    const resumed = await broker.registry.resume(second.id);
    assert.equal(resumed.generation, 2);
    assert.equal(resumed.execution?.executionId, second.execution!.executionId);
    assert.equal(resumed.cwd, second.cwd);
    assert.equal(await readFile(join(home(second.id), trust), "utf8"), privateTrust);
    assert.equal((await policy.evaluate(input)).allowed, false);
    results.push({ provider, image: container.image, trustInPrivateGuest: true, grantRevocation: true,
      operatorOnly: true, cancelledQueuedWorker: true, resumedGeneration: resumed.generation });
  } finally { await broker.close(); }
  const remaining = (await container.client.command(["ps", "-a", "--filter", `label=cyberdeck.broker=${broker.brokerId}`, "--format", "{{.ID}}"])).trim();
  assert.equal(remaining, "");
}
await writeFile(join(evidence, "result.json"), JSON.stringify({ commit, dirty, results, cleanup: "absent" }, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ evidence, results, cleanup: "absent" }));
