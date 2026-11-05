import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { cpus, tmpdir, release } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(process.argv[2] ?? "docs/performance/rust-core/latest.json");
const rounds = Number(process.env.CYBERDECK_BENCH_ROUNDS ?? 5);
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 50) throw new Error("Invalid benchmark rounds");
const work = await mkdtemp(join(tmpdir(), "cyberdeck-core-bench-"));
const binary = join(root, `native/bin/${process.platform}-${process.arch}/cyberdeck-core`);
const command = (exe, args) => {
  const result = spawnSync(exe, args, { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw result.error ?? new Error(result.stderr || `${exe} exited ${result.status}`);
  return result.stdout.trim();
};
const uuid = (n) => `${n.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
const shapes = [
  { name: "small", rows: 64, retained: 32, payload: 256 },
  { name: "history", rows: 50_000, retained: 576, payload: 768 },
  { name: "wide", rows: 10_000, retained: 10_000, payload: 256 },
];
const modes = ["legacy-typescript", "typescript", "streaming-typescript", "rust"];
const measuredFiles = ["package.json", "pnpm-lock.yaml", "rust-toolchain.toml", "native/core/Cargo.toml", "native/core/Cargo.lock",
  ...["lib", "main", "instruction", "validation"].map((name) => `native/core/src/${name}.rs`),
  ...["instruction-store", "validated-journal", "native-instruction-replay"].flatMap((name) => [`src/persistence/${name}.ts`, `dist/src/persistence/${name}.js`]),
  "src/domain/instruction.ts", "dist/src/domain/instruction.js", "src/domain/worker-truth.ts", "dist/src/domain/worker-truth.js",
  ...["bench-native-core.mjs", "bench-native-core-worker.mjs", "bench-native-core-rss.py"].map((name) => `scripts/${name}`)];
const result = {
  protocol: 1, createdAt: new Date().toISOString(), head: command("git", ["rev-parse", "HEAD"]),
  dirty: command("git", ["status", "--porcelain"]).length !== 0,
  node: process.version, rust: command("rustc", ["--version"]), platform: process.platform, arch: process.arch,
  os: release(), cpu: cpus()[0]?.model, rounds, binarySha256: createHash("sha256").update(readFileSync(binary)).digest("hex"),
  fileSha256: Object.fromEntries(measuredFiles.map((name) => [name, createHash("sha256").update(readFileSync(join(root, name))).digest("hex")])),
  methodology: "Fresh process per cold sample, warm OS cache, alternating modes, five same-process warm reads; cold operation includes helper spawn/IPC/host validation. Node RSS and standalone helper RSS are separate peaks, not aggregate peak. No real provider or broker.",
  workloads: [],
};
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
try {
  for (const shape of shapes) {
    const directory = join(work, shape.name), journal = join(directory, "orchestration/instructions.jsonl");
    await mkdir(join(directory, "orchestration"), { recursive: true });
    const stream = createWriteStream(journal), hash = createHash("sha256");
    for (let i = 0; i < shape.rows; i++) {
      const row = JSON.stringify({ id: uuid(i % shape.retained + 1), actorSessionId: uuid(1), targetSessionId: uuid(2),
        messageId: uuid(i % shape.retained + 1), message: "x".repeat(shape.payload) + i, status: i % 3 ? "completed" : "queued",
        createdAt: "2026-11-05T00:00:00.000Z", updatedAt: "2026-11-05T00:00:00.000Z", hop: i % 4 }) + "\n";
      hash.update(row); if (!stream.write(row)) await once(stream, "drain");
    }
    stream.end(); await once(stream, "finish");
    const samples = [], helperRss = [];
    for (let round = 0; round < rounds; round++) {
      for (let offset = 0; offset < modes.length; offset++) {
        const mode = modes[(offset + round) % modes.length], start = performance.now();
        const sample = JSON.parse(command(process.execPath, ["scripts/bench-native-core-worker.mjs", mode, directory]));
        samples.push({ round, ...sample, processWallMs: performance.now() - start });
      }
      helperRss.push(JSON.parse(command("python3", ["scripts/bench-native-core-rss.py", binary, journal])).standaloneHelperPeakRssMiB);
    }
    if (new Set(samples.map((s) => s.digest)).size !== 1 || samples.some((s) => s.records !== shape.retained)) throw new Error(`Projection mismatch: ${shape.name}`);
    const summary = Object.fromEntries(modes.map((mode) => {
      const rows = samples.filter((s) => s.mode === mode);
      return [mode, { coldMs: median(rows.map((s) => s.coldMs)), warmMs: median(rows.flatMap((s) => s.warmMs)),
        hostColdPeakRssMiB: median(rows.map((s) => s.hostColdPeakRssMiB)) }];
    }));
    result.workloads.push({ ...shape, bytes: (await stat(journal)).size, sha256: hash.digest("hex"), samples, helperRss, summary });
    console.log(shape.name, JSON.stringify(summary), "standalone helper MiB", median(helperRss));
  }
  await mkdir(resolve(output, ".."), { recursive: true });
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
  console.log(`Raw evidence: ${output}`);
} finally { await rm(work, { recursive: true, force: true }); }
