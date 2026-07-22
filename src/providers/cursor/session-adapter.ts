import type { SessionRecord } from "../../domain/session.js";
import type { ProviderAdapter, ProviderLaunchSpec } from "../provider.js";
import { SessionResumeUnavailableError, UnsupportedProviderEffortError } from "../session-adapter-errors.js";
import { buildCursorInteractiveCommand } from "./commands.js";

/** Broker-owned interactive Cursor Composer/Agent session. */
export class CursorProviderAdapter implements ProviderAdapter {
  readonly id = "cursor" as const;

  buildLaunchSpec(session: SessionRecord, initialPrompt?: string): ProviderLaunchSpec {
    if (session.effort !== undefined) throw new UnsupportedProviderEffortError(this.id);
    return buildCursorInteractiveCommand(session, initialPrompt);
  }

  buildResumeSpec(_session: SessionRecord): ProviderLaunchSpec {
    throw new SessionResumeUnavailableError(this.id);
  }

  submitInput(message: string): Buffer {
    return Buffer.from(`${message}\r`);
  }
}
