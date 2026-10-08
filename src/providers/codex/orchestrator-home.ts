import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readlink, rename, stat, symlink, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse, stringify } from "smol-toml";
import { ensurePrivateDirectory } from "../../persistence/private-files.js";

export interface CodexOrchestratorHomePort {
  readonly directory: string;
  prepare(): Promise<void>;
}

// Share login and native conversations, never installation identity, enrollment,
// sockets, daemon packages, or SQLite state. In particular auth is linked, not copied: a refresh
// must update the same login file instead of creating competing copies of a refresh token.
const SHARED_ENTRIES = [
  "auth.json", "AGENTS.md", "RTK.md", "skills", "plugins",
  "rules", "prompts", "memories", "sessions", "archived_sessions", "thread-writer-locks",
  "session_index.jsonl", "history.jsonl", "shell_snapshots", "attachments", "generated_images",
] as const;

const CONFIG_MARKER = "# Cyberdeck managed first-party Remote Control configuration\n";
const HOOKS_MARKER = "hooks.json.cyberdeck-managed";

/** A native RC owner shared by interactive CLI and Cyberdeck, separate from Desktop. */
export class CodexOrchestratorHome implements CodexOrchestratorHomePort {
  readonly sourceDirectory: string;
  readonly directory: string;
  private tail = Promise.resolve();

  constructor(sourceDirectory = process.env.CODEX_HOME ?? join(homedir(), ".codex")) {
    this.sourceDirectory = resolve(sourceDirectory);
    // Keep the control socket short enough for macOS's Unix socket limit. The application support
    // directory's longer path cannot accommodate Codex's app-server-control socket suffix.
    this.directory = join(this.sourceDirectory, "cyberdeck-orchestrator");
  }

  prepare(): Promise<void> {
    const operation = this.tail.then(() => this.linkSharedEntries());
    this.tail = operation.catch(() => undefined);
    return operation;
  }

  private async linkSharedEntries(): Promise<void> {
    const auth = await stat(join(this.sourceDirectory, "auth.json")).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!auth?.isFile()) {
      throw new Error(`Codex orchestrator RC needs the existing file-backed login at ${this.sourceDirectory}/auth.json`);
    }
    const directoryEntry = await lstat(this.directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (directoryEntry && !directoryEntry.isDirectory()) {
      throw new Error(`Codex orchestrator home is not an independent directory: ${this.directory}`);
    }
    await ensurePrivateDirectory(this.directory);
    // Codex creates these directories on demand; an absent source behind a dangling directory
    // link cannot be created that way. Their shared locations also preserve old native resumes.
    for (const name of ["sessions", "archived_sessions", "thread-writer-locks"]) {
      await mkdir(join(this.sourceDirectory, name), { recursive: true, mode: 0o700 });
    }
    for (const name of SHARED_ENTRIES) {
      const source = join(this.sourceDirectory, name);
      const destination = join(this.directory, name);
      if (!await lstat(source).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      })) continue;
      // Never replace an independent file or somebody else's link.
      try {
        await symlink(source, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const entry = await lstat(destination);
        if (entry.isSymbolicLink()
          && resolve(dirname(destination), await readlink(destination)) === source) continue;
        throw new Error(`Codex orchestrator home contains an independent ${name}: ${destination}`);
      }
    }
    await this.prepareFirstPartyConfiguration();
  }

  private async prepareFirstPartyConfiguration(): Promise<void> {
    const configPath = join(this.directory, "config.toml");
    const hooksPath = join(this.directory, "hooks.json");
    const configSource = await readFile(join(this.sourceDirectory, "config.toml"), "utf8").catch(missingText);
    const hooksSource = await readFile(join(this.sourceDirectory, "hooks.json"), "utf8").catch(missingText);
    const existingConfig = await this.managedEntry("config.toml", async () =>
      (await readFile(configPath, "utf8")).startsWith(CONFIG_MARKER));
    await this.managedEntry("hooks.json", async () =>
      (await readFile(join(this.directory, HOOKS_MARKER), "utf8").catch(missingText)) === this.sourceDirectory);

    const config = parsePrivateSettings(parse, configSource, join(this.sourceDirectory, "config.toml"));
    // Keep preferences and MCP configuration, while the daemon itself defaults to OpenAI.
    // CLI -c overrides alone do not change the daemon's default thread-list provider.
    config.model_provider = "openai";
    delete config.openai_base_url;
    const providers = config.model_providers as Record<string, unknown> | undefined;
    if (providers) delete providers.openai;
    const plugins = config.plugins as Record<string, Record<string, unknown>> | undefined;
    for (const [id, plugin] of Object.entries(plugins ?? {})) {
      if (id.split("@")[0] === "headroom") plugin.enabled = false;
    }
    if (existingConfig) {
      const existing = parsePrivateSettings(parse, await readFile(configPath, "utf8"), configPath);
      // Native confirmations and additional folder-trust decisions belong to this home.
      config.projects = { ...config.projects as object, ...existing.projects as object };
      const hooks = config.hooks as Record<string, unknown> | undefined;
      const savedHooks = existing.hooks as Record<string, unknown> | undefined;
      if (savedHooks?.state) config.hooks = { ...hooks, state: { ...hooks?.state as object, ...savedHooks.state as object } };
    }
    const hooks = hooksSource ? parsePrivateSettings(JSON.parse, hooksSource, join(this.sourceDirectory, "hooks.json")) as { hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>> } : { hooks: {} };
    for (const [event, groups] of Object.entries(hooks.hooks ?? {})) {
      hooks.hooks![event] = groups.map((group) => ({
        ...group,
        hooks: (group.hooks ?? []).filter((hook) => !/\bheadroom(?:\b|[-_])/iu.test(hook.command ?? "")),
      })).filter((group) => (group.hooks?.length ?? 0) > 0);
    }
    // Record ownership before replacing the hooks link so an interrupted migration can retry.
    await this.writeManagedFile(join(this.directory, HOOKS_MARKER), this.sourceDirectory);
    await this.writeManagedFile(configPath, CONFIG_MARKER + stringify(config));
    await this.writeManagedFile(hooksPath, JSON.stringify(hooks, null, 2) + "\n");
  }

  /** Migrate only the old exact source symlink; preserve independent operator files. */
  private async managedEntry(name: string, isManaged: () => Promise<boolean>): Promise<boolean> {
    const destination = join(this.directory, name);
    const entry = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!entry) return false;
    if (entry.isSymbolicLink()
      && resolve(dirname(destination), await readlink(destination)) === join(this.sourceDirectory, name)) return false;
    if (entry.isFile() && await isManaged()) return true;
    throw new Error(`Codex orchestrator home contains an independent ${name}: ${destination}`);
  }

  private async writeManagedFile(path: string, contents: string): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(contents);
      await file.close();
      await rename(temporary, path);
    } finally {
      await file.close();
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
}

function parsePrivateSettings<T>(parser: (text: string) => T, text: string, path: string): T {
  try { return parser(text); } catch {
    // Parser diagnostics can quote adjacent API keys or hook environment values.
    throw new Error(`Invalid Codex settings at ${path}; check the file syntax`);
  }
}

function missingText(error: NodeJS.ErrnoException): string {
  if (error.code === "ENOENT") return "";
  throw error;
}
