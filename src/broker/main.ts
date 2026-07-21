import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PhaseOneConfigSchema } from "../config.js";
import { JobControlPlane } from "../control-plane/job-control-plane.js";
import { defaultProviderRegistry } from "../control-plane/provider-registry.js";
import type { BrokerEvent } from "../domain/events.js";
import { appStateDirectory, brokerSocketPath } from "../paths.js";
import { JobStore } from "../persistence/job-store.js";
import { ClaudeProviderAdapter } from "../providers/claude.js";
import { CodexProviderAdapter } from "../providers/codex.js";
import { PtyProcess } from "../runtime/pty-process.js";
import { Journal } from "./journal.js";
import { BrokerServer } from "./server.js";
import { SessionRegistry } from "./session-registry.js";

function brokerEvent(type: "broker.started" | "broker.shutdown", data: Record<string, unknown>): BrokerEvent {
  return {
    id: randomUUID(),
    type,
    occurredAt: new Date().toISOString(),
    data,
  };
}

export async function runBroker(
  socketPath = brokerSocketPath,
  stateDirectory = appStateDirectory,
): Promise<BrokerServer> {
  const journal = new Journal(stateDirectory);
  const registry = new SessionRegistry({
    adapters: {
      codex: new CodexProviderAdapter(),
      claude: new ClaudeProviderAdapter(),
    },
    ptyFactory: (spec, replayBytes) => new PtyProcess(spec, replayBytes),
    journal,
    config: PhaseOneConfigSchema.parse({}),
  });

  // The control plane owns durable job state. Provider dispatch adapters (Agent B, B2+) register
  // themselves at runtime; until then job.* methods respond but a submit settles as DISPATCH_REJECTED
  // for lack of an adapter.
  const controlPlane = new JobControlPlane({
    registry: defaultProviderRegistry(),
    journal,
    store: new JobStore(stateDirectory),
  });
  await controlPlane.recover();

  let shuttingDown = false;
  let server: BrokerServer;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    await controlPlane.whenIdle();
    await registry.stopAll();
    await journal.append(brokerEvent("broker.shutdown", { reason, pid: process.pid }));
    await server.close();
  };

  server = new BrokerServer({
    socketPath,
    registry,
    controlPlane,
    onShutdown: () => { void shutdown("request"); },
  });
  await server.listen();
  await journal.append(brokerEvent("broker.started", { socketPath, pid: process.pid }));

  process.once("SIGINT", () => { void shutdown("SIGINT"); });
  process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
  return server;
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  await runBroker().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
