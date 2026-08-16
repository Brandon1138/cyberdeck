#!/usr/bin/env node

import { closeSync, existsSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { spawn, spawnSync as nodeSpawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Command, Option } from "commander";
import { runBroker } from "./broker/main.js";
import type {
  FleetProjectAddResult,
  FleetProjectRemoveResult,
} from "./broker/fleet-project-service.js";
import type {
  ApprovalMode,
  ReasoningEffort,
  ResolvedLaunchRecord,
  SessionRecord,
} from "./domain/session.js";
import { CANONICAL_PROVIDER_IDS, type ProviderId } from "./domain/provider-registration.js";
import type {
  OrchestratorManagerResult,
  OrchestratorResetResult,
} from "./orchestration/orchestrator-manager.js";
import { ORCHESTRATOR_CATALOG } from "./orchestration/orchestrator-catalog.js";
import {
  GitWorktreeInventory,
  liveWorktreeCwds,
  retentionVerdict,
} from "./orchestration/worktree-inventory.js";
import type {
  CavemanWorkersRequest,
  CavemanWorkersResult,
  CreateOrchestratorRequest,
  CursorWorkersRequest,
  CursorWorkersResult,
  EnsureOrchestratorRequest,
  FableWorkersRequest,
  FableWorkersResult,
  ResetOrchestratorRequest,
} from "./domain/orchestrator.js";
import { appStateDirectory, brokerSocketPath } from "./paths.js";
import { RpcClient, RpcError } from "./client/rpc-client.js";
import { attachSession } from "./client/attach.js";
import { runDashboard } from "./client/dashboard.js";
import { runFleet, type OrchestratorCockpitTarget } from "./client/fleet.js";
import {
  detachCockpit,
  launchCockpit,
  preflightCockpit,
  type CockpitOptions,
  type CockpitPreflight,
  type SpawnSyncLike,
} from "./tmux/cockpit.js";
import {
  openWorktreeInNvim,
  selectSession,
  worktreeSubject,
} from "./nvim/open-worktree.js";
import {
  createFleetNvimLayoutHooks,
  rebalanceNvimLayoutFromHook,
} from "./nvim/layout-hook.js";
import { CYBERDECK_VERSION } from "./version.js";
import { resolveLaunchConversationId, runMcpServer } from "./mcp/server.js";
import { openInteractiveShell } from "./tmux/interactive-shell.js";
import { runShellCommand } from "./runtime/shell-command.js";
import { pruneLegacyTranscript as pruneLegacyTranscriptFile } from "./persistence/thread-transcript-store.js";
import type { ScoutEgressStatus } from "./persistence/scout-egress-grant-store.js";
import type {
  WorkerEventSubmitParams,
} from "./broker/worker-event-channel.js";
import type { EventAck } from "./domain/worker-coordination.js";

interface SessionLaunchRecordResult {
  sessionId: string;
  provider: ProviderId;
  launchRecord: ResolvedLaunchRecord | null;
}

interface StartOptions {
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

interface DelegateOptions extends StartOptions {
  parent: string;
}

interface EventSubmitOptions {
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

function providerOption(): Option {
  return new Option("--provider <provider>", "explicit provider")
    .choices([...CANONICAL_PROVIDER_IDS])
    .makeOptionMandatory();
}

function cwdOption(): Option {
  return new Option("--cwd <absolute-path>", "absolute working directory").makeOptionMandatory();
}

function collectValue(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseFacts(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("--facts must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function addSessionOptions(command: Command, allowAttach: boolean): Command {
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

async function withClient<T>(operation: (client: RpcClient) => Promise<T>): Promise<T> {
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
async function liveSessionCwds(): Promise<Map<string, string>> {
  const sessions = await withClient((client) => client.request<SessionRecord[]>("session.list", {}))
    .catch(() => [] as SessionRecord[]);
  return liveWorktreeCwds(sessions);
}

function projectRoot(): string {
  const sourceDirectory = dirname(fileURLToPath(import.meta.url));
  const parent = dirname(sourceDirectory);
  return basename(parent) === "dist" ? dirname(parent) : parent;
}

async function waitForBroker(timeoutMs = 5_000): Promise<void> {
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

async function waitForBrokerStop(timeoutMs = 5_000): Promise<void> {
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

async function startDetachedBroker(announce = true): Promise<void> {
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

function isBrokerUnavailable(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  return error.code === "ENOENT" || error.code === "ECONNREFUSED";
}

async function restartDetachedBroker(): Promise<void> {
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
async function openWorkerWorktree(
  session: SessionRecord,
  client: RpcClient,
  layout: { enabled: boolean; orchestratorSessionIds: readonly string[] },
): Promise<string> {
  const { hostPaneId } = preflightCockpit();
  if (hostPaneId === undefined) {
    throw Object.assign(
      new Error("Cyberdeck is not running inside a tmux pane, so there is no window to find nvim in"),
      { code: "TMUX_PANE_UNKNOWN" },
    );
  }
  const opened = await openWorktreeInNvim({
    session,
    hostPaneId,
    layout,
  });
  const subject = worktreeSubject(session);
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

async function runCyberdeck(): Promise<void> {
  let client: RpcClient;
  try {
    client = await RpcClient.connect(brokerSocketPath);
  } catch (error) {
    if (!isBrokerUnavailable(error)) throw error;
    await startDetachedBroker(false);
    client = await RpcClient.connect(brokerSocketPath);
  }
  const cliPath = resolve(process.argv[1] ?? fileURLToPath(import.meta.url));
  const nvimLayoutHooks = createFleetNvimLayoutHooks({
    spawnSync: nodeSpawnSync as SpawnSyncLike,
    preflight: () => preflightCockpit(),
    nodePath: process.execPath,
    cliPath,
    hookPath: process.env.PATH,
  });
  await runFleet(client, process.stdin, process.stdout, process, {
    changeDirectory: openInteractiveShell,
    runShellCommand,
    detachIdentity: `operator:${process.getuid?.() ?? "local"}`,
    openOrchestrator: (target) => openFleetCockpit(target, {
      preflight: () => preflightCockpit(),
      create: (request) => client.request<OrchestratorManagerResult>("orchestrator.create", request),
      resume: (sessionId) => client.request<SessionRecord>("session.resume", { sessionId }),
      stop: (sessionId) => client.request<void>("session.stop", { sessionId }),
      present: launchCockpit,
    }),
    openWorktree: (session, layout) => openWorkerWorktree(session, client, layout),
    nvimLayoutHooks,
  });
}

async function runAttachment(
  sessionId: string,
  mode: "control" | "watch",
  options: { cockpitReturn?: "detach" | "switch" } = {},
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
          onExplicitDetach: () => detachCockpit({ returnMode: cockpitReturn }),
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

function sessionRequest(options: StartOptions, parentSessionId?: string) {
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
const ORCHESTRATOR_PROVIDERS: readonly ProviderId[] = ORCHESTRATOR_CATALOG.map(
  (entry) => entry.provider,
);

function parseOrchestratorProvider(value: string): ProviderId {
  if (!ORCHESTRATOR_PROVIDERS.includes(value)) {
    throw new Error(`orchestrator provider must be ${ORCHESTRATOR_PROVIDERS.join(", ")}`);
  }
  return value;
}

interface OpenCockpitServices {
  preflight: () => CockpitPreflight;
  ensure: (request: EnsureOrchestratorRequest) => Promise<OrchestratorManagerResult>;
  stop: (sessionId: string) => Promise<void>;
  present: (options: CockpitOptions) => void;
}

async function openCockpit(
  request: EnsureOrchestratorRequest,
  services: OpenCockpitServices,
): Promise<void> {
  const preflight = services.preflight();
  const result = await services.ensure(request);
  try {
    services.present({
      cliPath: resolve(process.argv[1] ?? fileURLToPath(import.meta.url)),
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
      cliPath: resolve(process.argv[1] ?? fileURLToPath(import.meta.url)),
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

interface CreateProgramOptions {
  runDefault?: () => Promise<void>;
  restartBroker?: () => Promise<void>;
  preflightCockpit?: () => CockpitPreflight;
  launchCockpit?: (options: CockpitOptions) => void;
  ensureOrchestrator?: (request: EnsureOrchestratorRequest) => Promise<OrchestratorManagerResult>;
  stopSession?: (sessionId: string) => Promise<void>;
  resetOrchestrator?: (request: ResetOrchestratorRequest) => Promise<OrchestratorResetResult>;
  fableWorkers?: (request: FableWorkersRequest) => Promise<FableWorkersResult>;
  cursorWorkers?: (request: CursorWorkersRequest) => Promise<CursorWorkersResult>;
  cavemanWorkers?: (request: CavemanWorkersRequest) => Promise<CavemanWorkersResult>;
  pruneLegacyTranscript?: () => Promise<{ path: string; removed: boolean }>;
  submitWorkerEvent?: (request: WorkerEventSubmitParams) => Promise<EventAck>;
  scoutEgress?: (request: { root: string; enabled?: boolean }) => Promise<ScoutEgressStatus>;
  rebalanceNvimLayout?: (windowId: string) => void | Promise<void>;
  listProjects?: () => Promise<string[]>;
  addProject?: (request: { path: string; acceptParent?: boolean }) => Promise<FleetProjectAddResult>;
  removeProject?: (request: { path: string }) => Promise<FleetProjectRemoveResult>;
}

export function createProgram(options: CreateProgramOptions = {}): Command {
  const runDefault = options.runDefault ?? runCyberdeck;
  const restartBroker = options.restartBroker ?? restartDetachedBroker;
  const runCockpitPreflight = options.preflightCockpit ?? (() => preflightCockpit());
  const presentCockpit = options.launchCockpit ?? launchCockpit;
  const ensureOrchestrator = options.ensureOrchestrator ?? ((request) =>
    withClient((client) => client.request<OrchestratorManagerResult>("orchestrator.ensure", request)));
  const stopSession = options.stopSession ?? ((sessionId) =>
    withClient((client) => client.request<void>("session.stop", { sessionId })));
  const resetOrchestrator = options.resetOrchestrator ?? ((request) =>
    withClient((client) => client.request<OrchestratorResetResult>("orchestrator.reset", request)));
  const fableWorkers = options.fableWorkers ?? ((request) =>
    withClient((client) => client.request<FableWorkersResult>("orchestrator.fableWorkers", request)));
  const cursorWorkers = options.cursorWorkers ?? ((request) =>
    withClient((client) => client.request<CursorWorkersResult>("orchestrator.cursorWorkers", request)));
  const cavemanWorkers = options.cavemanWorkers ?? ((request) =>
    withClient((client) => client.request<CavemanWorkersResult>("orchestrator.cavemanWorkers", request)));
  const pruneLegacyTranscript = options.pruneLegacyTranscript
    ?? (() => pruneLegacyTranscriptFile(appStateDirectory, true));
  const submitWorkerEvent = options.submitWorkerEvent
    ?? ((request) => withClient((client) =>
      client.request<EventAck>("worker.event.submit", request)));
  const scoutEgress = options.scoutEgress
    ?? ((request: { root: string; enabled?: boolean }) =>
      withClient((client) => client.request<ScoutEgressStatus>("scout.egress", request)));
  const rebalanceNvimLayout = options.rebalanceNvimLayout
    ?? ((windowId: string) => {
      rebalanceNvimLayoutFromHook({
        spawnSync: nodeSpawnSync as SpawnSyncLike,
        windowId,
        cliPath: resolve(process.argv[1] ?? fileURLToPath(import.meta.url)),
      });
    });
  const listProjects = options.listProjects
    ?? (() => withClient((client) => client.request<string[]>("fleet.projects", {})));
  const addProject = options.addProject
    ?? ((request: { path: string; acceptParent?: boolean }) =>
      withClient((client) => client.request<FleetProjectAddResult>("fleet.project.add", request)));
  const removeProject = options.removeProject
    ?? ((request: { path: string }) =>
      withClient((client) => client.request<FleetProjectRemoveResult>("fleet.project.remove", request)));
  const program = new Command()
    .name("cyberdeck")
    .version(CYBERDECK_VERSION)
    .description("Neutral broker for durable Claude and Codex terminal sessions")
    .addHelpText(
      "after",
      "\nExplicit operator-selected Fable starts are allowed. Autonomous Fable workers require the durable worker.start.fable grant."
        + "\nAutonomous Cursor workers require the durable worker.start.cursor grant; a Cursor Fable slug requires both.\n",
    )
    .action(runDefault);

  const broker = program.command("broker").description("manage the durable broker process");
  broker.command("run").action(async () => {
    await runBroker();
  });
  broker.command("start").action(startDetachedBroker);
  broker.command("status").action(async () => {
    const status = await withClient((client) => client.request("broker.status", {}));
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  });
  broker.command("stop").action(async () => {
    await withClient((client) => client.request("broker.shutdown", {}));
    process.stdout.write("Cyberdeck broker shutdown requested\n");
  });
  broker.command("restart").description("gracefully replace the running broker").action(restartBroker);

  const nvimLayout = program.command("nvim-layout")
    .description("internal tmux nvim layout maintenance");
  nvimLayout.command("rebalance")
    .description("quietly rebalance one Fleet window")
    .requiredOption("-w, --window <window-id>", "tmux window id")
    .action(async (options: { window: string }) => {
      await rebalanceNvimLayout(options.window);
    });

  // The registry the Fleet list groups by. Paths are resolved against the shell's cwd here and
  // against git in the broker, so `cyberdeck project add .` inside a repository is the short form.
  const projectCommand = program.command("project")
    .description("manage the repositories the Fleet list groups threads under");
  projectCommand.command("list")
    .description("list registered projects")
    .action(async () => {
      const roots = await listProjects();
      process.stdout.write(roots.length === 0 ? "No registered projects\n" : `${roots.join("\n")}\n`);
    });
  projectCommand.command("add")
    .description("register a repository as a project")
    .argument("[path]", "path inside the repository (defaults to current directory)")
    .option("--parent", "when the path is a linked worktree, register its repository")
    .action(async (path: string | undefined, commandOptions: { parent?: boolean }) => {
      const result = await addProject({
        path: resolve(path ?? process.cwd()),
        ...(commandOptions.parent === true ? { acceptParent: true } : {}),
      });
      if (result.status === "worktree") {
        process.stdout.write(
          `${result.toplevel} is a linked worktree of ${result.root}\n`
            + `Nothing was registered. Re-run with --parent to register ${result.root}\n`,
        );
        process.exitCode = 1;
        return;
      }
      process.stdout.write(
        `${result.alreadyRegistered ? "Already a project" : "Registered project"}: ${result.root}\n`,
      );
    });
  projectCommand.command("rm")
    .description("unregister a project; its threads become unregistered, nothing is deleted")
    .argument("[path]", "registered project root (defaults to current directory)")
    .action(async (path: string | undefined) => {
      const result = await removeProject({ path: resolve(path ?? process.cwd()) });
      process.stdout.write(
        result.removed
          ? `Removed project: ${result.root}\n`
          : `Not a registered project: ${result.root}\n`,
      );
      if (!result.removed) process.exitCode = 1;
    });

  // Cyberdeck creates worktrees automatically and removes them only here, on an explicit command.
  // The asymmetry is the retention policy: `retentionVerdict` decides what may go, and `--yes`
  // decides whether anything actually does. See docs/architecture/worktree-provisioning.md.
  const worktreeCommand = program.command("worktree")
    .description("inspect and reclaim the worktrees Cyberdeck provisioned for workers");
  worktreeCommand.command("list")
    .description("list Cyberdeck-provisioned worktrees of a repository and their retention verdict")
    .argument("[path]", "path inside the repository (defaults to current directory)")
    .option("--json", "print machine-readable JSON")
    .action(async (path: string | undefined, options: { json?: boolean }) => {
      const inventory = new GitWorktreeInventory({ liveSessions: await liveSessionCwds() });
      const worktrees = await inventory.list(resolve(path ?? process.cwd()));
      const rows = worktrees.map((worktree) => ({ worktree, verdict: retentionVerdict(worktree) }));
      if (options.json === true) {
        process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
        return;
      }
      if (rows.length === 0) {
        process.stdout.write("No Cyberdeck-provisioned worktrees\n");
        return;
      }
      for (const { worktree, verdict } of rows) {
        process.stdout.write(
          `${verdict.keep ? "keep " : "prune"} ${worktree.path} ${worktree.branch ?? "detached"} (${verdict.reason})\n`,
        );
      }
    });
  worktreeCommand.command("prune")
    .description("remove Cyberdeck-provisioned worktrees that the retention policy clears")
    .argument("[path]", "path inside the repository (defaults to current directory)")
    .option("--yes", "actually remove; without it this prints the plan and changes nothing")
    .action(async (path: string | undefined, options: { yes?: boolean }) => {
      const inventory = new GitWorktreeInventory({ liveSessions: await liveSessionCwds() });
      const worktrees = await inventory.list(resolve(path ?? process.cwd()));
      let removable = 0;
      for (const worktree of worktrees) {
        const verdict = retentionVerdict(worktree);
        if (verdict.keep) {
          process.stdout.write(`kept    ${worktree.path} (${verdict.reason})\n`);
          continue;
        }
        removable += 1;
        if (options.yes !== true) {
          process.stdout.write(
            `would remove ${worktree.path}${verdict.removeBranch ? ` and branch ${worktree.branch ?? ""}` : ""} (${verdict.reason})\n`,
          );
          continue;
        }
        try {
          await inventory.remove(worktree, verdict.removeBranch);
          process.stdout.write(`removed ${worktree.path}\n`);
        } catch (error) {
          process.stdout.write(`failed  ${worktree.path}: ${(error as Error).message}\n`);
          process.exitCode = 1;
        }
      }
      if (removable > 0 && options.yes !== true) {
        process.stdout.write(`Nothing was removed. Re-run with --yes to reclaim ${removable}.\n`);
      }
    });

  const scoutEgressCommand = program.command("scout-egress")
    .description("manage durable exact-repository Cursor Scout source egress");
  scoutEgressCommand.command("status")
    .option("--root <absolute-path>", "exact Git repository root (defaults to current directory)")
    .action(async (options: { root?: string }) => {
      const result = await scoutEgress({ root: resolve(options.root ?? process.cwd()) });
      process.stdout.write(
        `Scout egress: ${result.enabled ? "ON" : "OFF"} · Cursor Composer · read-only · ${result.root}\n`,
      );
    });
  for (const enabled of [true, false] as const) {
    scoutEgressCommand.command(enabled ? "on" : "off")
      .requiredOption("--root <absolute-path>", "exact Git repository root")
      .action(async (options: { root: string }) => {
        const result = await scoutEgress({
          root: resolve(options.root),
          enabled,
        });
        process.stdout.write(
          `Scout egress: ${result.enabled ? "ON" : "OFF"} · Cursor Composer · read-only · ${result.root}\n`,
        );
      });
  }

  const event = program.command("event").description("submit bounded worker events");
  event.command("submit")
    .description("submit one idempotent worker event")
    .requiredOption("--worker <session-id>", "worker session UUID")
    .requiredOption(
      "--kind <kind>",
      "EXCEPTION, PROGRESS, CHECKPOINT, RISK, or DECISION_REQUEST",
    )
    .requiredOption("--summary <text>", "bounded event summary")
    .option("--event-id <id>", "stable event ID for idempotent retry")
    .addOption(new Option("--severity <severity>")
      .choices(["info", "warning", "error", "critical"])
      .default("info"))
    .option("--intervention", "mark intervention required")
    .option("--facts <json>", "structured facts JSON object")
    .option("--evidence <ref>", "evidence reference; repeatable", collectValue, [])
    .option(
      "--changed-assumption <text>",
      "changed assumption; repeatable",
      collectValue,
      [],
    )
    .option("--recommended-action <text>", "recommended next action")
    .addOption(new Option("--continuation <state>")
      .choices(["continuing", "blocked", "paused", "awaiting-response"])
      .default("continuing"))
    .option("--checkpoint-correlation-id <id>", "pending checkpoint correlation ID")
    .action(async (options: EventSubmitOptions) => {
      const ack = await submitWorkerEvent({
        workerId: options.worker,
        ...(options.eventId === undefined ? {} : { eventId: options.eventId }),
        kind: options.kind,
        severity: options.severity,
        interventionRequired: options.intervention === true,
        summary: options.summary,
        ...(options.facts === undefined
          ? {}
          : { structuredFacts: parseFacts(options.facts) }),
        evidenceRefs: options.evidence,
        changedAssumptions: options.changedAssumption,
        ...(options.recommendedAction === undefined
          ? {}
          : { recommendedAction: options.recommendedAction }),
        continuation: options.continuation,
        ...(options.checkpointCorrelationId === undefined
          ? {}
          : { checkpointCorrelationId: options.checkpointCorrelationId }),
      });
      process.stdout.write(`${JSON.stringify(ack)}\n`);
    });

  const transcript = program.command("transcript").description("manage local transcript retention");
  transcript.command("prune-legacy")
    .description("permanently delete the pre-semantic raw PTY transcript")
    .requiredOption(
      "--confirm-delete-legacy-transcript",
      "confirm permanent deletion of threads/transcript.jsonl",
    )
    .action(async () => {
      const result = await pruneLegacyTranscript();
      process.stdout.write(result.removed
        ? `Deleted legacy transcript ${result.path}\n`
        : `No legacy transcript exists at ${result.path}\n`);
    });

  addSessionOptions(program.command("start").description("start a durable top-level session"), true)
    .action(async (options: StartOptions) => {
      const record = await withClient((client) => client.request<SessionRecord>("session.start", sessionRequest(options)));
      process.stdout.write(`${record.id}\n`);
      if (options.attach === true) {
        await runAttachment(record.id, "control");
      }
    });

  addSessionOptions(
    program.command("delegate").description("start one explicitly selected delegated worker")
      .requiredOption("--parent <session-id>", "parent session UUID"),
    false,
  ).action(async (options: DelegateOptions) => {
    const record = await withClient((client) =>
      client.request<SessionRecord>("session.start", sessionRequest(options, options.parent)),
    );
    process.stdout.write(`${record.id}\n`);
  });

  program.command("list")
    .option("--json", "print machine-readable JSON")
    .action(async (options: { json?: boolean }) => {
      const sessions = await withClient((client) => client.request<SessionRecord[]>("session.list", {}));
      if (options.json === true) {
        process.stdout.write(`${JSON.stringify(sessions, null, 2)}\n`);
        return;
      }
      for (const session of sessions) {
        process.stdout.write(
          `${session.id} ${session.provider} ${session.model ?? "native-default"} ${session.role ?? "unassigned"} ${session.executionState} ${session.attachmentState} ${session.cwd}\n`,
        );
      }
    });

  program.command("send")
    .argument("<id>", "session UUID")
    .argument("<message>", "message to submit")
    .action(async (sessionId: string, message: string) => {
      await withClient((client) => client.request("session.submit", { sessionId, message }));
    });

  program.command("stop")
    .argument("<id>", "session UUID")
    .action(async (sessionId: string) => {
      await withClient((client) => client.request("session.stop", { sessionId }));
    });

  // The nvim being opened into is the one in this client's tmux window, so this verb is only
  // meaningful run from that window — the same place the Fleet keybinding runs from.
  program.command("open")
    .description("open a worker's worktree in the nvim running in this tmux window")
    .argument("<id>", "session UUID or exact session name")
    .action(async (query: string) => {
      const notice = await withClient(async (client) => {
        const sessions = await client.request<SessionRecord[]>("session.list", {});
        return await openWorkerWorktree(selectSession(sessions, query), client, {
          // This verb opens in its caller's window, which need not be Fleet's. Automatic geometry
          // is intentionally reserved for Fleet's Ctrl+N and its own window-scoped hooks.
          enabled: false,
          orchestratorSessionIds: sessions
            .filter((session) => session.kind === "orchestrator")
            .map((session) => session.id),
        });
      });
      process.stdout.write(`${notice}\n`);
    });

  program.command("logs")
    .argument("<id>", "session UUID")
    .action(async (sessionId: string) => {
      const snapshot = await withClient((client) => client.request<{ data: string }>("session.snapshot", { sessionId }));
      process.stdout.write(Buffer.from(snapshot.data, "base64"));
    });

  // Read-only. The broker records what it actually spawned; reconstructing a spec here would both
  // run provider preflight (writing files as a side effect of an inspection) and report a spec the
  // running process was never launched with. Environment values never leave the broker.
  program.command("launch-spec")
    .description("print the sanitized launch record the broker resolved for one session")
    .argument("<id>", "session UUID")
    .action(async (sessionId: string) => {
      const result = await withClient((client) =>
        client.request<SessionLaunchRecordResult>("session.launchRecord", { sessionId }));
      if (result.launchRecord === null) {
        throw new Error(`No resolved launch record has been captured for session ${sessionId}`);
      }
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    });

  program.command("attach")
    .argument("<id>", "session UUID")
    .addOption(new Option("--cockpit-return <mode>", "return the tmux client to Fleet on explicit detach")
      .choices(["detach", "switch"]))
    .action((sessionId: string, options: { cockpitReturn?: "detach" | "switch" }) =>
      runAttachment(sessionId, "control", options));

  program.command("watch")
    .argument("<id>", "session UUID")
    .action((sessionId: string) => runAttachment(sessionId, "watch"));

  program.command("mcp")
    .description("serve capability-scoped Cyberdeck tools over stdio MCP")
    .requiredOption("--actor-session <id>", "bound orchestrator session UUID")
    .action(async (options: { actorSession: string }) => {
      const conversationId = resolveLaunchConversationId();
      const identity = {
        actorSessionId: options.actorSession,
        ...(conversationId === undefined ? {} : { launchConversationId: conversationId }),
        brokerSocketPath,
      };
      let client: RpcClient;
      try {
        client = await RpcClient.connect(brokerSocketPath);
      } catch (error) {
        // Exiting here is what made the failure silent: the harness drops the whole server and the
        // conversation simply stops having cyberdeck_* tools, with nothing to read. Serve instead,
        // so tools/list still advertises the surface and every call names the missing broker.
        await runMcpServer({
          identity,
          brokerUnavailable:
            `Cyberdeck broker is unreachable at ${brokerSocketPath}: ${error instanceof Error ? error.message : String(error)}`,
        });
        return;
      }
      try {
        await runMcpServer({ transport: client, identity });
      } finally {
        client.close();
      }
    });

  program.command("dashboard").action(runDefault);

  program.command("diagnostics").action(async () => {
    const client = await RpcClient.connect(brokerSocketPath);
    await runDashboard(client);
  });

  program.command("cockpit")
    .option("--orchestrator <provider>", "explicit orchestrator provider", parseOrchestratorProvider)
    .option("--model <model>", "explicit orchestrator model")
    .addOption(new Option("--effort <effort>", "explicit orchestrator reasoning effort")
      .choices(["low", "medium", "high", "xhigh", "max", "ultra"]))
    .addOption(new Option("--scope <scope>").choices(["workspace", "fleet"]).default("fleet"))
    .action(async (options: { orchestrator?: ProviderId; model?: string; effort?: ReasoningEffort; scope: "workspace" | "fleet" }) => {
      const cwd = process.cwd();
      await openCockpit({
        cwd,
        scope: options.scope,
        ...(options.orchestrator === undefined ? {} : { provider: options.orchestrator }),
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.effort === undefined ? {} : { effort: options.effort }),
      }, {
        preflight: runCockpitPreflight,
        ensure: ensureOrchestrator,
        stop: stopSession,
        present: presentCockpit,
      });
    });

  const orchestrator = program.command("orchestrator").description("manage durable orchestrator bindings");
  orchestrator.command("reset")
    .description("invalidate an inactive fleet or workspace orchestrator binding")
    .option("--cwd <absolute-path>", "workspace path (defaults to the current directory)")
    .addOption(new Option("--scope <scope>").choices(["workspace", "fleet"]).default("fleet"))
    .action(async (options: { cwd?: string; scope: "workspace" | "fleet" }) => {
      const result = await resetOrchestrator({
        cwd: resolve(options.cwd ?? process.cwd()),
        scope: options.scope,
      });
      if (result.reset) {
        process.stdout.write(`Reset orchestrator binding ${result.key} (${result.sessionId ?? "unknown session"})\n`);
      } else {
        process.stdout.write(`No orchestrator binding exists for ${result.key}\n`);
      }
    });

  orchestrator.command("fable-workers")
    .description("inspect or change delegated Fable access for one orchestrator binding")
    .argument("[mode]", "status, on, or off", "status")
    .option("--cwd <absolute-path>", "workspace path (defaults to the current directory)")
    .addOption(new Option("--scope <scope>").choices(["workspace", "fleet"]).default("fleet"))
    .action(async (mode: string, options: { cwd?: string; scope: "workspace" | "fleet" }) => {
      if (mode !== "status" && mode !== "on" && mode !== "off") {
        throw new Error("mode must be status, on, or off");
      }
      const result = await fableWorkers({
        cwd: resolve(options.cwd ?? process.cwd()),
        scope: options.scope,
        ...(mode === "status" ? {} : { enabled: mode === "on" }),
      });
      if (!result.configured) {
        process.stdout.write(`Fable workers: OFF · no orchestrator bound for ${result.key}\n`);
        return;
      }
      process.stdout.write(
        `Fable workers: ${result.enabled ? "ON" : "OFF"} · ${result.key} · ${result.sessionId}\n`,
      );
    });

  orchestrator.command("cursor-workers")
    .description("inspect or change delegated Cursor access for one orchestrator binding")
    .argument("[mode]", "status, on, or off", "status")
    .option("--cwd <absolute-path>", "workspace path (defaults to the current directory)")
    .addOption(new Option("--scope <scope>").choices(["workspace", "fleet"]).default("fleet"))
    .action(async (mode: string, options: { cwd?: string; scope: "workspace" | "fleet" }) => {
      if (mode !== "status" && mode !== "on" && mode !== "off") {
        throw new Error("mode must be status, on, or off");
      }
      const result = await cursorWorkers({
        cwd: resolve(options.cwd ?? process.cwd()),
        scope: options.scope,
        ...(mode === "status" ? {} : { enabled: mode === "on" }),
      });
      if (!result.configured) {
        process.stdout.write(`Cursor workers: OFF · no orchestrator bound for ${result.key}\n`);
        return;
      }
      process.stdout.write(
        `Cursor workers: ${result.enabled ? "ON" : "OFF"} · ${result.key} · ${result.sessionId}\n`,
      );
    });

  orchestrator.command("caveman-workers")
    .description("inspect or change the box default for subsequently started workers")
    .argument("[mode]", "status, on, or off", "status")
    .action(async (mode: string) => {
      if (mode !== "status" && mode !== "on" && mode !== "off") {
        throw new Error("mode must be status, on, or off");
      }
      const result = await cavemanWorkers({
        ...(mode === "status" ? {} : { enabled: mode === "on" }),
      });
      process.stdout.write(
        `Caveman workers: ${result.enabled ? "ON" : "OFF"} · box default · new workers\n`,
      );
    });

  const workflow = program.command("workflow").description("inspect or stop bounded orchestration workflows");
  workflow.command("list").action(async () => {
    const runs = await withClient((client) => client.request("workflow.list", {}));
    process.stdout.write(`${JSON.stringify(runs, null, 2)}\n`);
  });
  workflow.command("cancel")
    .argument("<run-id>", "workflow UUID")
    .option("--reason <reason>", "operator cancellation reason")
    .action(async (runId: string, options: { reason?: string }) => {
      await withClient((client) => client.request("workflow.cancel", {
        runId,
        ...(options.reason === undefined ? {} : { reason: options.reason }),
      }));
    });

  return program;
}

function addCleanupContext(primary: unknown, cleanup: unknown, action: string): Error {
  const primaryError = primary instanceof Error ? primary : new Error(String(primary));
  const cleanupMessage = cleanup instanceof Error ? cleanup.message : String(cleanup);
  const combined = new Error(`${primaryError.message}; cleanup also failed to ${action}: ${cleanupMessage}`, {
    cause: primaryError,
  });
  if ("code" in primaryError) Object.assign(combined, { code: primaryError.code });
  return combined;
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
const isMainModule = invokedPath !== undefined
  && realpathSync(invokedPath) === realpathSync(fileURLToPath(import.meta.url));
if (isMainModule) {
  await createProgram().parseAsync().catch((error) => {
    const prefix = error instanceof RpcError ? `${error.code}: ` : "";
    process.stderr.write(`${prefix}${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
