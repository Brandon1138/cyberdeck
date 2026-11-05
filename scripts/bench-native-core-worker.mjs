import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { InstructionStore } from "../dist/src/persistence/instruction-store.js";
import { InstructionRecordSchema } from "../dist/src/domain/instruction.js";
import { ValidatedJournal } from "../dist/src/persistence/validated-journal.js";

const [mode, directory] = process.argv.slice(2);
const path = join(directory, "orchestration/instructions.jsonl");
const parse = (text) => {
  const records = new Map();
  for (const line of text.split("\n").slice(0, -1)) {
    if (!line.trim()) continue;
    const record = InstructionRecordSchema.parse(JSON.parse(line)); records.set(record.id, record);
  }
  return records;
};
async function streaming(file) {
  const records = new Map(), decoder = new TextDecoder();
  let pending = "", position = 0;
  for (;;) {
    const bytes = Buffer.allocUnsafe(64 * 1024);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, position);
    if (!bytesRead) break;
    position += bytesRead;
    pending += decoder.decode(bytes.subarray(0, bytesRead), { stream: true });
    let newline;
    while ((newline = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
      if (!line.trim()) continue;
      const record = InstructionRecordSchema.parse(JSON.parse(line)); records.set(record.id, record);
    }
  }
  return records;
}
let read;
if (mode === "legacy-typescript") read = async () => [...parse(await readFile(path, "utf8")).values()];
else if (mode === "streaming-typescript") {
  const journal = new ValidatedJournal(path, parse, streaming);
  read = async () => structuredClone([...(await journal.read()).values()]);
} else {
  const store = new InstructionStore(directory, { replay: mode }); read = () => store.list();
}
const start = performance.now();
const records = await read();
const coldMs = performance.now() - start;
const hostColdPeakRssMiB = process.resourceUsage().maxRSS / 1024;
const warmMs = [];
for (let i = 0; i < 5; i++) { const start = performance.now(); await read(); warmMs.push(performance.now() - start); }
process.stdout.write(JSON.stringify({ mode, startupMs: start, coldMs, warmMs, hostColdPeakRssMiB,
  hostProcessPeakRssMiB: process.resourceUsage().maxRSS / 1024, records: records.length,
  digest: createHash("sha256").update(JSON.stringify(records)).digest("hex") }) + "\n");
