import type { SessionRecord } from "../../domain/session.js";
import type { ProviderAdapter, ProviderLaunchSpec } from "../provider.js";
import {
  SessionResumeUnavailableError,
  UnsupportedProviderEffortError,
} from "../session-adapter-errors.js";
import type { ProviderSessionTerminal } from "../provider.js";
import { buildCursorInteractiveCommand } from "./commands.js";
import { sessionLaunchEnvironment } from "../launch-environment.js";
import {
  enableCursorRunEverything,
  type CursorRunEverythingOptions,
} from "./run-everything.js";

export interface CursorProviderAdapterOptions extends CursorRunEverythingOptions {
  sourceEnvironment?: Readonly<NodeJS.ProcessEnv>;
}

/** Broker-owned interactive Cursor Composer/Agent session. */
export class CursorProviderAdapter implements ProviderAdapter {
  readonly id = "cursor" as const;

  constructor(private readonly options: CursorProviderAdapterOptions = {}) {}

  buildLaunchSpec(session: SessionRecord, initialPrompt?: string): ProviderLaunchSpec {
    if (session.effort !== undefined) throw new UnsupportedProviderEffortError(this.id);
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

  deferInitialPrompt(session: SessionRecord): boolean {
    return session.approvalMode === "auto";
  }

  async initializeSession(
    session: SessionRecord,
    terminal: ProviderSessionTerminal,
  ): Promise<void> {
    if (session.approvalMode !== "auto") return;
    await enableCursorRunEverything(terminal, {
      ...(this.options.timeoutMs === undefined ? {} : { timeoutMs: this.options.timeoutMs }),
      ...(this.options.pollIntervalMs === undefined
        ? {}
        : { pollIntervalMs: this.options.pollIntervalMs }),
    });
  }

  submitInput(message: string): Buffer {
    return Buffer.from(`${message}\r`);
  }
}
