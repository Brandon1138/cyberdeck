import { Command } from "commander";
import type { CliProgramContext } from "./program.js";
import { startDetachedBroker, withClient } from "./runtime.js";

export function registerBrokerCommands(program: Command, context: CliProgramContext): void {
  const { restartBroker, toolkit } = context;
  const broker = program.command("broker").description("manage the durable broker process");
  broker.command("run").action(async () => {
    await toolkit.runBroker();
  });
  broker.command("start").action(startDetachedBroker);
  broker.command("status").action(async () => {
    const status = await withClient((client) => client.request("broker.status", {}));
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  });
  broker.command("stop").action(async () => {
    await withClient((client) => client.request("broker.shutdown", {}));
    process.stdout.write("Cyberdeck broker shutdown requested\n");
  });
  broker.command("restart").description("gracefully replace the running broker").action(restartBroker);

}

