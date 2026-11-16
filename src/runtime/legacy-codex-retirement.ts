import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { SessionRecord } from "../domain/session.js";
import { isLegacyHostPty, legacyRetirementHash, type LegacyRetirementProof } from "../domain/strigoi-legacy-retirement.js";
import { codexDaemonHasNoLoadedThreads } from "../providers/codex/remote-loaded-threads.js";
import { hostProcessGroupAbsent } from "./host-process-retirement.js";

const exec = promisify(execFile);
const daemonSchema = z.object({ pid: z.number().int().min(2), processStartTime: z.string().min(1),
  processIdentity: z.object({ bootId: z.string().min(1), uniqueId: z.number().int(), startSeconds: z.number(), startMicroseconds: z.number() }),
});
const fail = (): never => { throw new Error("STRIGOI_LEGACY_RETIREMENT_EVIDENCE_UNAVAILABLE"); };
/** Darwin-only audited PTY migration. No PID signals other than existence probes are sent. */
export async function probeLegacyCodexRetirement(record: SessionRecord, homeDirectory: string): Promise<LegacyRetirementProof> {
  if (process.platform !== "darwin" || !isLegacyHostPty(record) || !hostProcessGroupAbsent(record.pid, record.pid)) return fail();
  const pidFile = join(homeDirectory, "app-server-daemon", "daemon.pid");
  const socketLink = join(homeDirectory, "app-server-control", "app-server-control.sock");
  const [raw, socketPath, canonicalHome] = await Promise.all([readFile(pidFile, "utf8"), realpath(socketLink), realpath(homeDirectory)]);
  const daemon = daemonSchema.parse(JSON.parse(raw));
  const [processes, sockets] = await Promise.all([
    exec("/bin/ps", ["-axo", "pid=,lstart=,command="], { timeout: 1000, maxBuffer: 4 * 1024 * 1024 }),
    exec("/usr/sbin/lsof", ["-a", "-p", String(daemon.pid), "-U", "-Fn"], { timeout: 1000, maxBuffer: 1024 * 1024 }),
  ]);
  const prefix = `${canonicalHome}/packages/app-server-daemon/`;
  const servers = processes.stdout.split("\n").filter(line => line.includes(prefix) && line.includes(" app-server ") && line.includes("--managed-daemon"));
  const normalize = (text: string) => text.trim().replace(/\s+/g, " ");
  if (servers.length !== 1 || !normalize(servers[0]!).startsWith(`${daemon.pid} ${normalize(daemon.processStartTime)} `)
    || !sockets.stdout.split("\n").includes(`n${socketPath}`)) return fail();
  if (!await codexDaemonHasNoLoadedThreads(socketPath)) return fail();
  const [after, afterSocket] = await Promise.all([readFile(pidFile, "utf8"), realpath(socketLink)]);
  if (after !== raw || afterSocket !== socketPath || !hostProcessGroupAbsent(record.pid, record.pid)) return fail();
  return { kind: "host-group-absent-and-managed-daemon-empty", observedAt: new Date().toISOString(),
    homeDirectory: canonicalHome, socketPath, daemonPid: daemon.pid, daemonIdentitySha256: legacyRetirementHash(JSON.parse(raw)) };
}
