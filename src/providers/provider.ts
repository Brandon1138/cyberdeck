import type { SessionRecord } from "../domain/session.js";

export interface ProviderLaunchSpec {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface ProviderAdapter {
  readonly id: "codex" | "claude";
  buildLaunchSpec(session: SessionRecord, initialPrompt?: string): ProviderLaunchSpec;
  /** Re-open the exact provider-native conversation represented by a terminal Cyberdeck thread. */
  buildResumeSpec(session: SessionRecord): ProviderLaunchSpec;
  /** Encode one logical prompt submission for the provider's negotiated interactive terminal. */
  submitInput?(message: string): Buffer;
}

export interface CyberdeckMcpLaunch {
  nodePath: string;
  cliPath: string;
}
