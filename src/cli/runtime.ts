import { Command, Option } from "commander";
import { spawnSync as nodeSpawnSync, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appStateDirectory, brokerSocketPath } from "../broker/app-paths.js";
import { attachSession } from "../client/attach.js";
import { runFleet, type OrchestratorCockpitTarget } from "../client/fleet.js";
import type { FleetRuntimeDeps } from "../client/fleet/deps.js";
import { RpcClient, RpcError } from "../client/rpc-client.js";
import type { CreateOrchestratorRequest, EnsureOrchestratorRequest } from "../domain/orchestrator.js";
import { CANONICAL_PROVIDER_IDS, type ProviderId } from "../domain/provider-registration.js";
import type { ApprovalMode, ReasoningEffort, ResolvedLaunchRecord, SessionRecord, } from "../domain/session.js";
import { ORCHESTRATOR_CATALOG } from "../orchestration/orchestrator-catalog.js";
import type { OrchestratorManagerResult } from "../orchestration/orchestrator-manager.js";
import { liveWorktreeCwds } from "../orchestration/worktree-inventory.js";
import type {
  CliToolkit,
  CockpitOptions,
  CockpitPreflight,
  SpawnSyncLike,
} from "./toolkit.js";

export interface SessionLaunchRecordResult {
  sessionId: string;
  provider: ProviderId;
  launchRecord: ResolvedLaunchRecord | null;
}

export interface StartOptions {
  provider: ProviderId;
  cwd: string;
  model?: string;
  effort?: ReasoningEffort;
  role?: string;
  name?: string;
  sandbox: "read-only" | "workspace-write";
  approvalMode?: ApprovalMode;
  attach?: boolean;
}

export interface DelegateOptions extends StartOptions {
  parent: string;
}

export interface EventSubmitOptions {
  worker: string;
  eventId?: string;
  kind: "EXCEPTION" | "PROGRESS" | "CHECKPOINT" | "RISK" | "DECISION_REQUEST";
  severity: "info" | "warning" | "error" | "critical";
  intervention?: boolean;
  summary: string;
  facts?: string;
  evidence: string[];
  changedAssumption: string[];
  recommendedAction?: string;
  continuation: "continuing" | "blocked" | "paused" | "awaiting-response";
  checkpointCorrelationId?: string;
}

export function providerOption(): Option {
  return new Option("--provider <provider>", "explicit provider")
    .choices([...CANONICAL_PROVIDER_IDS])
    .makeOptionMandatory();
}

export function cwdOption(): Option {
  return new Option("--cwd <absolute-path>", "absolute working directory").makeOptionMandatory();
}

export function collectValue(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function parseFacts(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("--facts must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

export function addSessionOptions(command: Command, allowAttach: boolean): Command {
  command
    .addOption(providerOption())
    .addOption(cwdOption())
    .option("--model <model>", "explicit provider model")
    .addOption(new Option("--effort <effort>", "explicit provider-native reasoning effort")
      .choices(["low", "medium", "high", "xhigh", "max", "ultra"]))
    .option("--role <role>", "optional opaque user-defined role label")
    .option("--name <name>", "session name")
    .addOption(new Option("--approval-mode <mode>", "provider permission/approval behavior")
      .choices(["prompt", "auto"]))
    .addOption(new Option("--sandbox <sandbox>").choices(["read-only", "workspace-write"]).default("read-only"));
  if (allowAttach) command.option("--attach", "attach a controlling client immediately");
  return command;
}

export async function withClient<T>(operation: (client: RpcClient) => Promise<T>): Promise<T> {
  const client = await RpcClient.connect(brokerSocketPath);
  try {
    return await operation(client);
  } finally {
    client.close();
  }
}

/**
 * Where a worker process may still be running, so pruning never pulls a directory out from under
 * one. The rule itself lives in `liveWorktreeCwds`; this is only the broker call. A broker that is
 * not running answers with an empty map rather than an error: worktree hygiene is useful on a
 * machine with no live Cyberdeck, and the other retention rules still hold.
 */
export async function liveSessionCwds(): Promise<Map<string, string>> {
  const sessions = await withClient((client) => client.request<SessionRecord[]>("session.list", {}))
    .catch(() => [] as SessionRecord[]);
  return liveWorktreeCwds(sessions);
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

function cliEntrypoint(): string {
  return resolve(process.argv[1] ?? cliEntrypointFromModulePath(fileURLToPath(import.meta.url)));
}

export async function waitForBroker(timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await withClient((client) => client.request("broker.status", {}));
      return;
    } catch (error) {
      lastError = error;
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
  const logDescriptor = openSync(logPath, "a");
  try {
    const child = spawn(process.execPath, [brokerEntry], {
      cwd: projectRoot(),
      detached: true,
      stdio: ["ignore", logDescriptor, logDescriptor],
    });
    child.unref();
  } finally {
    closeSync(logDescriptor);
  }
  await waitForBroker();
  if (announce) process.stdout.write(`Cyberdeck broker is running at ${brokerSocketPath}\n`);
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

/**
 * Open one worker's worktree in the nvim of the window this client occupies, then tell the broker
 * which address that was.
 *
 * The binding is what turns a one-shot open into something that keeps up: without it nvim keeps a
 * list and a read-only lock that nothing would ever lift when the worker finishes. It is reported
 * rather than thrown, because an open that succeeded is still worth having and the operator needs
 * to know it will not refresh itself.
 */
export async function openWorkerWorktree(
  session: SessionRecord,
  client: RpcClient,
  layout: { enabled: boolean; orchestratorSessionIds: readonly string[]; },
  toolkit: CliToolkit,
): Promise<string> {
  const { hostPaneId } = toolkit.preflightCockpit();
  if (hostPaneId === undefined) {
    throw Object.assign(
      new Error("Cyberdeck is not running inside a tmux pane, so there is no window to find nvim in"),
      { code: "TMUX_PANE_UNKNOWN" },
    );
  }
  const opened = await toolkit.openWorktreeInNvim({
    session,
    hostPaneId,
    layout,
  });
  const subject = toolkit.worktreeSubject(session);
  const changes = `${opened.entries} change${opened.entries === 1 ? "" : "s"}`;
  // Never make the operator guess what produced the count: the same "0 changes" means a clean
  // branch, a repository with no default branch to compare against, or no repository at all.
  const baseline = ` · ${opened.baseline.label}`;
  const guard = opened.live ? " · read-only while it runs" : "";
  try {
    await client.request("nvim.bind", {
      sessionId: opened.sessionId,
      address: opened.address,
      live: opened.live,
    });
  } catch {
    return `${subject} opened in ${opened.paneId} · ${changes}${baseline}${guard} · no refresh on completion`;
  }
  return `${subject} opened in ${opened.paneId} · ${changes}${baseline}${guard}`;
}

/**
 * Open a project's primary checkout in the same nvim, with no binding behind it.
 *
 * A binding exists to lift a worker's read-only lock when that worker finishes, and a checkout has
 * no worker of its own to wait for. The threads Fleet is already holding come along so the open can
 * see whether one of them is running in the checkout: that is what installs the guard on first
 * contact, rather than inheriting one from a worker row that may never have been opened.
 */
export async function openMainCheckout(
  cwd: string,
  layout: { enabled: boolean; orchestratorSessionIds: readonly string[]; },
  sessions: readonly SessionRecord[],
  toolkit: CliToolkit,
): Promise<string> {
  const { hostPaneId } = toolkit.preflightCockpit();
  if (hostPaneId === undefined) {
    throw Object.assign(
      new Error("Cyberdeck is not running inside a tmux pane, so there is no window to find nvim in"),
      { code: "TMUX_PANE_UNKNOWN" },
    );
  }
  const opened = await toolkit.openCheckoutInNvim({ checkout: cwd, hostPaneId, layout, sessions });
  const changes = `${opened.entries} change${opened.entries === 1 ? "" : "s"}`;
  const guard = opened.live ? " · read-only while a worker runs in it" : "";
  return `${basename(cwd)} checkout opened in ${opened.paneId} · ${changes} · ${opened.baseline.label}${guard}`;
}

export async function runCyberdeck(
  toolkit: CliToolkit,
  fleetRuntimeDeps: FleetRuntimeDeps,
): Promise<void> {
  let client: RpcClient;
  try {
    client = await RpcClient.connect(brokerSocketPath);
  } catch (error) {
    if (!isBrokerUnavailable(error)) throw error;
    await startDetachedBroker(false);
    client = await RpcClient.connect(brokerSocketPath);
  }
  const cliPath = cliEntrypoint();
  const nvimLayoutHooks = toolkit.createFleetNvimLayoutHooks({
    spawnSync: nodeSpawnSync as SpawnSyncLike,
    preflight: toolkit.preflightCockpit,
    nodePath: process.execPath,
    cliPath,
    ...(process.env.PATH === undefined ? {} : { hookPath: process.env.PATH }),
  });
  await runFleet(client, process.stdin, process.stdout, process, {
    ...fleetRuntimeDeps,
    changeDirectory: toolkit.openInteractiveShell,
    detachIdentity: `operator:${process.getuid?.() ?? "local"}`,
    openOrchestrator: (target) => openFleetCockpit(target, {
      preflight: toolkit.preflightCockpit,
      create: (request) => client.request<OrchestratorManagerResult>("orchestrator.create", request),
      resume: (sessionId) => client.request<SessionRecord>("session.resume", { sessionId }),
      stop: (sessionId) => client.request<void>("session.stop", { sessionId }),
      present: toolkit.launchCockpit,
    }),
    openWorktree: (session, layout) => openWorkerWorktree(session, client, layout, toolkit),
    openCheckout: (cwd, layout, sessions) =>
      openMainCheckout(cwd, layout, sessions, toolkit),
    nvimLayoutHooks,
  });
}

export async function runAttachment(
  sessionId: string,
  mode: "control" | "watch",
  toolkit: CliToolkit,
  options: { cockpitReturn?: "detach" | "switch"; } = {},
): Promise<void> {
  process.stdout.write("Detach with Ctrl-] · Esc and Option chords reach the agent\n");
  const client = await RpcClient.connect(brokerSocketPath);
  const cockpitReturn = options.cockpitReturn;
  try {
    const status = await attachSession({
      sessionId,
      mode,
      transport: client,
      ...(cockpitReturn !== undefined
        ? {
          detachIdentity: `operator:${process.getuid?.() ?? "local"}`,
          onExplicitDetach: () => toolkit.detachCockpit({ returnMode: cockpitReturn }),
        }
        : {}),
    });
    if (status !== 0) process.exitCode = status;
  } catch (error) {
    client.close();
    if (error instanceof RpcError && error.code === "SESSION_ALREADY_CONTROLLED") {
      throw new RpcError(error.code, `${error.message}; use cyberdeck watch ${sessionId}`);
    }
    throw error;
  }
}

export function sessionRequest(options: StartOptions, parentSessionId?: string) {
  return {
    provider: options.provider,
    cwd: options.cwd,
    detached: parentSessionId !== undefined || options.attach !== true,
    sandbox: options.sandbox,
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.effort === undefined ? {} : { effort: options.effort }),
    ...(options.role === undefined ? {} : { role: options.role }),
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(options.approvalMode === undefined ? {} : { approvalMode: options.approvalMode }),
    ...(parentSessionId === undefined ? {} : { parentSessionId }),
  };
}

/**
 * The catalog is the single source of truth for which providers can host an orchestrator, so the
 * first-launch cockpit flow offers exactly what Fleet's picker offers instead of drifting behind it.
 */
export const ORCHESTRATOR_PROVIDERS: readonly ProviderId[] = ORCHESTRATOR_CATALOG.map(
  (entry) => entry.provider,
);

export function parseOrchestratorProvider(value: string): ProviderId {
  if (!ORCHESTRATOR_PROVIDERS.includes(value)) {
    throw new Error(`orchestrator provider must be ${ORCHESTRATOR_PROVIDERS.join(", ")}`);
  }
  return value;
}

export interface OpenCockpitServices {
  preflight: () => CockpitPreflight;
  ensure: (request: EnsureOrchestratorRequest) => Promise<OrchestratorManagerResult>;
  stop: (sessionId: string) => Promise<void>;
  present: (options: CockpitOptions) => void;
}

export async function openCockpit(
  request: EnsureOrchestratorRequest,
  services: OpenCockpitServices,
): Promise<void> {
  const preflight = services.preflight();
  const result = await services.ensure(request);
  try {
    services.present({
      cliPath: cliEntrypoint(),
      cwd: request.cwd,
      orchestratorSessionId: result.session.id,
      preflight,
    });
  } catch (error) {
    if (!result.created) throw error;
    try {
      await services.stop(result.session.id);
    } catch (cleanupError) {
      throw addCleanupContext(error, cleanupError, "stop the newly created orchestrator");
    }
    throw error;
  }
}

export interface FleetCockpitServices {
  preflight: () => CockpitPreflight;
  create: (request: CreateOrchestratorRequest) => Promise<OrchestratorManagerResult>;
  resume: (sessionId: string) => Promise<SessionRecord>;
  stop: (sessionId: string) => Promise<void>;
  present: (options: CockpitOptions) => void;
}

export async function openFleetCockpit(
  target: OrchestratorCockpitTarget,
  services: FleetCockpitServices,
): Promise<SessionRecord> {
  const preflight = services.preflight();
  const result = target.type === "create"
    ? await services.create(target.request)
    : {
      session: target.requiresResume
        ? await services.resume(target.session.id)
        : target.session,
      created: false,
    };
  try {
    services.present({
      cliPath: cliEntrypoint(),
      cwd: target.cockpitCwd,
      orchestratorSessionId: result.session.id,
      preflight,
    });
    return result.session;
  } catch (error) {
    if (!result.created) throw error;
    try {
      await services.stop(result.session.id);
    } catch (cleanupError) {
      throw addCleanupContext(error, cleanupError, "stop the newly created orchestrator");
    }
    throw error;
  }
}

export async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}


export function addCleanupContext(primary: unknown, cleanup: unknown, action: string): Error {
  const primaryError = primary instanceof Error ? primary : new Error(String(primary));
  const cleanupMessage = cleanup instanceof Error ? cleanup.message : String(cleanup);
  const combined = new Error(`${primaryError.message}; cleanup also failed to ${action}: ${cleanupMessage}`, {
    cause: primaryError,
  });
  if ("code" in primaryError) Object.assign(combined, { code: primaryError.code });
  return combined;
}

export const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
