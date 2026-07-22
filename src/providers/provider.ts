import type { SessionRecord } from "../domain/session.js";
import type { ProviderId } from "../domain/provider-registration.js";

export interface ProviderLaunchSpec {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  buildLaunchSpec(session: SessionRecord, initialPrompt?: string): ProviderLaunchSpec;
  /** Complete a provider-specific, non-model preflight after command validation and before spawn. */
  prepareLaunch?(session: SessionRecord, spec: ProviderLaunchSpec): Promise<void>;
  /** Re-open the exact provider-native conversation represented by a terminal Cyberdeck thread. */
  buildResumeSpec(session: SessionRecord): ProviderLaunchSpec;
  /** Encode one logical prompt submission for the provider's negotiated interactive terminal. */
  submitInput?(message: string): Buffer;
}

export interface CyberdeckMcpLaunch {
  nodePath: string;
  cliPath: string;
}
