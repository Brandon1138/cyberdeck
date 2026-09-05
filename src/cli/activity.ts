import type { Command } from "commander";
import { writeFile } from "node:fs/promises";
import { withClient } from "./runtime.js";
export function registerActivityCommands(program: Command): void {
  program.command("activity")
    .description("Inspect bounded local causal activity and recording coverage")
    .requiredOption("--run <uuid>", "run or instruction identity")
    .option("--after <sequence>", "exclusive sequence cursor", "0")
    .option("--limit <count>", "at most 1000 events", "100")
    .option("--export <path>", "write this bounded page to a new local JSON file")
    .action(async (options: { run: string; after: string; limit: string; export?: string }) => {
      const result = await withClient((client) => client.request("activity.read", { runId: options.run, afterSequence: Number(options.after), limit: Number(options.limit) }));
      const output = JSON.stringify(result, null, 2) + "\n";
      if (options.export) await writeFile(options.export, output, { flag: "wx", mode: 0o600 });
      else process.stdout.write(output);
    });
}
