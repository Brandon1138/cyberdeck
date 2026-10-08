/** Remote Codex orchestrators use the first-party provider for both discovery and launch. */
export const CODEX_ORCHESTRATOR_CONFIG_ARGS = [
  "-c", 'model_provider="openai"',
  // Command-line scope also prevents a project-local plugin setting from re-enabling its repair hook.
  "-c", 'plugins."headroom@headroom-marketplace".enabled=false',
] as const;
