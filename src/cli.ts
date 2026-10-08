#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Providers keep invoking the same entrypoint. MCP never imports the broker/toolkit graph.
const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath !== undefined && realpathSync(invokedPath) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const program = process.argv[2] === "mcp"
      ? (await import("./cli/mcp.js")).createMcpProgram()
      : (await import("./cli/full-program.js")).createProgram();
    await program.parseAsync();
  } catch (error) {
    const prefix = error instanceof Error && error.name === "RpcError" && "code" in error ? `${error.code}: ` : "";
    process.stderr.write(`${prefix}${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
