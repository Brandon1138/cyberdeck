import type { ProviderId } from "../domain/session.js";
import {
  parseCodexModelCatalog, runListingCommand, type ProviderModelListing, type ProviderModelProbe,
} from "../orchestration/worker-capability-catalog.js";
import { CODEX_ORCHESTRATOR_CONFIG_ARGS } from "./codex-orchestrator-config.js";
import { buildProviderChildEnvironment } from "./launch-environment.js";

/** Separate discovery context: workers may use a proxy, while remote orchestrators use OpenAI. */
export class CodexOrchestratorModelProbe implements ProviderModelProbe {
  constructor(private readonly run: typeof runListingCommand = runListingCommand) {}

  async list(provider: ProviderId): Promise<ProviderModelListing> {
    if (provider !== "codex") return { unavailable: "Only Codex orchestrator discovery is configured" };
    try {
      const { stdout } = await this.run("codex", ["debug", "models", ...CODEX_ORCHESTRATOR_CONFIG_ARGS], {
        cwd: "/",
        env: buildProviderChildEnvironment({
          source: process.env,
          provider: "codex",
          cwd: "/",
          terminal: "pipe",
          identity: { role: "orchestrator" },
        }),
        timeout: 10_000,
        maxBuffer: 8 * 1024 * 1024,
      });
      const models = parseCodexModelCatalog(stdout);
      return models.length === 0
        ? { unavailable: "First-party Codex model discovery printed no recognizable model ids" }
        : { models };
    } catch (error) {
      return { unavailable: `First-party Codex model discovery failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
}
