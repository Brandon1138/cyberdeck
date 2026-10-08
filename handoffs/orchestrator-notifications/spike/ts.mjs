// prefix every stdin line with an ISO timestamp (latency evidence)
import { createInterface } from "node:readline";
createInterface({ input: process.stdin }).on("line", (l) => process.stdout.write(`${new Date().toISOString()} ${l}\n`));
