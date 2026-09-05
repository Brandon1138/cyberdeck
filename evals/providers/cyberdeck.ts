import type { ApiProvider, ProviderResponse } from "promptfoo";
import { runScenario } from "../harness/scenario-runner.js";
import { hardFailures } from "../assertions/invariants.js";
export default class CyberdeckProvider implements ApiProvider {
  constructor(options: { config?: { mode?: string } } = {}) {
    if (options.config?.mode !== undefined && options.config.mode !== "offline-scripted") throw new Error("LIVE_EVAL_REQUIRES_AUTHORIZED_CONFIG_AND_NATIVE_CAPTURE");
  }
  id(): string { return "cyberdeck:isolated-broker:offline-scripted"; }
  async callApi(prompt: string): Promise<ProviderResponse> {
    try {
      const evidence = await runScenario(prompt), failures = hardFailures(evidence);
      return { output: JSON.stringify(evidence), ...(failures.length ? { error: failures.join(", ") } : {}) };
    } catch (error) { return { error: error instanceof Error ? error.message : "EVALUATION_HARNESS_FAILED" }; }
  }
}
