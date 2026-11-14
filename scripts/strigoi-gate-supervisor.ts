import { execFile, fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { StrigoiState } from "../src/domain/strigoi.js";
import { validateStrigoiGate, type StrigoiGateOptions } from "./strigoi-gate-options.js";

export type CrashObservation = { type: "ready" | "recovered"; token: string; state: StrigoiState; launches: number; submissions: number };
export type CrashChildRequest = { options: StrigoiGateOptions; token: string; restart: boolean; synthetic: boolean };

/** Ownership is the live ChildProcess handle, never a PID recovered from disk. A lost
 * supervisor cannot resume this run: the exclusive directory remains as evidence. */
export async function runCrashGate(o: StrigoiGateOptions, synthetic = false): Promise<Record<string, unknown>> {
  await validateStrigoiGate(o);
  if (o.mode !== "crash" || !["passive", "reserved-launch"].includes(o.caseId ?? "")) throw new Error("Unknown crash case");
  const plan = { caseId: o.caseId, primaryContact: false, nvim: false, controller: "separate owned child",
    boundary: o.caseId, restart: "new process, same durable state, no inherited process ownership",
    inferenceRequests: { observed: null, qualification: "UNQUALIFIED" }, live: "NOT RUN" };
  if (o.validateOnly) { process.stdout.write(JSON.stringify({ status: "VALIDATED", plan }) + "\n"); return plan; }
  if (!synthetic && !o.allowInference) throw new Error("Live inference is not authorized");
  await mkdir(o.stateDirectory, { mode: 0o700 });
  const token = randomUUID();
  const lock = await open(join(o.stateDirectory, "strigoi-gate.lock"), "wx", 0o600);
  await lock.writeFile(JSON.stringify({ token, pid: process.pid, plan })); await lock.sync();
  const journal = await open(join(o.stateDirectory, "supervisor.jsonl"), "ax", 0o600);
  const record = async (entry: unknown) => { await journal.writeFile(JSON.stringify({ at: new Date().toISOString(), entry }) + "\n"); await journal.sync(); };
  let child: ChildProcess | undefined;
  let exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
  const result: Record<string, unknown> = { plan, synthetic, status: "FAILED_OR_UNAVAILABLE", selection: o.selection, node: process.version,
    startedAt: new Date().toISOString(), providerUsage: null, costUsd: null,
    inferenceRequests: null, humanReview: "NOT RUN", nativeCleanup: "UNQUALIFIED: orphan native runtimes are not owned by the restarted controller; no recorded PID is signalled" };
  const launch = async (restart: boolean): Promise<CrashObservation> => {
    // Fork IPC is private to this directly created child, not a public broker endpoint.
    const current = fork(fileURLToPath(new URL("./strigoi-gate-crash-child.ts", import.meta.url)), [], {
      execPath: process.execPath, execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    child = current;
    exited = new Promise((resolve, reject) => { current.once("error", reject); current.once("exit", (code, signal) => resolve({ code, signal })); });
    // Register all listeners before sending a request; retain bounded diagnostics only.
    let stderr = ""; current.stderr?.on("data", data => { stderr = (stderr + String(data)).slice(-8000); });
    const observation = new Promise<CrashObservation>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Controller deadline exceeded: ${stderr}`)), 120_000);
      const finish = () => clearTimeout(timer);
      current.on("message", message => {
        const m = message as CrashObservation & { error?: string };
        if (m.token !== token) return;
        if (m.error) { finish(); reject(new Error(m.error)); }
        else if (m.type === (restart ? "recovered" : "ready")) { finish(); resolve(m); }
      });
      void exited!.then(e => { finish(); reject(new Error(`Controller exited before observation: ${JSON.stringify(e)} ${stderr}`)); }, e => { finish(); reject(e); });
    });
    // A spawn/early-exit failure can precede the fsync below; retain it until awaited.
    void observation.catch(() => {});
    await record({ resource: "controller-child", restart, pid: current.pid, token });
    current.send({ options: o, token, restart, synthetic } satisfies CrashChildRequest);
    return observation;
  };
  try {
    const version = async (...args: string[]) => (await promisify(execFile)("rtk", ["proxy", ...args], { timeout: 30_000 })).stdout.trim();
    result.versions = { source: await version("git", "rev-parse", "HEAD"), dirty: await version("git", "status", "--porcelain"),
      provider: synthetic ? "NOT RUN: synthetic transport" : await version("codex", "--version") };
    const before = await launch(false); result.before = before; await record(before);
    if (before.state.hold || before.submissions !== 0 || before.launches !== (o.caseId === "passive" ? 1 : 0)
      || (o.caseId === "passive" && !before.state.activeBinding)
      || (o.caseId === "reserved-launch" && (!before.state.transition?.successor || before.state.activeBinding))) throw new Error("Invalid pre-crash boundary");
    if (child!.exitCode !== null || child!.signalCode !== null || !child!.kill("SIGKILL")) throw new Error("Owned controller was not available for crash");
    const death = await exited!; result.death = death; await record({ resource: "controller-exit", ...death });
    if (death.signal !== "SIGKILL") throw new Error("No confirmed controller SIGKILL");
    const after = await launch(true); result.after = after; await record(after);
    const expectedSources = o.caseId === "passive" ? [before.state.activeBinding!.sessionId] : [];
    const expectedCode = o.caseId === "passive" ? "retirement-unconfirmed" : "launch-ownership-unresolved";
    if (after.state.hold?.code !== expectedCode || JSON.stringify(after.state.hold.sourceIds) !== JSON.stringify(expectedSources)
      || after.launches !== 0 || after.submissions !== 0 || after.state.incarnation !== before.state.incarnation
      || after.state.activeGeneration !== before.state.activeGeneration
      || JSON.stringify(after.state.activeBinding) !== JSON.stringify(before.state.activeBinding)
      || (o.caseId === "reserved-launch" && JSON.stringify(after.state.transition?.successor) !== JSON.stringify(before.state.transition?.successor))) {
      throw new Error("Restart did not preserve the exact permitted ambiguity hold/no duplicate incarnation");
    }
    child!.send({ type: "close", token });
    const closed = await Promise.race([exited!, new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error("Controller cleanup deadline exceeded")), 15_000); timer.unref();
    })]);
    result.restartedControllerExit = closed;
    if (closed.code !== 0) throw new Error("Restarted controller cleanup failed");
    result.status = "EXPECTED_HOLD_NO_DUPLICATE";
    result.physicalControllerCrash = "OBSERVED: direct child SIGKILL and separate process restart";
    result.nativeCleanup = synthetic ? "Synthetic child exits on its controller pipe EOF; no provider started" : result.nativeCleanup;
  } catch (error) { result.error = String(error); throw error; }
  finally {
    // Only the currently held handle can be stopped. Never read PID journals for cleanup.
    if (child && child.exitCode === null && child.signalCode === null) {
      try { child.kill("SIGKILL"); await exited; } catch (error) { result.controllerCleanupError = String(error); }
    }
    result.endedAt = new Date().toISOString();
    await record({ result });
    await writeFile(join(o.stateDirectory, "crash-result.json"), JSON.stringify(result, null, 2), { mode: 0o600 });
    await journal.close(); await lock.close();
  }
  process.stdout.write(JSON.stringify({ status: result.status, evidence: join(o.stateDirectory, "crash-result.json"), live: synthetic ? "NOT RUN" : "UNQUALIFIED", inferenceRequests: "UNQUALIFIED" }) + "\n");
  return result;
}
