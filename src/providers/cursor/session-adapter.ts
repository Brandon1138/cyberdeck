import type { SessionRecord } from "../../domain/session.js";
import { resolveProviderPermissionPlan } from "../../domain/permission-resolution.js";
import type { CyberdeckMcpLaunch, ProviderAdapter, ProviderLaunchSpec } from "../provider.js";
import {
  SessionResumeUnavailableError,
  UnsupportedProviderEffortError,
  UnsupportedProviderFastModeError,
} from "../session-adapter-errors.js";
import type { ProviderSessionTerminal } from "../provider.js";
import {
  buildCursorInteractiveCommand,
  buildCursorScoutCommand,
} from "./commands.js";
import { sessionLaunchEnvironment } from "../launch-environment.js";
import {
  enableCursorRunEverything,
  type CursorRunEverythingOptions,
} from "./run-everything.js";
import { submitCursorPastedInput } from "./input.js";
import { isolateCursorScoutMcp } from "./mcp-isolation.js";
import { cursorMcpHostPaths, writeCursorMcpHost } from "./mcp-hosting.js";
import {
  removeSessionLaunchFiles,
  type SessionLaunchFilesOptions,
} from "../session-launch-files.js";
import { join } from "node:path";

/**
 * A Cursor thread whose conversation identity was never bound cannot be reopened: `agent --resume`
 * adopts an unrecognized id as a *new* empty chat, which would present as the operator's original
 * thread while holding none of its history.
 */
export class CursorResumeError extends Error {
  readonly code = "SESSION_RESUME_UNAVAILABLE";

  constructor(message: string) {
    super(message);
    this.name = "CursorResumeError";
  }
}

export interface CursorProviderAdapterOptions
  extends CursorRunEverythingOptions, SessionLaunchFilesOptions {
  mcp?: CyberdeckMcpLaunch;
  sourceEnvironment?: Readonly<NodeJS.ProcessEnv>;
  isolateMcp?: (session: SessionRecord, spec: ProviderLaunchSpec) => Promise<void>;
  inputCommitDelayMs?: number;
}

/** Broker-owned interactive Cursor Composer/Agent session. */
export class CursorProviderAdapter implements ProviderAdapter {
  readonly id = "cursor" as const;

  constructor(private readonly options: CursorProviderAdapterOptions = {}) {}

  buildLaunchSpec(session: SessionRecord, initialPrompt?: string): ProviderLaunchSpec {
    if (session.effort !== undefined) throw new UnsupportedProviderEffortError(this.id);
    if (session.fast === true) throw new UnsupportedProviderFastModeError(this.id);
    const source = this.options.sourceEnvironment ?? process.env;
    if (session.profile === "scout" && initialPrompt === undefined) {
      throw new Error("Headless Cursor Scout launch requires its complete initial prompt");
    }
    if (session.profile === "scout") {
      const command = buildCursorScoutCommand(session, initialPrompt!, source);
      const env = { ...command.env };
      if (session.scout !== undefined) {
        const dropBoxPath = session.scout.dropBoxPath;
        env.CURSOR_CONFIG_DIR = join(dropBoxPath, "cursor-config");
        env.CURSOR_DATA_DIR = join(dropBoxPath, "cursor-data");
        env.NODE_COMPILE_CACHE = join(dropBoxPath, "node-cache");
        env.TMPDIR = join(dropBoxPath, "tmp");
        env.CYBERDECK_SCOUT_DROP_BOX = dropBoxPath;
        env.CYBERDECK_SCOUT_REPORT_PATH = session.scout.reportPath;
      }
      return { ...command, env };
    }
    return this.interactiveSpec(session, initialPrompt);
  }

  /**
   * Launch and resume are the same command for Cursor. `--resume <chat id>` reopens a known
   * conversation and opens the named one when it is unknown, so the Cyberdeck session id is used as
   * the chat id directly: no `create-chat` process, nothing extra to persist, and no way for a
   * resume to land on a different conversation than the launch did.
   */
  buildResumeSpec(session: SessionRecord): ProviderLaunchSpec {
    if (session.profile === "scout") throw new SessionResumeUnavailableError(this.id);
    // The launch record is the durable evidence that this thread's conversation carries the id being
    // resumed. A thread launched before Cyberdeck bound chat ids has none, and resuming it would
    // silently open an empty chat under its name.
    if (!(session.launchRecord?.args ?? []).includes(session.id)) {
      throw new CursorResumeError(
        `Cursor session ${session.id} was launched without a bound chat id; rebind to continue`,
      );
    }
    return this.interactiveSpec(session, undefined);
  }

  private interactiveSpec(
    session: SessionRecord,
    initialPrompt: string | undefined,
  ): ProviderLaunchSpec {
    const source = this.options.sourceEnvironment ?? process.env;
    const paths = this.hostsMcp(session) ? cursorMcpHostPaths(session.id, this.options) : undefined;
    const command = buildCursorInteractiveCommand(session, {
      initialPrompt,
      chatId: session.id,
      ...(paths === undefined ? {} : { pluginDirectory: paths.pluginDirectory }),
      sourceEnvironment: source,
    });
    const env = sessionLaunchEnvironment(source, this.id, session.cwd, session);
    if (paths !== undefined) env.CURSOR_CONFIG_DIR = paths.configDirectory;
    return { ...command, env };
  }

  /**
   * Mirrors Codex: the Cyberdeck server is offered to sessions Cyberdeck itself orchestrates, never
   * to a plain operator session, which keeps the control plane out of ad-hoc threads.
   */
  private hostsMcp(session: SessionRecord): boolean {
    return session.profile !== "scout"
      && session.kind !== undefined
      && this.options.mcp !== undefined;
  }

  async prepareLaunch(session: SessionRecord, spec: ProviderLaunchSpec): Promise<void> {
    if (session.profile === "scout") {
      await (this.options.isolateMcp ?? isolateCursorScoutMcp)(session, spec);
      return;
    }
    if (!this.hostsMcp(session)) return;
    await writeCursorMcpHost(session, this.options.mcp!, this.options);
  }

  /** Session-scoped only; the Scout drop box is owned and cleaned by the Scout report store. */
  async cleanupLaunch(session: SessionRecord): Promise<void> {
    if (session.profile === "scout") return;
    await removeSessionLaunchFiles(session.id, this.options);
  }

  /**
   * `providerInstructions` joins `auto` in deferring the first prompt. The CLI has no system-prompt
   * flag, so instructions are submitted as the session's first message; deferring guarantees they
   * precede an initial prompt instead of racing a positional one already in argv.
   */
  deferInitialPrompt(session: SessionRecord): boolean {
    return session.profile !== "scout"
      && (cursorRunsEverything(session) || session.providerInstructions !== undefined);
  }

  async initializeSession(
    session: SessionRecord,
    terminal: ProviderSessionTerminal,
  ) {
    if (session.profile === "scout") return;
    if (cursorRunsEverything(session)) {
      await enableCursorRunEverything(terminal, {
        ...(this.options.timeoutMs === undefined ? {} : { timeoutMs: this.options.timeoutMs }),
        ...(this.options.pollIntervalMs === undefined
          ? {}
          : { pollIntervalMs: this.options.pollIntervalMs }),
      });
    }
    // After `/run-everything`, so the instructions turn runs under the mode the session will keep.
    if (session.providerInstructions !== undefined) {
      await this.submitInputToTerminal(session.providerInstructions, terminal);
    }
  }

  async submitInputToTerminal(
    message: string,
    terminal: ProviderSessionTerminal,
  ): Promise<void> {
    await submitCursorPastedInput(terminal, message, {
      ...(this.options.inputCommitDelayMs === undefined
        ? {}
        : { commitDelayMs: this.options.inputCommitDelayMs }),
    });
  }
}

/**
 * `/run-everything` grants automatic approval but is not bounded by the read-only mode, so running
 * it inside a read-only session would widen exactly the request the sandbox refused. The shared
 * resolver decides; a read-only session that asked for automatic approval keeps its prompts and the
 * shortfall is reported at worker start rather than discovered at one.
 */
function cursorRunsEverything(session: SessionRecord): boolean {
  const plan = resolveProviderPermissionPlan("cursor", {
    sandbox: session.sandbox,
    approvalMode: session.approvalMode,
  });
  return plan.ok && plan.value.postLaunch.includes("cursor-run-everything");
}
