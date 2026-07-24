import type { SessionRecord } from "../../domain/session.js";
import type { ProviderAdapter, ProviderLaunchSpec } from "../provider.js";
import {
  SessionResumeUnavailableError,
  UnsupportedProviderApprovalModeError,
  UnsupportedProviderEffortError,
} from "../session-adapter-errors.js";
import { buildCursorInteractiveCommand } from "./commands.js";
import { sessionLaunchEnvironment } from "../launch-environment.js";

/** Broker-owned interactive Cursor Composer/Agent session. */
export class CursorProviderAdapter implements ProviderAdapter {
  readonly id = "cursor" as const;

  buildLaunchSpec(session: SessionRecord, initialPrompt?: string): ProviderLaunchSpec {
    if (session.effort !== undefined) throw new UnsupportedProviderEffortError(this.id);
    if (session.approvalMode === "auto") throw new UnsupportedProviderApprovalModeError(this.id);
    const command = buildCursorInteractiveCommand(session, initialPrompt);
    return { ...command, env: sessionLaunchEnvironment(command.env, session) };
  }

  buildResumeSpec(_session: SessionRecord): ProviderLaunchSpec {
    throw new SessionResumeUnavailableError(this.id);
  }

  submitInput(message: string): Buffer {
    return Buffer.from(`${message}\r`);
  }
}
