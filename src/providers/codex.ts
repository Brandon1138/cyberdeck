import { closeSync, openSync, readSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CyberdeckMcpLaunch, ProviderAdapter, ProviderLaunchSpec } from "./provider.js";
import type { SessionRecord } from "../domain/session.js";

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
}

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
      "-s",
      session.sandbox,
      "-a",
      "on-request",
    ];
    if (session.model !== undefined) {
      args.push("-m", session.model);
    }
    this.addProviderInstructions(args, session);
    this.addCyberdeckMcp(args, session);
    if (initialPrompt !== undefined) {
      args.push("--", initialPrompt);
    }

    return {
      executable: "codex",
      args,
      cwd: session.cwd,
      env: { ...process.env },
    };
  }

  buildResumeSpec(session: SessionRecord): ProviderLaunchSpec {
    const nativeSessionId = this.findNativeSessionId(session);
    const args = [
      "resume",
      "--no-alt-screen",
      "-C",
      session.cwd,
      "-s",
      session.sandbox,
      "-a",
      "on-request",
    ];
    if (session.model !== undefined) args.push("-m", session.model);
    this.addProviderInstructions(args, session);
    this.addCyberdeckMcp(args, session);
    args.push(nativeSessionId);
    return {
      executable: "codex",
      args,
      cwd: session.cwd,
      env: { ...process.env },
    };
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
      ?? join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions");
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
