import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { SessionKind } from "../../domain/session.js";
import { appStateDirectory } from "../../paths.js";

/**
 * `--strict-mcp-config` makes a session's injected config exclusive, which also excludes the
 * operator's own servers: a session asked to reach Linear could see that its tools were absent but
 * not why. The allowlist is the narrow reopening — the operator names servers one at a time, so a
 * server installed later never joins a Cyberdeck session by default.
 *
 * One file per session kind, because the two have different appetites. An orchestrator's authority
 * is Cyberdeck's own tools; a worker sent at a Linear or Obsidian task legitimately needs that
 * server, but only the ones the operator named. Either list is edited in exactly this one place.
 *
 * Names only. Definitions are resolved from the operator's `~/.claude.json` user scope so there is
 * one source of truth and no second copy of a server's credentials to drift or leak. A name with no
 * user-scope definition is skipped rather than failing the launch: a project-scoped server is not
 * reachable this way, and a session that cannot start is worse than one missing a connector.
 *
 * Belongs in `brokerConfigPath` eventually. It is a separate file today because threading broker
 * config into the provider adapter is a wider change than reopening this hole warranted.
 */
function defaultAllowlistPath(kind: SessionKind): string {
  return join(appStateDirectory, `${kind}-mcp.json`);
}
const defaultOperatorConfigPath = join(homedir(), ".claude.json");

/** Both paths are absolute operator state, so tests must be able to point them somewhere else. */
export interface McpAllowlistPaths {
  allowlistPath?: string;
  operatorConfigPath?: string;
}

const AllowlistSchema = z.object({
  servers: z.array(z.string().trim().min(1)).default([]),
});

const OperatorConfigSchema = z.object({
  mcpServers: z.record(z.string(), z.unknown()).default({}),
});

/**
 * Resolved ambient servers for one session kind, keyed by server name. Cyberdeck's own server is
 * never resolvable here: callers spread it last, and `cyberdeck` is dropped so an allowlist entry
 * cannot redirect a session's own control plane at another process.
 */
export async function resolveAllowlistedMcpServers(
  kind: SessionKind,
  paths: McpAllowlistPaths = {},
): Promise<Record<string, unknown>> {
  const allowlist = await readJsonFile(
    paths.allowlistPath ?? defaultAllowlistPath(kind),
    AllowlistSchema,
  );
  const names = allowlist?.servers.filter((name) => name !== "cyberdeck") ?? [];
  if (names.length === 0) return {};

  const operatorConfig = await readJsonFile(
    paths.operatorConfigPath ?? defaultOperatorConfigPath,
    OperatorConfigSchema,
  );
  if (operatorConfig === undefined) return {};

  const resolved: Record<string, unknown> = {};
  for (const name of names) {
    const definition = operatorConfig.mcpServers[name];
    if (definition !== undefined) resolved[name] = definition;
  }
  return resolved;
}

/**
 * A missing, unreadable, or malformed file is indistinguishable from an empty allowlist on purpose.
 * Both mean "no ambient servers", and neither is worth failing a launch over.
 */
async function readJsonFile<T>(
  path: string,
  schema: z.ZodType<T>,
): Promise<T | undefined> {
  try {
    const parsed = schema.safeParse(JSON.parse(await readFile(path, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
