import type { SessionRecord } from "../../domain/session.js";
import type { ProviderAdapter, ProviderLaunchSpec } from "../provider.js";
import { SessionResumeUnavailableError } from "../session-adapter-errors.js";
import { buildAntigravityInteractiveCommand } from "./commands.js";
import { AntigravityWorkspaceTrust, type AntigravityWorkspaceTrustOptions } from "./workspace-trust.js";
import { sessionLaunchEnvironment } from "../launch-environment.js";
import {
  UnsupportedProviderApprovalModeError,
  UnsupportedProviderFastModeError,
} from "../session-adapter-errors.js";

export interface AntigravityProviderAdapterOptions extends AntigravityWorkspaceTrustOptions {
  sourceEnvironment?: Readonly<NodeJS.ProcessEnv>;
}

/** Broker-owned interactive Antigravity session using agy's documented prompt-interactive mode. */
export class AntigravityProviderAdapter implements ProviderAdapter {
  readonly id = "antigravity" as const;
  private readonly workspaceTrust: AntigravityWorkspaceTrust;

  constructor(private readonly options: AntigravityProviderAdapterOptions = {}) {
    this.workspaceTrust = new AntigravityWorkspaceTrust(options);
  }

  buildLaunchSpec(session: SessionRecord, initialPrompt?: string): ProviderLaunchSpec {
    if (session.approvalMode === "auto") throw new UnsupportedProviderApprovalModeError(this.id);
    if (session.fast === true) throw new UnsupportedProviderFastModeError(this.id);
    const command = buildAntigravityInteractiveCommand({
      provider: session.provider,
      cwd: session.cwd,
      sandbox: session.sandbox,
      ...(session.model === undefined ? {} : { model: session.model }),
      ...(session.effort === undefined ? {} : { effort: session.effort }),
    }, {
      ...(initialPrompt === undefined ? {} : { initialPrompt }),
      sourceEnvironment: this.options.sourceEnvironment ?? process.env,
    });
    return {
      ...command,
      env: sessionLaunchEnvironment(
        this.options.sourceEnvironment ?? process.env,
        this.id,
        session.cwd,
        session,
      ),
    };
  }

  async prepareLaunch(session: SessionRecord): Promise<void> {
    await this.workspaceTrust.trust(session.cwd);
  }

  buildResumeSpec(_session: SessionRecord): ProviderLaunchSpec {
    throw new SessionResumeUnavailableError(this.id);
  }

  submitInput(message: string): Buffer {
    return Buffer.from(`${message}\r`);
  }
}
