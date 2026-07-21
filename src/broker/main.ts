import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BrokerRuntimeConfigSchema } from "../config.js";
import { ControlPlaneRuntime } from "../control-plane/runtime.js";
import type { WorktreeLeaseManager } from "../control-plane/worktree-lease-manager.js";
import type { ArtifactStore } from "../persistence/artifact-store.js";
import { AppServerJobDispatchAdapter } from "../app-server/dispatch-adapter.js";
import type { JobDispatchAdapter } from "../domain/dispatch.js";
import type { BrokerEvent } from "../domain/events.js";
import { appStateDirectory, brokerSocketPath } from "../paths.js";
import { AntigravityJobDispatchAdapter } from "../providers/antigravity/dispatch-adapter.js";
import { ClaudeProviderAdapter } from "../providers/claude.js";
import { ClaudeJobDispatchAdapter } from "../providers/claude/dispatch-adapter.js";
import { CodexProviderAdapter } from "../providers/codex.js";
import { CursorJobDispatchAdapter } from "../providers/cursor/dispatch-adapter.js";
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

/**
 * The neutral backend composition for the job plane: one dispatch adapter per canonical provider id,
 * each selected only when a request names it explicitly. Registration order carries no ranking,
 * priority, or preference, and nothing here routes, substitutes, or falls back between providers.
 * The Agent B adapter implementations are consumed as-is through the frozen dispatch port.
 */
export function composeJobDispatchAdapters(context: {
  leases: WorktreeLeaseManager;
  artifacts: ArtifactStore;
}): JobDispatchAdapter[] {
  return [
    new AppServerJobDispatchAdapter({
      leaseManager: context.leases,
      artifactStore: context.artifacts,
    }),
    new ClaudeJobDispatchAdapter(),
    new CursorJobDispatchAdapter(),
    new AntigravityJobDispatchAdapter(),
  ];
}

export async function runBroker(
  socketPath = brokerSocketPath,
  stateDirectory = appStateDirectory,
): Promise<BrokerServer> {
  const journal = new Journal(stateDirectory);
  const config = BrokerRuntimeConfigSchema.parse({});
  const registry = new SessionRegistry({
    adapters: {
      codex: new CodexProviderAdapter(),
      claude: new ClaudeProviderAdapter(),
    },
    ptyFactory: (spec, replayBytes) => new PtyProcess(spec, replayBytes),
    journal,
    config,
  });

  // The control plane owns durable job state, admission, budgets, leases, and reconciliation. Its
  // runtime enforces the ordering: persistence, then recovery, then reconciliation, and only then is
  // admission opened. The B-owned dispatch adapters are composed in without being modified.
  const runtime = new ControlPlaneRuntime({
    stateDirectory,
    config,
    journal,
    adapters: composeJobDispatchAdapters,
  });
  await runtime.start();

  let shuttingDown = false;
  let server: BrokerServer;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Admission stops first, then in-flight jobs drain and persist, then live sessions stop.
    await runtime.shutdown(reason);
    await registry.stopAll();
    await journal.append(brokerEvent("broker.shutdown", { reason, pid: process.pid }));
    await server.close();
  };

  server = new BrokerServer({
    socketPath,
    registry,
    controlPlane: runtime.controlPlane,
    controlPlaneRuntime: runtime,
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
