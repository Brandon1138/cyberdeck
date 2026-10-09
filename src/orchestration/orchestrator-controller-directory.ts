import { orchestratorController, type OrchestratorBinding } from "../domain/orchestrator.js";
import type { ControllerIdentity } from "../domain/worker-coordination.js";

export interface OrchestratorBindingDirectory {
  list(): Promise<OrchestratorBinding[]>;
  findBySessionId(sessionId: string): Promise<OrchestratorBinding | undefined>;
}

export interface ControllerSession {
  controllerId: string;
  familyId: string;
  /** The orchestrator session bound to this controller: the wake target and notice-file owner. */
  sessionId: string;
}

/**
 * Both directions of "which orchestrator session is this controller", from one derivation.
 *
 * Notifications are addressed to a durable controller id because leases are; wakes and notice
 * files are addressed to a session because providers are. `orchestratorController` in the domain
 * is the only derivation of the former from a binding (MIK-98), so this directory reads the
 * binding log through it rather than carrying a second rule.
 */
export class OrchestratorControllerDirectory {
  constructor(private readonly bindings: OrchestratorBindingDirectory) {}

  async listControllers(): Promise<Array<{ controller: ControllerIdentity; sessionId: string }>> {
    return (await this.bindings.list()).map((binding) => ({
      controller: orchestratorController(binding), sessionId: binding.sessionId,
    }));
  }

  async forSession(sessionId: string): Promise<ControllerSession | undefined> {
    const binding = await this.bindings.findBySessionId(sessionId);
    return binding === undefined ? undefined : describe(binding);
  }

  async forController(controllerId: string): Promise<ControllerSession | undefined> {
    for (const binding of await this.bindings.list()) {
      const described = describe(binding);
      if (described.controllerId === controllerId) return described;
    }
    return undefined;
  }
}

function describe(binding: OrchestratorBinding): ControllerSession {
  const controller = orchestratorController(binding);
  return { controllerId: controller.controllerId, familyId: controller.familyId, sessionId: binding.sessionId };
}
