import type { ProviderId } from "../domain/session.js";
import {
  CliProviderModelProbe,
  type ProviderModelListing,
  type ProviderModelProbe,
} from "../orchestration/worker-capability-catalog.js";
import { CodexOrchestratorModelProbe } from "./codex-orchestrator-model-probe.js";

/**
 * Orchestrator model discovery for the two providers that can host an Orc and can be asked.
 *
 * Codex stays on its first-party probe, because a worker listing may be routed through a proxy.
 * Cursor asks `agent models` through the same parser workers use. Claude has no listing command,
 * and Antigravity cannot host the MCP server, so neither is spawned.
 */
export class OrchestratorModelProbe implements ProviderModelProbe {
  private readonly codexProbe: ProviderModelProbe;
  private readonly cursorProbe: ProviderModelProbe;

  constructor(
    codexProbe?: ProviderModelProbe,
    cursorProbe?: ProviderModelProbe,
  ) {
    this.codexProbe = codexProbe ?? new CodexOrchestratorModelProbe();
    this.cursorProbe = cursorProbe ?? new CliProviderModelProbe();
  }

  async list(provider: ProviderId): Promise<ProviderModelListing> {
    if (provider === "codex") return this.codexProbe.list(provider);
    if (provider === "cursor") return this.cursorProbe.list(provider);
    return { unavailable: `${provider} has no orchestrator model discovery` };
  }
}
