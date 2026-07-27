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
import {
  verifyCursorReadOnlyCanary,
  type CursorReadOnlyCanaryOptions,
  type CursorReadOnlyCanaryResult,
} from "./read-only-canary.js";
import { isolateCursorScoutMcp } from "./mcp-isolation.js";
import { join } from "node:path";

export interface CursorProviderAdapterOptions extends CursorRunEverythingOptions {
  sourceEnvironment?: Readonly<NodeJS.ProcessEnv>;
  readOnlyCanary?: (
    session: SessionRecord,
    terminal: ProviderSessionTerminal,
    options: CursorReadOnlyCanaryOptions,
  ) => Promise<CursorReadOnlyCanaryResult>;
  isolateMcp?: (session: SessionRecord, spec: ProviderLaunchSpec) => Promise<void>;
  now?: () => string;
}

/** Broker-owned interactive Cursor Composer/Agent session. */
export class CursorProviderAdapter implements ProviderAdapter {
  readonly id = "cursor" as const;

  constructor(private readonly options: CursorProviderAdapterOptions = {}) {}

  buildLaunchSpec(session: SessionRecord, initialPrompt?: string): ProviderLaunchSpec {
    if (session.effort !== undefined) throw new UnsupportedProviderEffortError(this.id);
    const source = this.options.sourceEnvironment ?? process.env;
    const command = buildCursorInteractiveCommand(session, initialPrompt, source);
    const env = sessionLaunchEnvironment(source, this.id, session.cwd, session);
    if (session.profile === "scout" && session.scout !== undefined) {
      const dropBoxPath = session.scout.dropBoxPath;
      env.CURSOR_CONFIG_DIR = join(dropBoxPath, "cursor-config");
      env.CURSOR_DATA_DIR = join(dropBoxPath, "cursor-data");
      env.NODE_COMPILE_CACHE = join(dropBoxPath, "node-cache");
      env.TMPDIR = join(dropBoxPath, "tmp");
      env.CYBERDECK_SCOUT_DROP_BOX = dropBoxPath;
      env.CYBERDECK_SCOUT_REPORT_PATH = session.scout.reportPath;
    }
    return {
      ...command,
      env,
    };
  }

  async prepareLaunch(session: SessionRecord, spec: ProviderLaunchSpec): Promise<void> {
    if (session.profile !== "scout") return;
    await (this.options.isolateMcp ?? isolateCursorScoutMcp)(session, spec);
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
  ) {
    if (session.approvalMode !== "auto") return;
    await enableCursorRunEverything(terminal, {
      ...(this.options.timeoutMs === undefined ? {} : { timeoutMs: this.options.timeoutMs }),
      ...(this.options.pollIntervalMs === undefined
        ? {}
        : { pollIntervalMs: this.options.pollIntervalMs }),
    });
    if (session.profile !== "scout") return;
    const canary = await (this.options.readOnlyCanary ?? verifyCursorReadOnlyCanary)(
      session,
      terminal,
      {
        ...(this.options.timeoutMs === undefined ? {} : { timeoutMs: this.options.timeoutMs }),
        ...(this.options.pollIntervalMs === undefined
          ? {}
          : { pollIntervalMs: this.options.pollIntervalMs }),
        ...(this.options.now === undefined ? {} : { now: this.options.now }),
      },
    );
    return { scoutReadOnlyCanary: canary };
  }

  submitInput(message: string): Buffer {
    return Buffer.from(`${message}\r`);
  }
}
