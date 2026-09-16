import { resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { runBroker } from "../src/broker/main.js";
import { appStateDirectory, brokerSocketPath } from "../src/broker/app-paths.js";

const [state, socket] = process.argv.slice(2);
if (!state || !socket || !resolve(state).startsWith("/private/tmp/cyberdeck-resource-")
  || !resolve(socket).startsWith("/private/tmp/cd-resource-") || socket === brokerSocketPath
  || await realpath(state) === await realpath(appStateDirectory)) throw new Error("ISOLATED_RESOURCE_PATHS_REQUIRED");
await runBroker(socket, state);
console.log(JSON.stringify({ pid: process.pid, state, socket, mode: "isolated-headless" }));
