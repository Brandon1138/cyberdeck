import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionRegistry } from "../src/broker/session-registry.js";
import type { RpcClient } from "../src/client/rpc-client.js";
import type { WorkerCoordinationService } from "../src/broker/worker-coordination.js";
import type { BrokerWorkerLeaseCredentialCustodian } from "../src/broker/worker-lease-credential-custodian.js";
import type { OrchestratorStore } from "../src/persistence/orchestrator-store.js";
import { ORCHESTRATOR_GRANT_CAPABILITIES, orchestratorController, type OrchestratorBinding } from "../src/domain/orchestrator.js";
import type { WorkerHandoffResult } from "../src/orchestration/worker-handoff-service.js";
import type { OrbStackClient } from "../src/runtime/execution/orbstack-client.js";
import type { SessionRecord } from "../src/domain/session.js";

/** Real canonical handoff over operator RPC; the recipient processes are explicitly scripted. */
export async function proveHandoff(input: {
  registry: SessionRegistry; rpc: RpcClient; coordination: WorkerCoordinationService;
  credentials: BrokerWorkerLeaseCredentialCustodian; orchestrators: OrchestratorStore;
  worker: SessionRecord; client: OrbStackClient; evidence: string;
}): Promise<void> {
  const bindings: OrchestratorBinding[] = [];
  try {
    for (let i = 0; i < 2; i++) {
      const session = await input.registry.start({ provider: "codex", model: "scripted-fixture", kind: "orchestrator",
        executor: "host", cwd: input.worker.cwd, sandbox: "read-only", detached: true });
      const now = new Date().toISOString(), scope = { kind: "fleet" as const };
      const binding: OrchestratorBinding = { key: i === 0 ? "fleet" : `fleet:peer:${session.id}`,
        kind: i === 0 ? "primary" : "peer", sessionId: session.id, provider: "codex", cwd: session.cwd,
        sandbox: "read-only", scope, grant: { subjectSessionId: session.id, scope, capabilities: [...ORCHESTRATOR_GRANT_CAPABILITIES] },
        createdAt: now, updatedAt: now };
      bindings.push(binding); await input.orchestrators.put(binding);
    }
    const [origin, recipient] = bindings as [OrchestratorBinding, OrchestratorBinding];
    const ref = structuredClone(input.worker.execution!);
    const first = await input.rpc.request<WorkerHandoffResult>("fleet.workerHandoff", {
      recipientSessionId: origin.sessionId, workerIds: [input.worker.id], directive: "Own the scripted proof worker",
    });
    if (!first.committed) throw new Error("INITIAL_HANDOFF_FAILED");
    const controller = orchestratorController(origin);
    const old = input.credentials.get(controller.controllerId, input.worker.id)!;
    const before = await input.client.inspect(ref);
    const transferred = await input.rpc.request<WorkerHandoffResult>("fleet.workerHandoff", {
      recipientSessionId: recipient.sessionId, workerIds: [input.worker.id], directive: "Continue in the same execution environment",
    });
    const stale = await input.coordination.renew({ mutationId: randomUUID(), actor: controller, controller,
      selector: { scope: "single", subjectId: input.worker.id }, leaseTokens: { [input.worker.id]: old.leaseToken }, reason: "prove stale fencing" });
    const after = await input.client.inspect(ref);
    const preserved = JSON.stringify(input.registry.get(input.worker.id).execution) === JSON.stringify(ref)
      && before?.Id === after?.Id && after?.State.Running === true;
    const fenced = stale.outcomes.length === 1 && stale.outcomes[0]?.code === "OWNERSHIP_LOST";
    const recipientMatches = input.coordination.getSubject(input.worker.id)?.lease.controller?.controllerId === orchestratorController(recipient).controllerId;
    // Persist only verdicts and non-secret handoff receipts; lease tokens never enter evidence.
    await writeFile(join(input.evidence, "handoff.json"), JSON.stringify({ first, transferred, preserved, fenced, recipientMatches,
      executionId: ref.executionId, containerId: after?.Id }), { mode: 0o600 });
    if (!transferred.committed || !preserved || !fenced || !recipientMatches) throw new Error("HANDOFF_PROOF_FAILED");
  } finally { for (const binding of bindings) await input.registry.stop(binding.sessionId); }
}
