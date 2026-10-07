import { spawn } from "node:child_process";
import { open, readdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import type { ResourceRuntimeIdentity } from "../../domain/resource-runtime.js";
import type { NativeMacosProcessSampler, NativeProcessReading } from "../resources/native-macos-process-sampler.js";
import type { NativeCommand, NativeCommandResult, NativeProcessSupervisor } from "./native-tool-types.js";

const key = (row: { pid: number; startTime: string }) => `${row.pid}:${row.startTime}`;
const birth = (value: string) => BigInt(value.replace("libproc:", "").replace(".", ""));
async function diskBytes(directory: string): Promise<number> {
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const stat = await lstat(path);
    bytes += stat.isDirectory() ? await diskBytes(path) : stat.size;
  }
  return bytes;
}

/** Gate prevents the tool starting until its supervisor's exact birth identity is durable.
 * The parent owns timeout/cancellation. IPC disconnect makes the gate stop its immediate child.
 * A broker crash still requires reconciliation of descendants before capacity can be released. */
const GATE = `const {spawn}=require('node:child_process');let child;process.on('message',m=>{if(child)return;child=spawn(m.executable,m.args,{cwd:m.cwd,env:m.env,stdio:['ignore',1,2]});child.on('error',()=>process.exit(127));child.on('exit',(code,signal)=>{if(process.connected)process.send({code,signal},()=>process.exit(code??1));else process.exit(code??1)});});process.on('disconnect',()=>{child?.kill('SIGTERM');setTimeout(()=>process.exit(125),1000).unref()});`;

export class MacosNativeProcessSupervisor implements NativeProcessSupervisor {
  constructor(private readonly sampler: Pick<NativeMacosProcessSampler, "readTable">,
    /** A stronger lifetime/service tracker may prove cleanup. Polling alone NEVER does. */
    private readonly proveTermination?: (identities: ResourceRuntimeIdentity[]) => Promise<boolean>) {}

  async run(command: NativeCommand, context: Parameters<NativeProcessSupervisor["run"]>[1]): Promise<NativeCommandResult> {
    const log = await open(command.logPath, "wx", 0o600);
    const child = spawn(process.execPath, ["-e", GATE], { cwd: command.cwd, env: command.env,
      stdio: ["ignore", log.fd, log.fd, "ipc"] });
    const known = new Map<string, ResourceRuntimeIdentity>();
    let persistedCount = 0;
    let done = false, exitCode: number | null = null, exitSignal: string | null = null;
    let timedOut = false, cancelled = false, reason: string | null = null;
    let failed = false, peakBytes = 0, peakPids = 0;
    const deadline = Date.now() + command.timeoutMs;
    const uncertainty = new Set(["native-polling-not-kernel-limit", "unobserved-short-lived-descendants", "launchd-services-unattributed"]);
    const exit = new Promise<void>(resolve => {
      child.on("message", (message: unknown) => {
        if (message && typeof message === "object" && "code" in message && "signal" in message) {
          exitCode = typeof message.code === "number" ? message.code : null;
          exitSignal = typeof message.signal === "string" ? message.signal : null;
        }
      });
      child.once("error", () => { failed = true; done = true; reason = "native-launch-failed"; resolve(); });
      child.once("exit", (code, signal) => { done = true; exitCode ??= code; exitSignal ??= signal; resolve(); });
    });
    const collect = async (): Promise<NativeProcessReading[]> => {
      const table = await this.sampler.readTable();
      // Foreign processes commonly deny libproc inspection. Their presence does not make
      // known owned metrics unavailable, and polling still cannot prove lifetime cleanup.
      if (table.inaccessibleProcesses) uncertainty.add("foreign-process-table-incomplete");
      if (!known.size) {
        const root = table.rows.find(row => row.identity.pid === child.pid);
        if (!root) throw new Error("native-root-identity-unavailable");
        known.set(key(root.identity), { kind: "native", ...root.identity });
      }
      let changed = true;
      while (changed) {
        changed = false;
        for (const row of table.rows) {
          if (known.has(key(row.identity))) continue;
          const parent = table.rows.find(candidate => candidate.identity.pid === row.parentPid);
          if (parent && known.has(key(parent.identity)) && birth(parent.identity.startTime) <= birth(row.identity.startTime)) {
            known.set(key(row.identity), { kind: "native", ...row.identity }); changed = true;
          }
        }
      }
      if (known.size !== persistedCount) {
        await context.identities([...known.values()]); persistedCount = known.size;
      }
      return table.rows.filter(row => known.has(key(row.identity)));
    };
    const terminate = async (): Promise<void> => {
      for (const signal of ["SIGTERM", "SIGKILL"] as const) {
        const rows = await collect();
        for (const row of rows.reverse()) {
          // Re-read each identity immediately before signalling. Never use process names/groups.
          const fresh = await this.sampler.readTable();
          if (fresh.rows.some(candidate => key(candidate.identity) === key(row.identity))) {
            try { process.kill(row.identity.pid, signal); } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
            }
          }
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    };
    try {
      await collect();
      if (!child.connected || failed) throw new Error("native-launch-failed");
      if (context.signal?.aborted) { cancelled = true; await terminate(); }
      else child.send({ executable: command.executable, args: command.args, cwd: command.cwd, env: command.env });
      while (!done) {
        const rows = await collect();
        const memory = rows.some(row => row.physicalFootprintBytes === null || row.physicalFootprintBytes === undefined)
          ? null : rows.reduce((sum, row) => sum + row.physicalFootprintBytes!, 0);
        peakBytes = Math.max(peakBytes, memory ?? 0); peakPids = Math.max(peakPids, rows.length);
        context.sample?.({ observedAt: new Date().toISOString(), source: "macos-process", memoryKind: "physical-footprint",
          memoryBytes: memory, cpuCoreFraction: null, pids: rows.length, uncertainty: [...uncertainty] });
        timedOut ||= Date.now() >= deadline; cancelled ||= context.signal?.aborted === true;
        if (memory === null) reason = "native-metrics-unavailable";
        else if (memory > command.memoryBytes || rows.length > command.pidLimit) reason = "native-resource-envelope-exceeded";
        else if (await diskBytes(command.artifactsDirectory) > command.maxArtifactBytes) reason = "native-disk-envelope-exceeded";
        if (timedOut || cancelled || reason) { await terminate(); break; }
        await Promise.race([exit, new Promise(resolve => setTimeout(resolve, 100))]);
      }
      // Stop any observed surviving children, retaining workspace and result evidence.
      if ((await collect()).length) await terminate();
    } catch {
      failed = true; reason ??= "native-supervision-incomplete";
      try { await terminate(); } catch { uncertainty.add("native-termination-failed"); }
      // If no PID identity was captured, disconnect the gate: it has not received a launch.
      if (child.connected) child.disconnect();
    } finally { await log.close(); }
    const identities = [...known.values()];
    const complete = !failed && identities.length > 0 && await this.proveTermination?.(identities) === true;
    uncertainty.add(`peak-owned-bytes:${peakBytes}`); uncertainty.add(`peak-owned-pids:${peakPids}`);
    return { exitCode, signal: exitSignal, timedOut, cancelled, reason, identities,
      cleanup: complete ? "terminated" : "unproven", uncertainty: [...uncertainty] };
  }
}
