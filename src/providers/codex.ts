import { execFile } from "node:child_process";
import { closeSync, openSync, readSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { CyberdeckMcpLaunch, ProviderAdapter, ProviderLaunchSpec } from "./provider.js";
import type { SessionRecord } from "../domain/session.js";
import { providerImageLaunchArgs } from "./image-input.js";
import { sessionLaunchEnvironment } from "./launch-environment.js";
import { resolveProviderPermissionPlan } from "../domain/permission-resolution.js";
import { workspaceWritableRoots } from "../domain/worker-workspace.js";

/**
 * Codex workers name both permission dimensions independently. Top-level orchestrators use the
 * provider's reviewed `--approve-for-me` preset. Both paths still come from the shared resolver so
 * the stored request and the provider-native launch cannot disagree about what was granted.
 */
function codexPermissionArgs(session: SessionRecord): string[] {
  const plan = resolveProviderPermissionPlan("codex", {
    sandbox: session.sandbox,
    approvalMode: session.approvalMode,
    writableRoots: workspaceWritableRoots(session.workspace),
    codexApproveForMe: session.kind === "orchestrator",
  });
  if (!plan.ok) throw Object.assign(new Error(plan.message), { code: plan.code });
  return [...plan.value.args];
}

const CODEX_SESSION_MATCH_WINDOW_MS = 30_000;

export class CodexResumeError extends Error {
  readonly code = "SESSION_RESUME_UNAVAILABLE";

  constructor(message: string) {
    super(message);
    this.name = "CodexResumeError";
  }
}

export interface CodexProviderAdapterOptions {
  sessionsDirectory?: string;
  mcp?: CyberdeckMcpLaunch;
  sourceEnvironment?: Readonly<NodeJS.ProcessEnv>;
  runCommand?: CodexCommandRunner;
}

export type CodexCommandRunner = (
  executable: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => Promise<void>;

const execFileAsync = promisify(execFile);
const CODEX_REMOTE_ADDRESS = "unix://";
const CODEX_FIRST_PARTY_MODEL_PROVIDER = "openai";
const MAX_CODEX_COMMAND_ERROR = 2_000;

const runCodexCommand: CodexCommandRunner = async (executable, args, options) => {
  await execFileAsync(executable, [...args], {
    cwd: options.cwd,
    env: options.env,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
};

export class CodexProviderAdapter implements ProviderAdapter {
  readonly id = "codex" as const;

  constructor(private readonly options: CodexProviderAdapterOptions = {}) {}

  submitInput(message: string): Buffer {
    // Codex enables Kitty keyboard disambiguation in its PTY. A literal CR/LF edits the composer;
    // CSI 13 u is the negotiated Enter key that submits it.
    return Buffer.from(`${message}\u001b[13u`);
  }

  buildLaunchSpec(session: SessionRecord, initialPrompt?: string): ProviderLaunchSpec {
    const args = [
      "--no-alt-screen",
      "-C",
      session.cwd,
      ...this.remoteArgs(session),
      ...codexPermissionArgs(session),
    ];
    if (session.model !== undefined) {
      args.push("-m", session.model);
    }
    if (session.effort !== undefined) {
      args.push("-c", `model_reasoning_effort=${JSON.stringify(session.effort)}`);
    }
    this.addProviderInstructions(args, session);
    this.addCyberdeckMcp(args, session);
    // `-i` attaches to the *initial* prompt, which is the only prompt a launch has. Resume takes no
    // image because there is no initial prompt left to attach one to; a later image is the
    // provider's own paste, not ours to forge.
    args.push(...providerImageLaunchArgs(this.id, session.imageAttachments ?? []));
    if (initialPrompt !== undefined) {
      args.push("--", initialPrompt);
    }

    return {
      executable: "codex",
      args,
      cwd: session.cwd,
      env: sessionLaunchEnvironment(
        this.options.sourceEnvironment ?? process.env,
        this.id,
        session.cwd,
        session,
      ),
    };
  }

  buildResumeSpec(session: SessionRecord): ProviderLaunchSpec {
    const nativeSessionId = this.findNativeSessionId(session);
    const args = [
      "resume",
      "--no-alt-screen",
      "-C",
      session.cwd,
      ...this.remoteArgs(session),
      ...codexPermissionArgs(session),
    ];
    if (session.model !== undefined) args.push("-m", session.model);
    if (session.effort !== undefined) {
      args.push("-c", `model_reasoning_effort=${JSON.stringify(session.effort)}`);
    }
    this.addProviderInstructions(args, session);
    this.addCyberdeckMcp(args, session);
    args.push(nativeSessionId);
    return {
      executable: "codex",
      args,
      cwd: session.cwd,
      env: sessionLaunchEnvironment(
        this.options.sourceEnvironment ?? process.env,
        this.id,
        session.cwd,
        session,
      ),
    };
  }

  /**
   * Codex Remote Control is hosted by its managed app-server daemon. Starting it is idempotent, so
   * every orchestrator launch and resume can establish the prerequisite before the remote TUI
   * connects. Workers remain direct provider processes and never touch this machine-wide daemon.
   */
  async prepareLaunch(session: SessionRecord, spec: ProviderLaunchSpec): Promise<void> {
    if (session.kind !== "orchestrator") return;
    try {
      await (this.options.runCommand ?? runCodexCommand)(
        spec.executable,
        ["remote-control", "start", "--json"],
        { cwd: spec.cwd, env: spec.env },
      );
    } catch (cause) {
      const detail = codexCommandFailure(cause);
      throw Object.assign(
        new Error(
          `Could not start Codex Remote Control for orchestrator ${session.id}`
            + (detail === undefined ? "" : `:\n${detail}`),
          { cause },
        ),
        { code: "CODEX_REMOTE_CONTROL_UNAVAILABLE" },
      );
    }
  }

  private remoteArgs(session: SessionRecord): string[] {
    return session.kind === "orchestrator"
      ? [
        "--remote",
        CODEX_REMOTE_ADDRESS,
        "-c",
        `model_provider=${JSON.stringify(CODEX_FIRST_PARTY_MODEL_PROVIDER)}`,
      ]
      : [];
  }

  private addProviderInstructions(args: string[], session: SessionRecord): void {
    if (session.providerInstructions === undefined) return;
    args.push("-c", `developer_instructions=${JSON.stringify(session.providerInstructions)}`);
  }

  private addCyberdeckMcp(args: string[], session: SessionRecord): void {
    if (session.kind === undefined || this.options.mcp === undefined) return;
    args.push(
      "-c",
      `mcp_servers.cyberdeck.command=${JSON.stringify(this.options.mcp.nodePath)}`,
      "-c",
      `mcp_servers.cyberdeck.args=${JSON.stringify([
        this.options.mcp.cliPath,
        "mcp",
        "--actor-session",
        session.id,
      ])}`,
    );
  }

  private findNativeSessionId(session: SessionRecord): string {
    const sessionsDirectory = this.options.sessionsDirectory
      ?? join(
        (this.options.sourceEnvironment ?? process.env).CODEX_HOME ?? join(homedir(), ".codex"),
        "sessions",
      );
    const createdAt = Date.parse(session.createdAt);
    const candidates: Array<{ id: string; distance: number }> = [];

    for (const dayDirectory of candidateDayDirectories(sessionsDirectory, createdAt)) {
      let entries;
      try {
        entries = readdirSync(dayDirectory, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
        const metadata = readSessionMetadata(join(dayDirectory, entry.name));
        if (metadata === undefined || metadata.cwd !== session.cwd) continue;
        const distance = Math.abs(Date.parse(metadata.timestamp) - createdAt);
        if (distance <= CODEX_SESSION_MATCH_WINDOW_MS) candidates.push({ id: metadata.id, distance });
      }
    }

    candidates.sort((left, right) => left.distance - right.distance || left.id.localeCompare(right.id));
    const match = candidates[0];
    if (match === undefined) {
      throw new CodexResumeError(
        `Could not locate the provider-native Codex conversation for Cyberdeck thread ${session.id}`,
      );
    }
    return match.id;
  }
}

function codexCommandFailure(cause: unknown): string | undefined {
  const value = typeof cause === "object" && cause !== null && "stderr" in cause
    ? String((cause as { stderr: unknown }).stderr)
    : cause instanceof Error ? cause.message : String(cause);
  const detail = value.trim().slice(0, MAX_CODEX_COMMAND_ERROR);
  return detail === "" ? undefined : detail;
}

function candidateDayDirectories(root: string, timestamp: number): string[] {
  const directories = new Set<string>();
  for (const offset of [-86_400_000, 0, 86_400_000]) {
    const date = new Date(timestamp + offset);
    directories.add(join(
      root,
      String(date.getUTCFullYear()),
      String(date.getUTCMonth() + 1).padStart(2, "0"),
      String(date.getUTCDate()).padStart(2, "0"),
    ));
  }
  return [...directories];
}

function readSessionMetadata(path: string): { id: string; timestamp: string; cwd: string } | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    const buffer = Buffer.alloc(64 * 1024);
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0];
    if (firstLine === undefined || firstLine === "") return undefined;
    const frame = JSON.parse(firstLine) as {
      type?: unknown;
      payload?: { id?: unknown; timestamp?: unknown; cwd?: unknown; originator?: unknown };
    };
    const payload = frame.payload;
    if (
      frame.type !== "session_meta"
      || payload?.originator !== "codex-tui"
      || typeof payload.id !== "string"
      || typeof payload.timestamp !== "string"
      || typeof payload.cwd !== "string"
    ) return undefined;
    return { id: payload.id, timestamp: payload.timestamp, cwd: payload.cwd };
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
