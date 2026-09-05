import type { Command } from "commander";
import { writeFile } from "node:fs/promises";
import { withClient } from "./runtime.js";
export function registerActivityCommands(program: Command): void {
  program.command("execution-health")
    .description("Inspect executor connection, physical queue, and durable execution records")
    .action(async () => { process.stdout.write(JSON.stringify(await withClient((client) => client.request("execution.health", {})), null, 2) + "\n"); });
  program.command("execution-cancel")
    .description("Cancel a queued worker launch or stop its active process")
    .requiredOption("--session <uuid>", "session identity from execution-health")
    .action(async (options: { session: string }) => {
      process.stdout.write(JSON.stringify(await withClient((client) => client.request("session.stopOne", { sessionId: options.session }))) + "\n");
    });
  program.command("activity-pin")
    .description("Pin a local incident run against retention; full capacity degrades recording visibly")
    .requiredOption("--run <uuid>", "run or instruction identity")
    .option("--release", "release this retention pin")
    .action(async (options: { run: string; release?: boolean }) => {
      const result = await withClient((client) => client.request("activity.pin", { runId: options.run, pinned: !options.release }));
      process.stdout.write(JSON.stringify(result) + "\n");
    });
  program.command("activity")
    .description("Inspect bounded local causal activity and recording coverage")
    .option("--run <uuid>", "run or instruction identity")
    .option("--session <uuid>", "all runs and lifecycle events for one session")
    .option("--after <sequence>", "exclusive sequence cursor", "0")
    .option("--limit <count>", "at most 1000 events", "100")
    .option("--export <path>", "write this bounded page to a new local JSON file")
    .action(async (options: { run?: string; session?: string; after: string; limit: string; export?: string }) => {
      if (Boolean(options.run) === Boolean(options.session)) throw new Error("Specify exactly one of --run or --session");
      const method = options.session ? "activity.readSession" : "activity.read";
      const selector = options.session ? { sessionId: options.session } : { runId: options.run };
      const result = await withClient((client) => client.request(method, { ...selector, afterSequence: Number(options.after), limit: Number(options.limit) }));
      const output = JSON.stringify(result, null, 2) + "\n";
      if (options.export) await writeFile(options.export, output, { flag: "wx", mode: 0o600 });
      else process.stdout.write(output);
    });
}
