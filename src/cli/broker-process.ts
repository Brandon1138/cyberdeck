import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appStateDirectory, brokerSocketPath } from "../broker/app-paths.js";
import { RpcClient } from "../client/rpc-client.js";

export async function withClient<T>(operation: (client: RpcClient) => Promise<T>): Promise<T> {
  const client = await RpcClient.connect(brokerSocketPath);
  try {
    return await operation(client);
  } finally {
    client.close();
  }
}

export function projectRootFromModulePath(modulePath: string): string {
  // This module compiles to <root>/dist/src/cli/runtime.js and runs from <root>/src/cli/runtime.ts
  // under tsx — one directory deeper than the src/cli.ts entry this logic originally lived in.
  const sourceDirectory = dirname(modulePath);
  const grandparent = dirname(dirname(sourceDirectory));
  const isCompiledLayout = extname(modulePath) === ".js" && basename(grandparent) === "dist";
  return isCompiledLayout ? dirname(grandparent) : grandparent;
}

export function projectRoot(): string {
  return projectRootFromModulePath(fileURLToPath(import.meta.url));
}

export function cliEntrypointFromModulePath(modulePath: string): string {
  return resolve(dirname(dirname(modulePath)), `cli${extname(modulePath)}`);
}

export function cliEntrypoint(): string {
  return resolve(process.argv[1] ?? cliEntrypointFromModulePath(fileURLToPath(import.meta.url)));
}

/**
 * How long a starting broker is given before the wait is called a failure.
 *
 * Startup replays durable state — the coordination log and every activity event — so it is a
 * function of how much history this machine has, not a constant. Five seconds was under that on a
 * real journal, and the message it produced (`connect ENOENT`) described the socket that did not
 * exist yet rather than the broker that was still working, which reads as a broken broker. The wait
 * ends early when the child dies, so a generous limit costs nothing on the failure path.
 */
const BROKER_READY_TIMEOUT_MS = 90_000;

/**
 * Wait for the broker to answer. `abandoned` reports that the process being waited on is gone, so a
 * broker that died is a prompt failure rather than a long silence ending in a timeout.
 */
export async function waitForBroker(
  timeoutMs = BROKER_READY_TIMEOUT_MS,
  abandoned?: () => boolean,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await withClient((client) => client.request("broker.status", {}));
      return;
    } catch (error) {
      lastError = error;
      if (abandoned?.() === true) throw new Error("Broker exited during startup");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`Broker did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

export async function waitForBrokerStop(timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await withClient((client) => client.request("broker.status", {}));
      await new Promise((resolve) => setTimeout(resolve, 50));
    } catch (error) {
      if (isBrokerUnavailable(error)) return;
      throw error;
    }
  }
  throw new Error("Broker did not stop before the restart timeout");
}

export async function startDetachedBroker(announce = true): Promise<void> {
  const brokerEntry = resolve(projectRoot(), "dist", "src", "broker", "main.js");
  if (!existsSync(brokerEntry)) {
    throw new Error("Built broker is missing; run `pnpm build` first");
  }
  mkdirSync(appStateDirectory, { recursive: true });
  const logPath = resolve(appStateDirectory, "broker.log");
  // Where this child's output begins, so a failure quotes what it wrote and not the whole history.
  const logStart = existsSync(logPath) ? statSync(logPath).size : 0;
  const logDescriptor = openSync(logPath, "a");
  let exited = false;
  try {
    const child = spawn(process.execPath, [brokerEntry], {
      cwd: projectRoot(),
      detached: true,
      stdio: ["ignore", logDescriptor, logDescriptor],
    });
    child.once("exit", () => { exited = true; });
    child.unref();
  } finally {
    closeSync(logDescriptor);
  }
  try {
    await waitForBroker(BROKER_READY_TIMEOUT_MS, () => exited);
  } catch (error) {
    // The child's own words, not just the socket that is missing because of them. Without this the
    // caller sees `connect ENOENT` and reads it as a connection problem, while the reason the
    // broker never listened is sitting unread in the log.
    const reported = brokerStartupOutput(logPath, logStart);
    throw reported === undefined
      ? error
      : new Error(`${error instanceof Error ? error.message : String(error)}\n${reported}`);
  }
  if (announce) process.stdout.write(`Cyberdeck broker is running at ${brokerSocketPath}\n`);
}

/** What one starting broker wrote to the shared log, bounded so a loop cannot flood the terminal. */
function brokerStartupOutput(logPath: string, from: number): string | undefined {
  let written: string;
  try {
    written = readFileSync(logPath, "utf8").slice(from);
  } catch {
    return undefined;
  }
  const lines = written.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  if (lines.length === 0) return undefined;
  const shown = lines.slice(-10);
  return [`Broker log (${logPath}):`, ...shown.map((line) => `  ${line}`)].join("\n");
}

export function isBrokerUnavailable(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  return error.code === "ENOENT" || error.code === "ECONNREFUSED";
}

export async function restartDetachedBroker(): Promise<void> {
  try {
    await withClient((client) => client.request("broker.shutdown", {}));
    await waitForBrokerStop();
  } catch (error) {
    if (!isBrokerUnavailable(error)) throw error;
  }
  await startDetachedBroker(false);
  process.stdout.write(`Cyberdeck broker restarted at ${brokerSocketPath}\n`);
}
