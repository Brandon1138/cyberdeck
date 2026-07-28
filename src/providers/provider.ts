import type { SessionRecord } from "../domain/session.js";
import type { ProviderId } from "../domain/provider-registration.js";

export interface ProviderLaunchSpec {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** PTY is the default. Pipe is reserved for bounded provider-native noninteractive transports. */
  transport?: "pty" | "pipe";
  /** Argument positions replaced before launch metadata is persisted. */
  sensitiveArgIndexes?: number[];
}

export interface ProviderSessionTerminal {
  snapshot(): Buffer;
  write(data: Buffer): void;
  wait(milliseconds: number): Promise<void>;
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
  /**
   * Whether the initial prompt must wait until provider-native post-launch setup finishes.
   * Used for modes such as Composer `/run-everything`, which have no launch flag.
   */
  deferInitialPrompt?(session: SessionRecord): boolean;
  /**
   * Provider-native setup after PTY creation and before a deferred initial prompt.
   * Implementations must verify resulting state and clean up any modal input on failure.
   */
  initializeSession?(
    session: SessionRecord,
    terminal: ProviderSessionTerminal,
  ): Promise<void>;
  /** Re-open the exact provider-native conversation represented by a terminal Cyberdeck thread. */
  buildResumeSpec(session: SessionRecord): ProviderLaunchSpec;
  /** Encode one logical prompt submission for the provider's negotiated interactive terminal. */
  submitInput?(message: string): Buffer;
  /**
   * Submit one logical prompt when the provider requires paced terminal interaction rather than a
   * single encoded buffer. Takes precedence over `submitInput` for deferred initial prompts.
   */
  submitInputToTerminal?(
    message: string,
    terminal: ProviderSessionTerminal,
  ): Promise<void>;
}

export interface CyberdeckMcpLaunch {
  nodePath: string;
  cliPath: string;
}
