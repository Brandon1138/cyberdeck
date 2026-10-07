import { createHash } from "node:crypto";
import { mkdir, writeFile, appendFile, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { RpcClient } from "../src/client/rpc-client.js";
import { parseProcessTable, ProcessOwnership, type ProcessRoot } from "../src/runtime/resources/macos-process-sampler.js";
import { runResourceCommand } from "../src/runtime/resources/bounded-command.js";
import type { SessionRecord } from "../src/domain/session.js";

// Explicit sockets only: this command never starts a broker or discovers credentials.
const [output, secondsText = "60", ...sockets] = process.argv.slice(2);
const seconds = Number(secondsText);
if (!output || !Number.isInteger(seconds) || seconds < 5 || seconds > 86400 || !sockets.length)
  throw new Error("Usage: profile-fleet-resources.ts <new-evidence-directory> <seconds:5..86400> <socket> [...]");
await mkdir(output, { mode: 0o700 });
const connections = await Promise.all(sockets.map(socket => RpcClient.connect(socket)));
const ownership = new ProcessOwnership(), known = new Map<string, ProcessRoot>();
const series = resolve(output, "samples.jsonl"), start = new Date().toISOString();
const loop = monitorEventLoopDelay({ resolution: 20 }); loop.enable();
const sourceAtStart = { sha: (await runResourceCommand("git", ["rev-parse", "HEAD"])).trim(),
  dirty: !!(await runResourceCommand("git", ["status", "--porcelain"])).trim() };
const cpu = process.cpuUsage(), started = performance.now();
let samples = 0, failures = 0;
try {
  while (performance.now() - started < seconds * 1000) {
    const observedAt = new Date().toISOString(), iteration = performance.now();
    try {
      const rows = parseProcessTable(await runResourceCommand("/bin/ps", ["-axo", "pid=,ppid=,rss=,%cpu=,lstart="]));
      const rpc: { latencyMs: number; catalogRows: number; activeRows: number }[] = [];
      for (let i = 0; i < connections.length; i++) {
        const client = connections[i]!, begin = performance.now();
        const broker = await client.request<{ pid: number }>("broker.status", {});
        const sessions = await client.request<SessionRecord[]>("session.list", {});
        rpc.push({ latencyMs: performance.now() - begin, catalogRows: sessions.length,
          activeRows: sessions.filter(s => s.executionState === "active").length });
        const roots = [{ pid: broker.pid, id: "broker", kind: "control" as const },
          ...sessions.filter(s => s.executionState === "active").map(s => ({ pid: s.pid, id: s.id, kind: s.kind ?? "worker" as const }))];
        for (const root of roots) {
          const row = rows.find(r => r.identity.pid === root.pid);
          if (!row) continue;
          const workloadId = `${i}:${root.id}`;
          if (!known.has(workloadId)) known.set(workloadId, { identity: row.identity,
            owner: { installationId: "baseline", workloadId, kind: root.kind } });
        }
      }
      const self = rows.find(r => r.identity.pid === process.pid);
      if (self) known.set("sampler", { identity: self.identity, owner: { installationId: "baseline", workloadId: "sampler", kind: "control" } });
      const host = ownership.sample(rows, [...known.values()], observedAt);
      await appendFile(series, JSON.stringify({ observedAt, host, rpc, collectionMs: performance.now() - iteration,
        installationPhysicalBytes: null, uncertainty: ["fleet-not-registered", "vm-attribution-unavailable", "rss-not-physical-footprint"] }) + "\n", { mode: 0o600 });
      samples++;
    } catch { failures++; }
    await new Promise(r => setTimeout(r, Math.max(0, 5000 - (performance.now() - iteration))));
  }
} finally {
  loop.disable(); connections.forEach(c => c.close());
  const consumed = process.cpuUsage(cpu);
  const manifest = { schemaVersion: 1, start, end: new Date().toISOString(), samples, failures,
    node: process.version, mode: "read-only-baseline", ownCpuMicros: consumed.user + consumed.system,
    ownEventLoopP99Ms: loop.percentile(99) / 1e6, sourceAtStart, sourceShaAtEnd: (await runResourceCommand("git", ["rev-parse", "HEAD"])).trim(),
    dirty: !!(await runResourceCommand("git", ["status", "--porcelain"])).trim(),
    seriesSha256: await stat(series).then(async () => createHash("sha256").update(await readFile(series)).digest("hex")).catch(() => null) };
  await writeFile(resolve(output, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(manifest));
}
