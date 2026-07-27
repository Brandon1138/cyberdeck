import { execFile } from "node:child_process";
import { chmod, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { SessionRecord } from "../../domain/session.js";
import type { ProviderLaunchSpec } from "../provider.js";
import { ProviderMcpIsolationError } from "../session-adapter-errors.js";
import { ensurePrivateDirectory } from "../../persistence/private-files.js";

const execFileAsync = promisify(execFile);
const DISABLE_ANCHOR = "__cyberdeck_scout_isolation__";

/**
 * Disable every user/project MCP server inside Scout's isolated Cursor data directory. One native
 * Cursor command discovers its version-specific project-state path; Cyberdeck then writes the full
 * disabled identifier set there. Global Cursor state remains untouched.
 */
export async function isolateCursorScoutMcp(
  session: SessionRecord,
  spec: ProviderLaunchSpec,
): Promise<void> {
  const scout = session.scout;
  if (session.profile !== "scout" || scout === undefined) return;
  try {
    const identifiers = await configuredMcpIdentifiers(
      session.cwd,
      spec.env.HOME ?? homedir(),
    );
    await prepareScratchDirectories(scout.dropBoxPath);
    await execFileAsync(spec.executable, ["mcp", "disable", DISABLE_ANCHOR], {
      cwd: session.cwd,
      env: spec.env,
      encoding: "utf8",
      timeout: 8_000,
      maxBuffer: 256 * 1024,
    });
    const disabledPath = await findDisabledStore(join(scout.dropBoxPath, "cursor-data"));
    const disabled = [...new Set([DISABLE_ANCHOR, ...identifiers])].sort();
    await writeFile(disabledPath, `${JSON.stringify(disabled, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(disabledPath, 0o600);
  } catch (error) {
    throw new ProviderMcpIsolationError(
      `Scout could not disable Cursor MCP tools: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function configuredMcpIdentifiers(cwd: string, home: string): Promise<string[]> {
  const identifiers = new Set<string>();
  for (const path of [
    join(home, ".cursor", "mcp.json"),
    join(cwd, ".cursor", "mcp.json"),
  ]) {
    const content = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (content === undefined) continue;
    const parsed = JSON.parse(content) as { mcpServers?: unknown };
    if (
      parsed.mcpServers === undefined
      || typeof parsed.mcpServers !== "object"
      || parsed.mcpServers === null
      || Array.isArray(parsed.mcpServers)
    ) {
      throw new Error(`Invalid MCP configuration at ${path}`);
    }
    for (const identifier of Object.keys(parsed.mcpServers)) identifiers.add(identifier);
  }
  return [...identifiers];
}

async function prepareScratchDirectories(dropBoxPath: string): Promise<void> {
  await Promise.all([
    ensurePrivateDirectory(join(dropBoxPath, "cursor-config")),
    ensurePrivateDirectory(join(dropBoxPath, "cursor-data")),
    ensurePrivateDirectory(join(dropBoxPath, "node-cache")),
    ensurePrivateDirectory(join(dropBoxPath, "tmp")),
  ]);
}

async function findDisabledStore(dataDirectory: string): Promise<string> {
  const projects = join(dataDirectory, "projects");
  const queue = [projects];
  while (queue.length > 0) {
    const directory = queue.shift()!;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) queue.push(path);
      else if (entry.isFile() && entry.name === "mcp-disabled.json") return path;
    }
  }
  throw new Error("Cursor did not create isolated MCP disabled store");
}

