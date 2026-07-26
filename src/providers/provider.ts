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
  /**
   * Complete a provider-specific, non-model preflight after command validation and before spawn.
   * The broker runs it for every launch *and* every resume, so artifacts a spec references may be
   * (re)created from scratch here; it must be safe to call repeatedly for the same session.
   */
  prepareLaunch?(session: SessionRecord, spec: ProviderLaunchSpec): Promise<void>;
  /**
   * Remove provider-owned launch artifacts. The broker calls this when the provider process exits,
   * when the durable thread is deleted, and when a prepared launch fails before a live PTY takes
   * ownership; `prepareLaunch` rebuilds them on the next resume. Must be idempotent.
   */
  cleanupLaunch?(session: SessionRecord): Promise<void>;
  /** Re-open the exact provider-native conversation represented by a terminal Cyberdeck thread. */
  buildResumeSpec(session: SessionRecord): ProviderLaunchSpec;
  /** Encode one logical prompt submission for the provider's negotiated interactive terminal. */
  submitInput?(message: string): Buffer;
}

export interface CyberdeckMcpLaunch {
  nodePath: string;
  cliPath: string;
}
