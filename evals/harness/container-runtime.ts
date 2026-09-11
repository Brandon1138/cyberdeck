import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BrokerRuntimeConfigSchema, type BrokerRuntimeConfig } from "../../src/config.js";
import type { SessionRecord } from "../../src/domain/session.js";
import type { ProviderAdapter } from "../../src/orchestration/session/provider-ports.js";
import type { WorkerEventChannel } from "../../src/broker/worker-event-channel.js";
import type { AgentActivityPort } from "../../src/orchestration/agent-activity-port.js";
import { brokerExecutionRuntime } from "../../src/runtime/execution/broker-execution-runtime.js";
import { OrbStackClient } from "../../src/runtime/execution/orbstack-client.js";
import { ClaudeProviderAdapter } from "../../src/providers/claude.js";
import { CodexProviderAdapter } from "../../src/providers/codex.js";
import type { LiveEvalConfig } from "./live-config.js";

/** The worker image an evaluation launches. A digest from the environment wins; otherwise the
 * pinned tag is resolved on the actual daemon, so evidence always carries the digest that ran. */
export const EVAL_IMAGE_TAG = "cyberdeck-worker:20260905";
export const EVAL_ENDPOINT = `unix://${process.env.HOME}/.orbstack/run/docker.sock`;
export async function resolveEvalImage(client = new OrbStackClient(EVAL_ENDPOINT)): Promise<string> {
  const configured = process.env.CYBERDECK_EVAL_IMAGE;
  if (configured !== undefined) { if (!/^sha256:[a-f0-9]{64}$/.test(configured)) throw new Error("EVAL_IMAGE_DIGEST_INVALID"); return configured; }
  return (await client.command(["image", "inspect", EVAL_IMAGE_TAG, "--format", "{{.Id}}"])).trim();
}
export interface ContainerRuntimeFixture {
  executions: Awaited<ReturnType<typeof brokerExecutionRuntime>>["executions"];
  runtime: Awaited<ReturnType<typeof brokerExecutionRuntime>>;
  adapters: Record<string, ProviderAdapter>;
  provider: string; image: string; client: OrbStackClient; config: BrokerRuntimeConfig;
  bind(lookup: (id: string) => SessionRecord | undefined, submit: WorkerEventChannel["submit"]): void;
  stageGuest(record: SessionRecord): Promise<void>;
  close(): Promise<void>;
}
/**
 * Production execution composition (`brokerExecutionRuntime`) against the real OrbStack daemon:
 * real gateway, private clone provisioning with selected inputs, staged credentials, slot
 * scheduler and reconciliation. The guest is either the scripted fixture (no model, no cost)
 * or, under an explicit live configuration, the real provider CLI with its model.
 */
export async function containerRuntime(root: string, guest: { kind: "scripted"; provider?: "claude" | "codex" } | { kind: "provider"; live: LiveEvalConfig }, activity?: AgentActivityPort,
  allowsWorkspaceTrust?: (source: string) => Promise<boolean>,
): Promise<ContainerRuntimeFixture> {
  const state = join(root, "broker"); await mkdir(state, { recursive: true, mode: 0o700 });
  const client = new OrbStackClient(EVAL_ENDPOINT), image = guest.kind === "provider" ? guest.live.image ?? await resolveEvalImage(client) : await resolveEvalImage(client);
  const provider = guest.kind === "provider" ? guest.live.provider : guest.provider ?? "claude";
  let credentialFile: string | undefined;
  if (guest.kind === "scripted") {
    // The scripted guest is `node`; the launcher never reads a provider credential for it, but
    // context preparation requires one to exist. This placeholder is never a real key.
    credentialFile = join(root, "scripted-credential"); await writeFile(credentialFile, "scripted-fixture-no-key\n", { mode: 0o600 });
  } else credentialFile = guest.live.credentialFile;
  const config = BrokerRuntimeConfigSchema.parse({ containerRuntime: { endpoint: EVAL_ENDPOINT, image, cpus: guest.kind === "provider" ? guest.live.cpus : 1,
    memoryBytes: guest.kind === "provider" ? guest.live.memoryBytes : 256 * 1024 ** 2, slots: 2, network: "egress", attemptTimeoutMinutes: guest.kind === "provider" ? guest.live.attemptTimeoutMinutes : 60,
    codexWorkspaceIsolation: guest.kind === "provider" ? guest.live.codexWorkspaceIsolation : "native",
    credentialFiles: credentialFile ? { [provider]: credentialFile } : {},
    authentication: guest.kind === "provider" && guest.live.authentication ? { [provider]: guest.live.authentication } : {} } });
  let lookup: (id: string) => SessionRecord | undefined = () => undefined, submit: WorkerEventChannel["submit"] = async () => { throw new Error("EVAL_EVENTS_UNBOUND"); };
  const hostAdapters: Record<string, ProviderAdapter> = { claude: new ClaudeProviderAdapter({ sourceEnvironment: {}, mcp: { nodePath: process.execPath, cliPath: "/nonexistent" }, stateDirectory: state }),
    codex: new CodexProviderAdapter({ sourceEnvironment: {}, mcp: { nodePath: process.execPath, cliPath: "/nonexistent" } }) };
  const runtime = await brokerExecutionRuntime({ stateDirectory: state, config, adapters: hostAdapters, lookupSession: (id) => lookup(id), submitEvent: (input) => submit(input),
    ...(activity ? { activity } : {}), ...(allowsWorkspaceTrust ? { allowsWorkspaceTrust } : {}) });
  if (!runtime.health().reachable) { await runtime.close(); throw new Error("EVAL_ORBSTACK_UNREACHABLE"); }
  const script = await readFile(fileURLToPath(new URL("./scripted-provider.mjs", import.meta.url)), "utf8");
  const scripted: ProviderAdapter = { id: provider,
    buildLaunchSpec: (session) => session.kind === "orchestrator"
      ? { executable: process.execPath, args: [fileURLToPath(new URL("./scripted-provider.mjs", import.meta.url))], cwd: session.cwd, env: {}, transport: "pty" }
      : { executable: "node", args: ["/home/worker/scripted-provider.mjs", session.id], cwd: "/workspace", env: {}, transport: "pty" },
    buildResumeSpec: (session) => ({ executable: "node", args: ["/home/worker/scripted-provider.mjs", session.id], cwd: "/workspace", env: {}, transport: "pty" }) };
  return { executions: runtime.executions, runtime, adapters: guest.kind === "scripted" ? { [provider]: scripted } : runtime.adapters, provider, image, client, config,
    bind: (nextLookup, nextSubmit) => { lookup = nextLookup; submit = nextSubmit; },
    // The guest script lives in the worker's private provider home, never in the workspace under review.
    stageGuest: async (record) => {
      if (guest.kind !== "scripted") return;
      const home = join(state, "containers", "provider-state", record.id); await mkdir(home, { recursive: true, mode: 0o700 });
      await writeFile(join(home, "scripted-provider.mjs"), script, { mode: 0o600 }); await writeFile(join(home, "marker"), record.id, { mode: 0o600 });
    },
    close: () => runtime.close() };
}
