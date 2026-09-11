import { mkdtemp, mkdir, realpath, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcClient } from "../src/client/rpc-client.js";
import { brokerSocketPath, appStateDirectory } from "../src/paths.js";
import { loadBrokerRuntimeConfig } from "../src/runtime-config.js";
import type { SessionRecord } from "../src/domain/session.js";
import type { AgentActivity } from "../src/domain/agent-activity.js";
import { correlationIds, projectActivity } from "../src/observability/activity-projection.js";
import { trustedGit } from "../src/runtime/execution/trusted-git.js";
import { ContainerNativeSource } from "../src/runtime/activity/container-native-source.js";
import { successfulCanaryTool } from "./subscription-canary-evidence.js";

/** One normal worker through the active production broker. No config mutation or API fallback. */
const [provider, model, ...options] = process.argv.slice(2);
if (!provider || !["claude", "codex"].includes(provider) || !model) throw new Error("Usage: subscription-canary.ts <claude|codex> <model>");
const state = options.includes("--state") ? options[options.indexOf("--state") + 1]! : appStateDirectory;
const socket = options.includes("--socket") ? options[options.indexOf("--socket") + 1]! : brokerSocketPath;
const writable = options.includes("--writable");
const defaultRouting = options.includes("--default-executor");
const config = loadBrokerRuntimeConfig(join(state, "config.json"));
if (defaultRouting && config.workerExecution?.defaultExecutor !== "orbstack-container") throw new Error("CANARY_REQUIRES_CONTAINER_DEFAULT");
if (writable && (provider !== "codex" || config.containerRuntime?.codexWorkspaceIsolation !== "container")) throw new Error("CANARY_REQUIRES_EXPLICIT_WRITABLE_OPT_IN");
if (config.containerRuntime?.authentication[provider]?.kind !== `${provider}-subscription`) throw new Error("CANARY_REQUIRES_SUBSCRIPTION_AUTH");
const evidence = await mkdtemp(join(tmpdir(), `cyberdeck-${provider}-subscription-canary-`));
const source = join(await realpath(evidence), "source");
await mkdir(source);
await trustedGit(source, ["init", "-b", "main"]);
await trustedGit(source, ["config", "user.name", "Cyberdeck canary"]);
await trustedGit(source, ["config", "user.email", "canary@example.invalid"]);
await writeFile(join(source, "README.md"), "Disposable subscription authentication canary.\n");
if (writable) {
  await mkdir(join(source, "fixture-dependency"));
  await writeFile(join(source, "fixture-dependency", "package.json"), JSON.stringify({ name: "canary-local-dependency", version: "1.0.0", main: "index.js" }));
  await writeFile(join(source, "fixture-dependency", "index.js"), 'module.exports = "LOCAL_DEP_OK";\n');
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "writable-canary", version: "1.0.0", private: true }));
}
await trustedGit(source, ["add", "."]);
await trustedGit(source, ["commit", "-m", "Canary baseline"]);
// Explicitly trust only this script-created clean fixture, through the existing repository grant.
if (options.includes("--trust-fixture")) {
  const { ModalAnswerGrantStore } = await import("../src/persistence/modal-answer-grant-store.js");
  await new ModalAnswerGrantStore(state).set(source, true);
}
const client = await RpcClient.connect(socket);
let worker: SessionRecord | undefined;
let events: AgentActivity[] = [];
let passed = false;
console.log(JSON.stringify({ evidence, provider, model, billing: "subscription" }));
try {
  worker = await client.request<SessionRecord>("session.startWithPrompt", {
    provider, model, ...(defaultRouting ? {} : { executor: "orbstack-container" }), cwd: source, sandbox: provider === "codex" && !writable ? "read-only" : "workspace-write", detached: true,
    name: `${provider} subscription canary`,
    initialPrompt: (writable ? "This is an authorized writable subscription canary in a disposable workspace. Create answer.txt containing exactly WRITABLE_SUBSCRIPTION_OK followed by a newline. Install the local dependency with npm install --offline --ignore-scripts --no-audit --no-fund ./fixture-dependency. Verify with node that require('canary-local-dependency') equals LOCAL_DEP_OK and that answer.txt has the required content. These routine operations are permitted; do not ask for approval. Do not delegate or contact other services. After all steps succeed, " : "This is a subscription authentication and observability canary. Do not inspect or change files, use network tools, or delegate work. ")
      + "Use your terminal tool to run exactly: printf 'SUBSCRIPTION_CANARY_OK\\n'. For the Codex JavaScript wrapper use exactly: const result = await tools.exec_command({cmd: \"printf 'SUBSCRIPTION_CANARY_OK\\\\n'\", yield_time_ms: 10000}); text(JSON.stringify(result)); Do not print only result.output: the acceptance checker requires the numeric exit_code from the returned object. Only if all commands succeed, reply with exactly SUBSCRIPTION_CANARY_OK; otherwise report the failure.",
  });
  if (worker.executor !== "orbstack-container" || !worker.execution) throw new Error("CANARY_CONTAINER_ROUTING_FAILED");
  console.log(JSON.stringify({ sessionId: worker.id, executionId: worker.execution?.executionId }));
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    events = (await client.request<{ events: AgentActivity[] }>("activity.readSession", { sessionId: worker.id, limit: 1000 })).events;
    passed = events.some((event) => event.kind === "provider.turn" && event.outcome === "succeeded" && event.origin === "initial-prompt")
      && events.some((event) => event.kind === "tool.result" && event.provenance === "provider-native");
    if (passed) {
      const source = await new ContainerNativeSource(join(state, "containers")).resolve(worker);
      const frames = (await readFile(source.path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      passed = successfulCanaryTool(provider, frames);
      if (!passed) throw new Error("CANARY_TOOL_DID_NOT_SUCCEED");
      if (writable) {
        const sessions = await client.request<SessionRecord[]>("session.list", {});
        const cwd = sessions.find(session => session.id === worker!.id)!.cwd;
        if (await readFile(join(cwd, "answer.txt"), "utf8") !== "WRITABLE_SUBSCRIPTION_OK\n"
          || JSON.parse(await readFile(join(cwd, "node_modules", "canary-local-dependency", "package.json"), "utf8")).name !== "canary-local-dependency") throw new Error("CANARY_WRITABLE_ARTIFACTS_INVALID");
        await readFile(join(cwd, "package-lock.json"), "utf8");
      }
      break;
    }
    const sessions = await client.request<SessionRecord[]>("session.list", {});
    const current = sessions.find((session) => session.id === worker!.id);
    if (current?.exitCode !== null && current?.exitCode !== undefined) throw new Error("CANARY_WORKER_EXITED");
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!passed) throw new Error("CANARY_NATIVE_COMPLETION_TIMEOUT");
} catch (error) {
  passed = false;
  throw error;
} finally {
  if (worker) {
    const snapshot = await client.request<{ data: string }>("session.snapshot", { sessionId: worker.id }).catch(() => undefined);
    if (snapshot) await writeFile(join(evidence, "terminal.txt"), Buffer.from(snapshot.data, "base64"), { mode: 0o600 });
    await client.request("session.stopOne", { sessionId: worker.id });
    events = (await client.request<{ events: AgentActivity[] }>("activity.readSession", { sessionId: worker.id, limit: 1000 })).events;
    const sessions = await client.request<SessionRecord[]>("session.list", {});
    const current = sessions.find((session) => session.id === worker!.id);
    await writeFile(join(evidence, "canary.json"), JSON.stringify({ passed, provider, model, routing: defaultRouting ? "broker-default" : "explicit-container", billing: "subscription", session: current,
      events, correlations: events.map((event) => ({ eventId: event.eventId, kind: event.kind, ...correlationIds(projectActivity(event)) })),
      telemetry: await client.request("telemetry.health", {}),
    }, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ passed, evidence, sessionId: worker.id, eventCount: events.length }));
  }
  client.close();
}
