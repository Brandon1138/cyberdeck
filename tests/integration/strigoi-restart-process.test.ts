import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import type { StrigoiState } from "../../src/domain/strigoi.js";
import type { SessionRecord } from "../../src/domain/session.js";
interface Observation { id: number; state: StrigoiState; records: SessionRecord[]; owned: string[]; launches: number; submissions: number; error?: string }
async function controller(root: string) {
  const child = fork(fileURLToPath(new URL("../fixtures/strigoi/restart-controller.ts", import.meta.url)), [root],
    { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let sequence = 0, stderr = "";
  const pending = new Map<number, { resolve(o: Observation): void; reject(e: Error): void }>();
  child.stderr?.on("data", b => { stderr = (stderr + b).slice(-5000); });
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  child.on("message", (m: Observation) => { const p = pending.get(m.id); if (!p) return; pending.delete(m.id); m.error ? p.reject(new Error(m.error)) : p.resolve(m); });
  child.once("exit", () => { for (const p of pending.values()) p.reject(new Error(`controller exited: ${stderr}`)); });
  const wait = (id: number) => new Promise<Observation>((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`controller timeout: ${stderr}`)); }, 15000);
    pending.set(id, { resolve: o => { clearTimeout(timer); resolve(o); }, reject: e => { clearTimeout(timer); reject(e); } });
  });
  const ready = await wait(0);
  return { child, exited, ready, async call(op: string, milliseconds = 0) { const id = ++sequence, result = wait(id); child.send({ id, op, milliseconds }); return result; } };
}
it.each(["graceful", "forced", "provider-death", "repeated-before-adoption"])("real isolated controller/PTY restart: %s", async mode => {
  const root = await mkdtemp("/tmp/strigoi-rp-");
  const owned: ChildProcess[] = [];
  let current: Awaited<ReturnType<typeof controller>> | undefined;
  try {
    current = await controller(root); owned.push(current.child);
    const original = current.ready.state.activeBinding!.sessionId;
    expect(current.ready.owned).toEqual([original]);
    expect(current.ready.records[0]?.recoveryProcessGroup).toBe(current.ready.records[0]?.pid);
    if (mode === "graceful") { await current.call("close"); await current.exited; }
    else if (mode === "provider-death") { await current.call("stop-provider"); }
    else { current.child.kill("SIGKILL"); await current.exited; }
    if (mode !== "provider-death") { current = await controller(root); owned.push(current.child); }
    let result = current.ready;
    for (let n = 0; n < 20; n++) {
      result = await current.call("tick", 5000);
      expect(result.owned.length).toBeLessThanOrEqual(1);
      expect(result.submissions).toBe(0);
      if (result.state.incarnation >= 2 && result.state.transition?.adoptionDeferred) break;
      await new Promise(r => setTimeout(r, 30));
    }
    expect(result.state.incarnation).toBe(2);
    expect(result.state.transition).toMatchObject({ phase: "adopting", adoptionDeferred: true });
    expect(result.state.retainedSessionIds).toContain(original);
    expect(result.state.continuityReceipts?.some(r => r.adoption)).not.toBe(true);
    if (mode === "forced") {
      const old = result.records.find(r => r.id === original)!;
      expect(old.exitCode).toBe(-1);
      expect(old.retirementObservation?.kind).toBe("host-process-group-absent");
    }
    if (mode === "repeated-before-adoption") {
      const packet = result.state.latestPacket;
      for (let pass = 0; pass < 2; pass++) {
        current.child.kill("SIGKILL"); await current.exited;
        current = await controller(root); owned.push(current.child);
        for (let n = 0; n < 20; n++) {
          result = await current.call("tick", 5000);
          expect(result.owned.length).toBeLessThanOrEqual(1); expect(result.submissions).toBe(0);
          if (result.state.incarnation === pass + 3) break;
          await new Promise(r => setTimeout(r, 30));
        }
        expect(result.state.incarnation).toBe(pass + 3);
        expect(result.state.successionHistory).toContainEqual(expect.objectContaining({ packet, supersededBy: expect.any(String) }));
      }
    }
    await current.call("close"); await current.exited;
  } finally {
    // Only direct handles created by this test are signalled, never persisted PIDs.
    for (const child of owned) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
}, 45000);

import { PtyProcess } from "../../src/runtime/pty-process.js";
import { SessionStore } from "../../src/persistence/session-store.js";
it("a surviving exact host group holds recovery without signalling it or launching another actor", async () => {
  const root = await mkdtemp("/tmp/strigoi-live-group-");
  const live = new PtyProcess({ executable: process.execPath, args: ["-e", "process.stdin.resume();setInterval(()=>{},1000)"], cwd: root, env: {} }, 1024);
  const gone = new Promise<void>(resolve => live.onExit(() => resolve()));
  let current: Awaited<ReturnType<typeof controller>> | undefined;
  try {
    current = await controller(root);
    await current.call("close"); await current.exited;
    const store = new SessionStore(root), [record] = await store.load();
    await store.put({ ...record!, pid: live.pid, recoveryProcessGroup: live.pid, exitCode: null, executionState: "active", retirementObservation: undefined });
    current = await controller(root);
    const result = await current.call("tick", 30000);
    expect(result.launches).toBe(0); expect(result.submissions).toBe(0);
    expect(result.state.hold?.code).toBe("retirement-unconfirmed");
    expect(result.records[0]?.exitCode).toBe(-1);
    expect(result.records[0]?.retirementObservation).toBeUndefined();
    // The old runtime remains alive: only its directly held test handle retires it.
    expect(() => process.kill(live.pid, 0)).not.toThrow();
    await current.call("close"); await current.exited;
  } finally {
    if (current?.child.exitCode === null && current.child.signalCode === null) current.child.kill("SIGKILL");
    live.kill(); await gone; await rm(root, { recursive: true, force: true });
  }
}, 30000);
