#!/usr/bin/env node

import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Command, Option } from "commander";
import { runBroker } from "./broker/main.js";
import type { SessionRecord } from "./domain/session.js";
import { appStateDirectory, brokerSocketPath } from "./paths.js";
import { RpcClient, RpcError } from "./client/rpc-client.js";
import { CYBERDECK_VERSION } from "./version.js";

interface StartOptions {
  provider: "codex" | "claude";
  cwd: string;
  model?: string;
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
    .choices(["claude", "codex"])
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

async function startDetachedBroker(): Promise<void> {
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
  process.stdout.write(`Cyberdeck broker is running at ${brokerSocketPath}\n`);
}

function sessionRequest(options: StartOptions, parentSessionId?: string) {
  return {
    provider: options.provider,
    cwd: options.cwd,
    detached: parentSessionId !== undefined || options.attach !== true,
    sandbox: options.sandbox,
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.role === undefined ? {} : { role: options.role }),
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(parentSessionId === undefined ? {} : { parentSessionId }),
  };
}

export function createProgram(): Command {
  const program = new Command()
    .name("cyberdeck")
    .version(CYBERDECK_VERSION)
    .description("Neutral broker for durable Claude and Codex terminal sessions")
    .addHelpText(
      "after",
      "\nTop-level Fable starts require an explicit human command; delegated Fable is refused before launch.\n",
    );

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

  addSessionOptions(program.command("start").description("start a durable top-level session"), true)
    .action(async (options: StartOptions) => {
      const record = await withClient((client) => client.request<SessionRecord>("session.start", sessionRequest(options)));
      process.stdout.write(`${record.id}\n`);
      if (options.attach === true) {
        process.stdout.write(`Session started for control attachment; run cyberdeck attach ${record.id}\n`);
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
      await withClient((client) => client.request("session.send", {
        sessionId,
        data: Buffer.from(`${message}\n`).toString("base64"),
      }));
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

  return program;
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  await createProgram().parseAsync().catch((error) => {
    const prefix = error instanceof RpcError ? `${error.code}: ` : "";
    process.stderr.write(`${prefix}${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
