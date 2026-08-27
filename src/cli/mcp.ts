import { Command } from "commander";
import { brokerSocketPath } from "../broker/app-paths.js";
import { RpcClient } from "../client/rpc-client.js";
import { resolveLaunchConversationId, runMcpServer } from "../mcp/server.js";
import type { CliProgramContext } from "./program.js";

export function registerMcpCommands(program: Command, _context: CliProgramContext): void {
  program.command("mcp")
    .description("serve capability-scoped Cyberdeck tools over stdio MCP")
    .requiredOption("--actor-session <id>", "bound orchestrator session UUID")
    .action(async (options: { actorSession: string; }) => {
      const conversationId = resolveLaunchConversationId();
      const identity = {
        actorSessionId: options.actorSession,
        ...(conversationId === undefined ? {} : { launchConversationId: conversationId }),
        brokerSocketPath,
      };
      let client: RpcClient;
      try {
        client = await RpcClient.connect(brokerSocketPath);
      } catch (error) {
        // Exiting here is what made the failure silent: the harness drops the whole server and the
        // conversation simply stops having cyberdeck_* tools, with nothing to read. Serve instead,
        // so tools/list still advertises the surface and every call names the missing broker.
        await runMcpServer({
          identity,
          brokerUnavailable:
            `Cyberdeck broker is unreachable at ${brokerSocketPath}: ${error instanceof Error ? error.message : String(error)}`,
        });
        return;
      }
      try {
        await runMcpServer({ transport: client, identity });
      } finally {
        client.close();
      }
    });

}

