import type { SessionRecord } from "../../domain/session.js";
import type { ProviderAdapter, ProviderLaunchSpec } from "../provider.js";
import {
  SessionResumeUnavailableError,
  UnsupportedProviderApprovalModeError,
  UnsupportedProviderEffortError,
} from "../session-adapter-errors.js";
import { buildCursorInteractiveCommand } from "./commands.js";
import { sessionLaunchEnvironment } from "../launch-environment.js";

export interface CursorProviderAdapterOptions {
  sourceEnvironment?: Readonly<NodeJS.ProcessEnv>;
}

/** Broker-owned interactive Cursor Composer/Agent session. */
export class CursorProviderAdapter implements ProviderAdapter {
  readonly id = "cursor" as const;

  constructor(private readonly options: CursorProviderAdapterOptions = {}) {}

  buildLaunchSpec(session: SessionRecord, initialPrompt?: string): ProviderLaunchSpec {
    if (session.effort !== undefined) throw new UnsupportedProviderEffortError(this.id);
    if (session.approvalMode === "auto") throw new UnsupportedProviderApprovalModeError(this.id);
    const source = this.options.sourceEnvironment ?? process.env;
    const command = buildCursorInteractiveCommand(session, initialPrompt, source);
    return {
      ...command,
      env: sessionLaunchEnvironment(source, this.id, session.cwd, session),
    };
  }

  buildResumeSpec(_session: SessionRecord): ProviderLaunchSpec {
    throw new SessionResumeUnavailableError(this.id);
  }

  submitInput(message: string): Buffer {
    return Buffer.from(`${message}\r`);
  }
}
