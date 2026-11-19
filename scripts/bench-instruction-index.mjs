// node scripts/bench-instruction-index.mjs /path/to/built/base-checkout output.json
import { createHash } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { cpus, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { promisify } from "node:util";

const here = fileURLToPath(import.meta.url);
const current = resolve(dirname(here), "..");
const shapes = { small: [64, 32], history: [50000, 576], wide: [10000, 10000] };
const modes = ["baseline", "typescript", "rust"];
const uuid = (n) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const target = (i) => uuid(200000 + (i % 128));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const quantile = (samples, q) => [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * q) - 1];
const row = (i) => ({
  id: uuid(i),
  actorSessionId: uuid(100001),
  targetSessionId: target(i),
  messageId: uuid(i + 300000),
  message: "bench ".repeat(80).trim(),
  status: "queued",
  hop: 0,
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-01T00:00:00Z",
});

async function sample(base, mode, shape, root, kind) {
  if (mode === "rust") process.env.CYBERDECK_INSTRUCTION_INDEX = "rust";
  else delete process.env.CYBERDECK_INSTRUCTION_INDEX;
  const build = join(mode === "baseline" ? base : current, "dist/src");
  if (kind === "broker") {
    const start = performance.now();
    const { runBroker } = await import(pathToFileURL(join(build, "broker/main.js")));
    const { RpcClient } = await import(pathToFileURL(join(build, "client/rpc-client.js")));
    const socket = join(root, "sock");
    const server = await runBroker(socket, root);
    const client = await RpcClient.connect(socket);
    const rows = await client.request("agent.instruction.list", { targetSessionId: target(0) });
    const readyMs = performance.now() - start;
    if (!rows.length || rows.some((r) => r.status !== "completed")) throw Error("Unexpected broker result");
    const digest = createHash("sha256")
      .update(JSON.stringify(rows.map((r) => r.id)))
      .digest("hex");
    await sleep(60);
    await client.request("broker.shutdown", {});
    client.close();
    await server.close();
    console.log(JSON.stringify({ readyMs, initialRows: rows.length, digest }));
    return;
  }
  const module = pathToFileURL(join(build, "persistence/instruction-store.js"));
  const { InstructionStore } = await import(module);
  const store = new InstructionStore(root);
  const [count, retained] = shapes[shape];
  const loop = monitorEventLoopDelay({ resolution: 5 });
  const time = async (op) => {
    const start = performance.now();
    const value = await op();
    return [performance.now() - start, value];
  };
  const initial = await time(() => store.list(target(0)));
  const warm = [],
    loaded = [];
  for (let i = 0; i < 48; i++) warm.push((await time(() => store.list(target(i))))[0]);
  await sleep(10);
  loop.enable();
  await sleep(10);
  const writeStart = performance.now();
  const [writeMs] = await Promise.all([
    (async () => {
      for (let i = 0; i < 4; i++) await store.put({ ...row(i), status: "submitted" });
      return performance.now() - writeStart;
    })(),
    (async () => {
      for (let i = 0; i < 48; i++) loaded.push((await time(() => store.list(target(i))))[0]);
    })(),
  ]);
  await sleep(10);
  loop.disable();
  const rows = await store.list();
  const canonical = rows.map((r) => [
    r.id,
    r.targetSessionId,
    r.message,
    r.status,
    r.messageId,
    r.hop,
    r.actorSessionId,
    r.createdAt,
    r.updatedAt,
  ]);
  if (rows.length !== retained || rows.slice(0, 4).some((r) => r.status !== "submitted"))
    throw Error("Wrong projection");
  await sleep(60); // give the external RSS sampler a final simultaneous observation
  const usage = process.resourceUsage();
  const result = {
    count,
    retained,
    coldTargetMs: initial[0],
    initialRows: initial[1].length,
    warmP50: quantile(warm, 0.5),
    warmP99: quantile(warm, 0.99),
    loadedP50: quantile(loaded, 0.5),
    loadedP99: quantile(loaded, 0.99),
    fourWritesMs: writeMs,
    eventLoopMaxMs: loop.max / 1e6,
    nodePeakMiB: usage.maxRSS / 1024,
    digest: createHash("sha256").update(JSON.stringify(canonical)).digest("hex"),
  };
  store.close?.();
  console.log(JSON.stringify(result));
}

async function trial(base, mode, shape, kind) {
  const root = await mkdtemp(join(tmpdir(), "cdi-"));
  let worker;
  try {
    await mkdir(join(root, "orchestration"));
    const [count, retained] = shapes[shape];
    const lines = Array.from(
      { length: retained },
      (_, i) => JSON.stringify({ ...row(i), status: kind === "broker" ? "completed" : "queued" }) + "\n",
    );
    const fixture = Array.from({ length: count }, (_, i) => lines[i % retained]).join("");
    await writeFile(join(root, "orchestration", "instructions.jsonl"), fixture);
    worker = spawn(process.execPath, [here, "--sample", base, mode, shape, root, kind], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "",
      errors = "",
      peakKiB = 0,
      samples = 0;
    worker.stdout.on("data", (b) => (output += b));
    worker.stderr.on("data", (b) => (errors += b));
    const finished = once(worker, "close");
    // Read only pid/parent/RSS. Sum simultaneous observations for this isolated process tree.
    const ps = promisify(execFile);
    const deadline = Date.now() + 90_000;
    while (worker.exitCode === null && worker.signalCode === null) {
      if (Date.now() > deadline) throw Error("Benchmark timed out: " + mode + "/" + shape);
      const { stdout } = await ps("/bin/ps", ["-axo", "pid=,ppid=,rss="], { maxBuffer: 16 * 1024 * 1024 });
      const rows = stdout
        .trim()
        .split(/\n/)
        .map((l) => l.trim().split(/\s+/).map(Number));
      const rss = rows
        .filter(([pid, ppid]) => pid === worker.pid || ppid === worker.pid)
        .reduce((n, r) => n + r[2], 0);
      if (rss > 0) {
        samples++;
        peakKiB = Math.max(peakKiB, rss);
      }
      await sleep(25);
    }
    const [exit] = await finished;
    if (exit !== 0 || errors || !samples) throw Error(`failed ${mode}/${shape}: ${errors || exit}`);
    return { shape, mode, treeSampledPeakMiB: peakKiB / 1024, rssSamples: samples, ...JSON.parse(output) };
  } finally {
    if (worker && worker.exitCode === null && worker.signalCode === null) {
      const ended = once(worker, "close");
      worker.kill("SIGKILL");
      await ended;
    }
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[2] === "--sample") {
  await sample(...process.argv.slice(3));
} else {
  const [base, out, kind = "store"] = process.argv.slice(2);
  if (!base || !out) throw Error("Provide built baseline checkout and output JSON path");
  const rounds = Number(process.env.BENCH_ROUNDS ?? 3),
    results = [];
  for (let round = 0; round < rounds; round++)
    for (const shape of Object.keys(shapes)) {
      for (let i = 0; i < modes.length; i++) {
        const result = await trial(resolve(base), modes[(i + round) % modes.length], shape, kind);
        const previous = results.find((r) => r.shape === shape);
        if (previous && (result.digest !== previous.digest || result.initialRows !== previous.initialRows))
          throw Error("Projection mismatch");
        results.push({ round, ...result });
      }
    }
  await writeFile(
    out,
    JSON.stringify(
      {
        node: process.version,
        host: cpus()[0].model,
        platform: process.platform,
        arch: process.arch,
        rounds,
        results,
      },
      null,
      2,
    ) + "\n",
  );
}
