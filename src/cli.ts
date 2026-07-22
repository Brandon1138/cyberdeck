#!/usr/bin/env node

import { closeSync, existsSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Command, Option } from "commander";
import { runBroker } from "./broker/main.js";
import type { ReasoningEffort, SessionRecord } from "./domain/session.js";
import { CANONICAL_PROVIDER_IDS, type ProviderId } from "./domain/provider-registration.js";
import type {
  OrchestratorManagerResult,
  OrchestratorResetResult,
} from "./orchestration/orchestrator-manager.js";
import type { EnsureOrchestratorRequest, ResetOrchestratorRequest } from "./domain/orchestrator.js";
import { appStateDirectory, brokerSocketPath } from "./paths.js";
import { RpcClient, RpcError } from "./client/rpc-client.js";
import { attachSession } from "./client/attach.js";
import { runDashboard } from "./client/dashboard.js";
import { runFleet } from "./client/fleet.js";
import {
  launchCockpit,
  preflightCockpit,
  type CockpitOptions,
  type CockpitPreflight,
} from "./tmux/cockpit.js";
import { CYBERDECK_VERSION } from "./version.js";
import { runMcpServer } from "./mcp/server.js";

interface StartOptions {
  provider: ProviderId;
  cwd: string;
  model?: string;
  effort?: ReasoningEffort;
  role?: string;
  name?: string;
  sandbox: "read-only" | "workspace-write";
  attach?: boolean;
}

interface DelegateOptions extends StartOptions {
  parent: string;
}

function providerOption(): Option {
  return new Option("--provider <provider>", "explicit provider")
    .choices([...CANONICAL_PROVIDER_IDS])
    .makeOptionMandatory();
}

function cwdOption(): Option {
  return new Option("--cwd <absolute-path>", "absolute working directory").makeOptionMandatory();
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

async function runCyberdeck(): Promise<void> {
  let client: RpcClient;
  try {
    client = await RpcClient.connect(brokerSocketPath);
  } catch (error) {
    if (!isBrokerUnavailable(error)) throw error;
    await startDetachedBroker(false);
    client = await RpcClient.connect(brokerSocketPath);
  }
  await runFleet(client, process.stdin, process.stdout, process, {
    openOrchestrator: (request) => openCockpit(request, {
      preflight: () => preflightCockpit(),
      ensure: (next) => client.request<OrchestratorManagerResult>("orchestrator.ensure", next),
      stop: (sessionId) => client.request<void>("session.stop", { sessionId }),
      present: launchCockpit,
    }),
  });
}

async function runAttachment(sessionId: string, mode: "control" | "watch"): Promise<void> {
  process.stdout.write("Detach with Ctrl-]\n");
  const client = await RpcClient.connect(brokerSocketPath);
  try {
    const status = await attachSession({ sessionId, mode, transport: client });
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
    ...(parentSessionId === undefined ? {} : { parentSessionId }),
  };
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

interface CreateProgramOptions {
  runDefault?: () => Promise<void>;
  restartBroker?: () => Promise<void>;
  preflightCockpit?: () => CockpitPreflight;
  launchCockpit?: (options: CockpitOptions) => void;
  ensureOrchestrator?: (request: EnsureOrchestratorRequest) => Promise<OrchestratorManagerResult>;
  stopSession?: (sessionId: string) => Promise<void>;
  resetOrchestrator?: (request: ResetOrchestratorRequest) => Promise<OrchestratorResetResult>;
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
  const program = new Command()
    .name("cyberdeck")
    .version(CYBERDECK_VERSION)
    .description("Neutral broker for durable Claude and Codex terminal sessions")
    .addHelpText(
      "after",
      "\nTop-level Fable starts require an explicit human command; delegated Fable is refused before launch.\n",
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

  program.command("logs")
    .argument("<id>", "session UUID")
    .action(async (sessionId: string) => {
      const snapshot = await withClient((client) => client.request<{ data: string }>("session.snapshot", { sessionId }));
      process.stdout.write(Buffer.from(snapshot.data, "base64"));
    });

  program.command("attach")
    .argument("<id>", "session UUID")
    .action((sessionId: string) => runAttachment(sessionId, "control"));

  program.command("watch")
    .argument("<id>", "session UUID")
    .action((sessionId: string) => runAttachment(sessionId, "watch"));

  program.command("mcp")
    .description("serve capability-scoped Cyberdeck tools over stdio MCP")
    .requiredOption("--actor-session <id>", "bound orchestrator session UUID")
    .action(async (options: { actorSession: string }) => {
      const client = await RpcClient.connect(brokerSocketPath);
      try {
        await runMcpServer(client, options.actorSession);
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
    .option("--orchestrator <provider>", "explicit orchestrator provider", (value: string) => {
      if (value !== "codex" && value !== "claude") throw new Error("orchestrator provider must be codex or claude");
      return value;
    })
    .option("--model <model>", "explicit orchestrator model")
    .addOption(new Option("--effort <effort>", "explicit orchestrator reasoning effort")
      .choices(["low", "medium", "high", "xhigh", "max", "ultra"]))
    .addOption(new Option("--scope <scope>").choices(["workspace", "fleet"]).default("workspace"))
    .action(async (options: { orchestrator?: "codex" | "claude"; model?: string; effort?: ReasoningEffort; scope: "workspace" | "fleet" }) => {
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
    .description("invalidate an inactive workspace or fleet orchestrator binding")
    .option("--cwd <absolute-path>", "workspace path (defaults to the current directory)")
    .addOption(new Option("--scope <scope>").choices(["workspace", "fleet"]).default("workspace"))
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
