import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";

interface ClaudeProjectEntry {
  hasTrustDialogAccepted?: boolean;
  [key: string]: unknown;
}

interface ClaudeSettings {
  projects?: Record<string, ClaudeProjectEntry>;
  [key: string]: unknown;
}

export interface ClaudeWorkspaceTrustOptions {
  settingsPath?: string;
  canonicalize?: (path: string) => Promise<string>;
}

/**
 * Persists the exact authorized Cyberdeck cwd in Claude's own trust store, mirroring the
 * Antigravity writer: an untrusted cwd parks a Claude worker at "Do you trust the files in this
 * folder?" at 0 turns, and a dialog that never appears beats any answering tool.
 *
 * Claude records the decision as `projects["<path>"].hasTrustDialogAccepted` in `~/.claude.json` —
 * confirmed against the operator's live file. Only that one flag on that one exact path is written;
 * every other key of the project entry and of the file is preserved byte-for-byte through a
 * read-modify-write with an atomic rename. No parent path, permission bypass, or later tool
 * approval is inferred from this workspace grant.
 */
export class ClaudeWorkspaceTrust {
  readonly settingsPath: string;
  private tail = Promise.resolve();

  constructor(private readonly options: ClaudeWorkspaceTrustOptions = {}) {
    this.settingsPath = options.settingsPath ?? join(homedir(), ".claude.json");
  }

  trust(cwd: string): Promise<string> {
    const operation = this.tail.then(() => this.persist(cwd));
    this.tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async persist(cwd: string): Promise<string> {
    const canonical = await (this.options.canonicalize ?? realpath)(cwd);
    const settings = await this.readSettings();
    const projects = settings.projects ?? {};
    const existing = projects[canonical];
    if (existing?.hasTrustDialogAccepted === true) return canonical;

    const next: ClaudeSettings = {
      ...settings,
      projects: {
        ...projects,
        [canonical]: { ...existing, hasTrustDialogAccepted: true },
      },
    };
    await mkdir(dirname(this.settingsPath), { recursive: true });
    const temporary = `${this.settingsPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, this.settingsPath);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    return canonical;
  }

  private async readSettings(): Promise<ClaudeSettings> {
    const source = await readFile(this.settingsPath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "{}";
      throw error;
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch (error) {
      throw new ClaudeTrustConfigError(this.settingsPath, error);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new ClaudeTrustConfigError(this.settingsPath);
    }
    const settings = parsed as ClaudeSettings;
    if (
      settings.projects !== undefined
      && (typeof settings.projects !== "object"
        || settings.projects === null
        || Array.isArray(settings.projects))
    ) {
      throw new ClaudeTrustConfigError(this.settingsPath);
    }
    return settings;
  }
}

export class ClaudeTrustConfigError extends Error {
  readonly code = "CLAUDE_TRUST_CONFIG_INVALID";

  constructor(path: string, cause?: unknown) {
    super(`Claude workspace trust config is invalid at ${path}`, { cause });
    this.name = "ClaudeTrustConfigError";
  }
}
