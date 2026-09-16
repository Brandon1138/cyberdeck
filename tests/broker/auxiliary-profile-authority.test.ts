import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { auxiliaryProfileAuthorizer } from "../../src/broker/auxiliary-profile-authority.js";
import { WorkerCoordinationService } from "../../src/broker/worker-coordination.js";
import { BrokerWorkerLeaseCredentialCustodian } from "../../src/broker/worker-lease-credential-custodian.js";
import { WorkerCoordinationStore } from "../../src/persistence/worker-coordination-store.js";
import type { SessionRecord } from "../../src/domain/session.js";
import type { InstructionRecord } from "../../src/domain/instruction.js";

const paths: string[] = [];
afterEach(async () => { for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), "auxiliary-authority-")); paths.push(path);
  let now = Date.now();
  const coordination = new WorkerCoordinationService({ store: new WorkerCoordinationStore(path), now: () => new Date(now).toISOString() });
  await coordination.initialize();
  const workerId = randomUUID(), brokerId = randomUUID(), executionId = randomUUID();
  const controller = { controllerId: "canonical-peer", familyId: "canonical-family", scope: { kind: "session-family" as const, scopeId: "scope" } };
  const registered = await coordination.registerSubject({ mutationId: randomUUID(), actor: controller, controller,
    subjectId: workerId, origin: { creatorControllerId: controller.controllerId, taskId: workerId, threadId: workerId, createdAt: new Date(now).toISOString() },
    resources: { sessionId: workerId, worktreePath: path, transcriptRef: "transcript", resultStateRef: "result", eventStreamId: "events" },
    lifecycle: "working", reason: "fixture" });
  const credential = registered.outcomes[0]!;
  const credentials = new BrokerWorkerLeaseCredentialCustodian();
  credentials.set(controller.controllerId, workerId, { leaseToken: credential.leaseToken!, leaseVersion: credential.leaseVersion! });
  let session = { id: workerId, kind: "worker", executor: "orbstack-container", generation: 2, executionState: "active",
    sandbox: "workspace-write", cwd: path, execution: { brokerId, workerId, sessionId: workerId, executionId, generation: 2,
      executor: "orbstack-container", workspaceId: "private-clone" } } as SessionRecord;
  let instructions: InstructionRecord[] = [];
  const binding = { workerId, executionId, generation: 2 }, request = { requestId: randomUUID(), attemptId: workerId,
    profile: "integration" as const, recipeId: "postgres-fixture-v1" };
  const authorize = auxiliaryProfileAuthorizer({ brokerId, coordination, credentials, session: () => session, instructions: async () => instructions });
  return { authorize, binding, request, coordination, controller, credentials, credential,
    advance: () => { now += 86400000; }, change: (patch: Partial<SessionRecord>) => { session = { ...session, ...patch }; },
    instructions: (rows: InstructionRecord[]) => { instructions = rows; } };
}
test("uses canonical peer controller and the existing token/version/expiry predicate", async () => {
  const f = await fixture();
  expect(await f.authorize(f.binding, f.request)).toMatchObject({ familyId: "canonical-family", leaseVersion: f.credential.leaseVersion });
  f.credentials.set(f.controller.controllerId, f.binding.workerId, { leaseVersion: f.credential.leaseVersion!, leaseToken: "invalid" });
  await expect(f.authorize(f.binding, f.request)).rejects.toThrow("lease is no longer current");
  f.credentials.set(f.controller.controllerId, f.binding.workerId, { leaseVersion: f.credential.leaseVersion!, leaseToken: f.credential.leaseToken! });
  f.advance(); await expect(f.authorize(f.binding, f.request)).rejects.toThrow("lease is no longer current");
});
test("refuses stale version/generation and read-only policy without substituting a controller", async () => {
  const f = await fixture();
  await expect(f.authorize(f.binding, f.request, f.credential.leaseVersion! + 1)).rejects.toThrow("AUXILIARY_LEASE_STALE");
  f.change({ sandbox: "read-only" }); await expect(f.authorize(f.binding, f.request)).rejects.toThrow("AUXILIARY_WRITE_POLICY_REFUSED");
  f.change({ sandbox: "workspace-write", generation: 3 }); await expect(f.authorize(f.binding, f.request)).rejects.toThrow("AUXILIARY_EXECUTION_STALE");
});
test("requires a current canonical attempt and never binds a random or completed instruction", async () => {
  const f = await fixture(), id = randomUUID(), request = { ...f.request, attemptId: id };
  await expect(f.authorize(f.binding, request)).rejects.toThrow("AUXILIARY_ATTEMPT_STALE");
  const instruction = { id, attemptGeneration: 2, attemptExecutionId: f.binding.executionId, status: "submitted" } as InstructionRecord;
  f.instructions([instruction]); expect(await f.authorize(f.binding, request)).toMatchObject({ writeAllowed: true });
  await expect(f.authorize(f.binding, f.request)).rejects.toThrow("AUXILIARY_ATTEMPT_AMBIGUOUS");
  f.instructions([{ ...instruction, status: "completed" }]);
  await expect(f.authorize(f.binding, request)).rejects.toThrow("AUXILIARY_ATTEMPT_STALE");
});
