import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ResourceOwnerLockPort } from "../../domain/resource-runtime.js";

/** Only the exact child handle is signalled. No PID/name lookup and no lock-file unlink. */
async function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
    child.once("close", () => { clearTimeout(timer); resolve(); });
    child.stdin.end();
  });
}

export async function acquireResourceOwnerLock(executable: string, path: string,
  onLost: () => void = () => {}): Promise<ResourceOwnerLockPort> {
  if (!executable.startsWith("/") || !path.startsWith("/")) throw new Error("RESOURCE_OWNER_ABSOLUTE_PATH_REQUIRED");
  const child = spawn(executable, [path], { stdio: "pipe", env: {} });
  let held = false, released = false;
  // The helper never emits private file contents; stderr is drained to avoid pipe blockage.
  child.stderr.resume(); child.stdin.on("error", () => {});
  child.on("exit", () => { const lost = held && !released; held = false; if (lost) onLost(); });
  try {
    await new Promise<void>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => finish(new Error("RESOURCE_OWNER_TIMEOUT")), 5000);
      const finish = (error?: Error) => {
        clearTimeout(timer); child.stdout.off("data", data); child.off("error", failed); child.off("exit", exited);
        if (error) reject(error); else resolve();
      };
      const data = (chunk: Buffer) => {
        output += chunk.toString("utf8");
        if (output === "cyberdeck-resource-owner-v1\n") { held = true; finish(); }
        else if (output.length > 128 || output.includes("\n")) finish(new Error("RESOURCE_OWNER_INVALID_RESPONSE"));
      };
      const failed = () => finish(new Error("RESOURCE_OWNER_UNAVAILABLE"));
      const exited = () => finish(new Error("RESOURCE_OWNER_UNAVAILABLE"));
      child.stdout.on("data", data); child.once("error", failed); child.once("exit", exited);
    });
  } catch (error) { await stop(child); throw error; }
  return {
    assertHeld: () => {
      if (!held || released || child.exitCode !== null || child.signalCode !== null) throw new Error("RESOURCE_OWNER_LOST");
    },
    release: async () => { if (released) return; released = true; held = false; await stop(child); },
  };
}
