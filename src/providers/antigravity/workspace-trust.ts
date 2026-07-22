import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";

interface AntigravitySettings {
  trustedWorkspaces?: string[];
  [key: string]: unknown;
}

export interface AntigravityWorkspaceTrustOptions {
  settingsPath?: string;
  canonicalize?: (path: string) => Promise<string>;
}

/**
 * Persists the exact authorized Cyberdeck cwd in Antigravity's own trust store.
 *
 * Starts are serialized so parallel worker launches cannot overwrite each other's additions. No
 * parent path, permission bypass, or later tool approval is inferred from this workspace grant.
 */
export class AntigravityWorkspaceTrust {
  readonly settingsPath: string;
  private tail = Promise.resolve();

  constructor(private readonly options: AntigravityWorkspaceTrustOptions = {}) {
    this.settingsPath = options.settingsPath
      ?? join(homedir(), ".gemini", "antigravity-cli", "settings.json");
  }

  trust(cwd: string): Promise<string> {
    const operation = this.tail.then(() => this.persist(cwd));
    this.tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async persist(cwd: string): Promise<string> {
    const canonical = await (this.options.canonicalize ?? realpath)(cwd);
    const settings = await this.readSettings();
    const trusted = settings.trustedWorkspaces ?? [];
    if (trusted.includes(canonical)) return canonical;

    const next: AntigravitySettings = {
      ...settings,
      trustedWorkspaces: [...trusted, canonical],
    };
    await mkdir(dirname(this.settingsPath), { recursive: true });
    const temporary = `${this.settingsPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, this.settingsPath);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    return canonical;
  }

  private async readSettings(): Promise<AntigravitySettings> {
    const source = await readFile(this.settingsPath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "{}";
      throw error;
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch (error) {
      throw new AntigravityTrustConfigError(this.settingsPath, error);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new AntigravityTrustConfigError(this.settingsPath);
    }
    const settings = parsed as AntigravitySettings;
    if (
      settings.trustedWorkspaces !== undefined
      && (!Array.isArray(settings.trustedWorkspaces)
        || settings.trustedWorkspaces.some((entry) => typeof entry !== "string"))
    ) {
      throw new AntigravityTrustConfigError(this.settingsPath);
    }
    return settings;
  }
}

export class AntigravityTrustConfigError extends Error {
  readonly code = "ANTIGRAVITY_TRUST_CONFIG_INVALID";

  constructor(path: string, cause?: unknown) {
    super(`Antigravity workspace trust config is invalid at ${path}`, { cause });
    this.name = "AntigravityTrustConfigError";
  }
}
