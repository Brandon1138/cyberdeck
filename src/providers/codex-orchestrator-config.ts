/** Remote Codex orchestrators use the first-party provider for both discovery and launch. */
export const CODEX_ORCHESTRATOR_CONFIG_ARGS = ["-c", 'model_provider="openai"'] as const;
