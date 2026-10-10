import { constants } from "node:buffer";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("replays a journal exceeding Node's string limit with a 128 MiB heap", async () => {
  const root = await mkdtemp(join(tmpdir(), "cyberdeck-large-journal-"));
  try {
    const directory = join(root, "orchestration");
    await mkdir(directory);
    const path = join(directory, "worker-coordination-v1.jsonl");
    const file = await open(path, "w");
    const bytesPerRecord = 1024 * 1024;
    const records = Math.floor(constants.MAX_STRING_LENGTH / bytesPerRecord) + 1;
    try {
      for (let i = 0; i < records; i++) {
        const line = JSON.stringify({ schemaVersion: 1, recordType: "worker-coordination.transaction",
          transactionId: randomUUID(), persistedAt: "2026-10-10T00:00:00.000Z" });
        await file.writeFile(line + " ".repeat(bytesPerRecord - line.length - 1) + "\n");
      }
    } finally { await file.close(); }
    expect((await stat(path)).size).toBeGreaterThan(constants.MAX_STRING_LENGTH);
    const module = new URL("../../src/persistence/worker-coordination-store.ts", import.meta.url).href;
    const code = `import { WorkerCoordinationStore } from ${JSON.stringify(module)};
      const state = await new WorkerCoordinationStore(${JSON.stringify(root)}, { checkpointBytes: Number.MAX_SAFE_INTEGER }).load();
      console.log(JSON.stringify(state));`;
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--max-old-space-size=128", "--import", import.meta.resolve("tsx"), "--input-type=module", "-e", code],
        { stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", (data) => { output += data; });
      child.stderr.on("data", (data) => { output += data; });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, output }));
    });
    expect(result.code, result.output).toBe(0);
    expect(JSON.parse(result.output)).toEqual({ subjects: [], events: [], checkpoints: [], audits: [], liveness: [], handoffs: [], receipts: [] });
  } finally { await rm(root, { recursive: true, force: true }); }
}, 120_000);
