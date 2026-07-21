import { spawn as nodeSpawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AppServerJobDispatchAdapter,
  type AppServerSpawn,
} from "../../src/app-server/dispatch-adapter.js";
import { WorktreeLeaseManager } from "../../src/control-plane/worktree-lease-manager.js";
import type { DispatchRequest } from "../../src/domain/dispatch.js";
import type { JobReport } from "../../src/domain/job.js";
import { LeaseStore } from "../../src/persistence/lease-store.js";

const FIXTURE = fileURLToPath(new URL("../fixtures/fake-app-server.mjs", import.meta.url));
const directories: string[] = [];
const children = new Set<ReturnType<typeof nodeSpawn>>();

afterEach(async () => {
  for (const child of children) child.kill("SIGKILL");
  children.clear();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function nextReport(adapter: AppServerJobDispatchAdapter): Promise<JobReport> {
  return new Promise((resolve) => {
    const unsubscribe = adapter.onReport((report) => {
      unsubscribe();
      resolve(report);
    });
  });
}

describe("fake App Server job with a durable write lease", () => {
  it("spawns only the injected fixture and acquires/releases one write lease exactly once", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyberdeck-app-server-lease-"));
    directories.push(root);
    const store = new LeaseStore(root);
    const leases = new WorktreeLeaseManager({ store });
    const release = vi.spyOn(leases, "release");
    let observedExecutable = "";
    const spawn: AppServerSpawn = (command) => {
      observedExecutable = command.executable;
      const child = nodeSpawn(process.execPath, [FIXTURE], {
        cwd: root,
        env: { ...process.env, PATH: "" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      children.add(child);
      child.once("exit", () => children.delete(child));
      return {
        onStdout: (listener) => child.stdout.on("data", listener),
        onStderr: (listener) => child.stderr.on("data", listener),
        onExit: (listener) => child.on("exit", listener),
        onError: (listener) => child.on("error", listener),
        write: (data) => child.stdin.write(data),
        endStdin: () => child.stdin.end(),
        kill: (signal) => child.kill(signal),
      };
    };
    const adapter = new AppServerJobDispatchAdapter({ spawn, leaseManager: leases });
    const jobId = crypto.randomUUID();
    const input = {
      schemaVersion: 1,
      jobId,
      correlationId: crypto.randomUUID(),
      request: {
        schemaVersion: 1,
        provider: "codex",
        cwd: root,
        sandbox: "workspace-write",
        instruction: "fixture-only instruction",
        model: "gpt-fixture",
      },
    } as DispatchRequest;
    const report = nextReport(adapter);
    await adapter.dispatch(input);
    expect((await report).result).toMatchObject({ outcome: "completed" });
    expect(observedExecutable).toBe("codex");
    expect(release).toHaveBeenCalledTimes(1);
    expect((await store.load())[0]?.lease.state).toBe("released");
    expect(leases.findByJob(jobId)).toEqual([]);
    await vi.waitFor(() => expect(children.size).toBe(0));
  });
});
