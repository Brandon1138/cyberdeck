import { join } from "node:path";
import type { SessionRecord } from "../../domain/session.js";
import type { CyberdeckMcpLaunch } from "../provider.js";
import {
  sessionLaunchFilePath,
  writeSessionLaunchFile,
  type SessionLaunchFilesOptions,
} from "../session-launch-files.js";

/**
 * Host the Cyberdeck MCP server inside one Cursor session without touching operator or repository
 * state.
 *
 * Cursor reads MCP server definitions from exactly three places, measured against
 * `agent 2026.07.23-e383d2b`: `$HOME/.cursor/mcp.json` (resolved through `homedir()`, *not*
 * `CURSOR_CONFIG_DIR`), `<workspace root>/.cursor/mcp.json` for each workspace root, and the
 * `.mcp.json` of every loaded plugin. The first would mean overriding `HOME` for the provider
 * process, which loses the operator's Cursor credentials and lies to every command the agent runs;
 * the second is a repository mutation. A plugin directory passed with `--plugin-dir` is the only
 * remaining seam, and it is the one that behaves: the server is registered without the launch-time
 * "MCP Server Approval Required" modal that a project-scoped server raises, and `--add-dir` roots
 * are not scanned for MCP configuration at all.
 *
 * Cursor derives the server identifier as `plugin-<plugin directory basename>-<server key>`, so the
 * directory is named `cyberdeck` deliberately: the identifier it produces is the one the permission
 * entry below names.
 *
 * Loading a server is not permission to call it. A tool call is refused ("User rejected MCP") unless
 * the session's permission configuration allows it, which is why a session-scoped
 * `CURSOR_CONFIG_DIR` carrying a minimal `cli-config.json` ships alongside the plugin. That config
 * is deliberately minimal rather than a copy of the operator's: it pre-approves Cyberdeck's own
 * tools and nothing else, so an MCP-hosting session is never *wider* than the operator's own
 * configuration, only narrower. `CURSOR_CONFIG_DIR` does not carry credentials — a redirected
 * config directory still reports the operator as logged in.
 */
const PLUGIN_DIRECTORY_NAME = "cyberdeck";
const MCP_SERVER_KEY = "cyberdeck";

/** The identifier Cursor composes for the injected server, and therefore the one it permits by. */
export const CURSOR_CYBERDECK_MCP_IDENTIFIER =
  `plugin-${PLUGIN_DIRECTORY_NAME}-${MCP_SERVER_KEY}`;

export interface CursorMcpHostPaths {
  /** Passed as `--plugin-dir`; its basename is part of the server identifier. */
  pluginDirectory: string;
  /** Exported as `CURSOR_CONFIG_DIR`; holds the permission entry for the injected server. */
  configDirectory: string;
}

export function cursorMcpHostPaths(
  sessionId: string,
  options: SessionLaunchFilesOptions = {},
): CursorMcpHostPaths {
  return {
    pluginDirectory: sessionLaunchFilePath(
      sessionId,
      join("cursor-mcp", PLUGIN_DIRECTORY_NAME),
      options,
    ),
    configDirectory: sessionLaunchFilePath(sessionId, join("cursor-mcp", "config"), options),
  };
}

/**
 * Write the plugin manifest, its MCP definition, and the permission configuration.
 *
 * Every write is a full overwrite of a session-scoped path, so this is safe to run on each launch
 * and each resume, which is what the `prepareLaunch` contract requires.
 */
export async function writeCursorMcpHost(
  session: SessionRecord,
  mcp: CyberdeckMcpLaunch,
  options: SessionLaunchFilesOptions = {},
): Promise<void> {
  const pluginRoot = join("cursor-mcp", PLUGIN_DIRECTORY_NAME);
  await Promise.all([
    writeSessionLaunchFile(
      session.id,
      join(pluginRoot, ".cursor-plugin", "plugin.json"),
      `${JSON.stringify({
        name: PLUGIN_DIRECTORY_NAME,
        version: "1.0.0",
        description: "Cyberdeck broker control plane for this session",
      }, null, 2)}\n`,
      options,
    ),
    writeSessionLaunchFile(
      session.id,
      join(pluginRoot, ".mcp.json"),
      `${JSON.stringify({
        mcpServers: {
          [MCP_SERVER_KEY]: {
            command: mcp.nodePath,
            args: [mcp.cliPath, "mcp", "--actor-session", session.id],
          },
        },
      }, null, 2)}\n`,
      options,
    ),
    writeSessionLaunchFile(
      session.id,
      join("cursor-mcp", "config", "cli-config.json"),
      `${JSON.stringify({
        version: 1,
        approvalMode: "allowlist",
        permissions: {
          allow: [`Mcp(${CURSOR_CYBERDECK_MCP_IDENTIFIER}:*)`],
          deny: [],
        },
      }, null, 2)}\n`,
      options,
    ),
  ]);
}
