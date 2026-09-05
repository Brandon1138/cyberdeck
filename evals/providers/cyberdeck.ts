import type { ApiProvider, ProviderResponse } from "promptfoo";
import { runScenario } from "../harness/scenario-runner.js";
import { hardFailures } from "../assertions/invariants.js";
import { EvalModeSchema, type EvalMode } from "../assertions/evidence.js";
/** One provider, three explicit modes. Live mode still refuses without the operator's config file. */
export default class CyberdeckProvider implements ApiProvider {
  private readonly mode: EvalMode;
  constructor(options: { config?: { mode?: string } } = {}) {
    this.mode = EvalModeSchema.parse(options.config?.mode ?? "offline-scripted");
    if (this.mode === "live-container" && !process.env.CYBERDECK_LIVE_EVAL_CONFIG) throw new Error("LIVE_EVAL_REQUIRES_AUTHORIZED_CONFIG_AND_NATIVE_CAPTURE");
  }
  id(): string { return `cyberdeck:isolated-broker:${this.mode}`; }
  async callApi(prompt: string): Promise<ProviderResponse> {
    try {
      const evidence = await runScenario(prompt, this.mode), failures = hardFailures(evidence);
      return { output: JSON.stringify(evidence), ...(failures.length ? { error: failures.join(", ") } : {}) };
    } catch (error) { return { error: error instanceof Error ? error.message : "EVALUATION_HARNESS_FAILED" }; }
  }
}
