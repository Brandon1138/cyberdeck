import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { appendFile, mkdir, readFile, realpath } from "node:fs/promises";

export interface CodexWorkspaceTrustOptions {
  configPath?: string;
  canonicalize?: (path: string) => Promise<string>;
}

/**
 * Persists the exact authorized Cyberdeck cwd in Codex's own trust store: a
 * `[projects."<path>"] trust_level = "trusted"` table in `~/.codex/config.toml`, the same records
 * `codex` writes when the operator answers its folder-trust dialog by hand (confirmed against the
 * operator's live file). An untrusted cwd parks a Codex worker at that dialog at 0 turns.
 *
 * The operator's config is never rewritten. TOML tables are order-independent, so a missing entry
 * is added by *appending* a table at end of file — the one edit that cannot disturb any existing
 * line — and an existing entry, whatever its trust level, is left exactly as the operator set it.
 * Only the exact canonical cwd is named, never a parent.
 */
export class CodexWorkspaceTrust {
  readonly configPath: string;
  private tail = Promise.resolve();

  constructor(private readonly options: CodexWorkspaceTrustOptions = {}) {
    this.configPath = options.configPath ?? join(homedir(), ".codex", "config.toml");
  }

  trust(cwd: string): Promise<string> {
    const operation = this.tail.then(() => this.persist(cwd));
    this.tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async persist(cwd: string): Promise<string> {
    const canonical = await (this.options.canonicalize ?? realpath)(cwd);
    const source = await readFile(this.configPath, "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return "";
        throw error;
      },
    );
    if (hasProjectTable(source, canonical)) return canonical;

    await mkdir(dirname(this.configPath), { recursive: true });
    const separator = source === "" || source.endsWith("\n") ? "" : "\n";
    const entry = `${separator}\n[projects.${tomlBasicString(canonical)}]\ntrust_level = "trusted"\n`;
    await appendFile(this.configPath, entry, { encoding: "utf8", mode: 0o600 });
    return canonical;
  }
}

/**
 * Whether the config already carries a `[projects."<path>"]` table for this exact path, in either
 * of the two header spellings TOML allows for it. Presence is enough: an entry the operator set to
 * something other than `trusted` is an operator decision this writer must not override.
 */
function hasProjectTable(source: string, path: string): boolean {
  const escaped = tomlBasicString(path).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const literal = `'${path}'`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const header = new RegExp(`^\\s*\\[projects\\.(?:${escaped}|${literal})\\]`, "mu");
  return header.test(source);
}

/** A TOML basic (double-quoted) string for one path, escaping exactly what TOML requires. */
function tomlBasicString(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, (char) =>
      `\\u${char.charCodeAt(0).toString(16).padStart(4, "0").toUpperCase()}`);
  return `"${escaped}"`;
}
