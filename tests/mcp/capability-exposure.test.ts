import { expect, it, vi } from "vitest";
import { handleMcpRequest, type McpServerContext } from "../../src/mcp/server.js";
import { WorkflowRunSchema, type WorkflowMessage } from "../../src/domain/workflow.js";
import { WorkflowService, SendWorkflowMessageParamsSchema } from "../../src/orchestration/workflow-service.js";

const actorSessionId = "11111111-1111-4111-8111-111111111111";
const ownerSessionId = "22222222-2222-4222-8222-222222222222";
// Every catalog entry has an explicit expected policy. New tools must choose a policy here.
const workerAllowlist = [
  "cyberdeck_diagnose", "cyberdeck_provider_capabilities", "cyberdeck_report_progress",
  "cyberdeck_request_decision", "cyberdeck_respond_checkpoint", "cyberdeck_signal_exception", "cyberdeck_signal_risk",
  "cyberdeck_workflow_status", "cyberdeck_workflow_changes", "cyberdeck_workflow_send",
];
const universalOnly = [
  "cyberdeck_orchestrator_inspect", "cyberdeck_orchestrator_stop", "cyberdeck_orchestrator_create", "cyberdeck_orchestrator_force_stop",
  "cyberdeck_threads_list", "cyberdeck_thread_read", "cyberdeck_scout_read", "cyberdeck_worker_start", "cyberdeck_workers_start",
  "cyberdeck_workers_wait", "cyberdeck_thread_message", "cyberdeck_lease", "cyberdeck_worker_ctl", "cyberdeck_worker_events",
  "cyberdeck_workflow_create", "cyberdeck_workflow_cancel",
];
const universal = [...workerAllowlist, ...universalOnly].sort();
async function names(context: McpServerContext): Promise<string[]> {
  const response = await handleMcpRequest(context, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  return (response!.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name).sort();
}
const identity = { actorSessionId };

it.each([
  { status: "bound", sessionKind: "orchestrator", capabilities: [] },
  { status: "bound", sessionKind: "orchestrator", capabilities: ["worker.start"] },
  { status: "bound", sessionKind: "orchestrator", capabilities: ["thread.enqueue"] },
  { status: "bound", capabilities: ["thread.read"] },
  { status: "unbound", sessionKind: "orchestrator" },
  { status: "unbound" },
  { status: "unknown" },
])("retains the universal catalog for $status actors with $capabilities", async (actor) => {
  expect(await names({ identity, transport: { request: (async () => actor) as never } })).toEqual(universal);
});

it.each(["unavailable", "METHOD_NOT_FOUND", "BROKER_DISCONNECTED"])("retains the universal catalog on an %s broker", async (code) => {
  const transport = code === "unavailable" ? undefined : { request: (async () => { throw Object.assign(new Error(code), { code }); }) as never };
  expect(await names({ identity, ...(transport === undefined ? {} : { transport }) })).toEqual(universal);
});

it("uses the explicit worker allowlist and accounts for every universal catalog entry", async () => {
  const worker = await names({ identity, transport: { request: (async () => ({ status: "unbound", sessionKind: "worker" })) as never } });
  expect(worker).toEqual([...workerAllowlist].sort());
  const catalog = await names({ identity });
  expect(new Set([...workerAllowlist, ...universalOnly]).size).toBe(universal.length);
  expect(catalog).toEqual(universal);
  for (const name of catalog) expect(workerAllowlist.includes(name) !== universalOnly.includes(name)).toBe(true);
});

it("keeps a once-cached Orc catalog usable across grant expansion with tools: {}", async () => {
  let capabilities: string[] = [];
  const request = vi.fn(async (method: string) => {
    if (method === "agent.actor.describe") return { status: "bound", sessionKind: "orchestrator", capabilities };
    if (method === "agent.orchestrator.create" && capabilities.includes("orchestrator.create")) return { created: true };
    throw Object.assign(new Error("Capability denied"), { code: "CAPABILITY_DENIED" });
  });
  const context = { identity, transport: { request: request as never } };
  const initialized = await handleMcpRequest(context, { jsonrpc: "2.0", id: 1, method: "initialize" });
  expect(initialized!.result).toMatchObject({ capabilities: { tools: {} } });
  const cached = await names(context);
  expect(cached).toEqual(universal);
  const denied = await handleMcpRequest(context, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "cyberdeck_orchestrator_create", arguments: {} } });
  expect(denied!.result).toMatchObject({ isError: true });
  capabilities = ["orchestrator.create"];
  expect(cached).toContain("cyberdeck_orchestrator_create");
  const allowed = await handleMcpRequest(context, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "cyberdeck_orchestrator_create", arguments: {} } });
  expect(allowed!.result).not.toHaveProperty("isError", true);
  expect(request.mock.calls.filter(([method]) => method === "agent.actor.describe")).toHaveLength(1);
});

it("exposes exactly the workflow operations a non-owner worker participant may call", async () => {
  let run = WorkflowRunSchema.parse({ id: "33333333-3333-4333-8333-333333333333", ownerSessionId,
    participantSessionIds: [ownerSessionId, actorSessionId], name: "participant test", status: "active", limits: {},
    messageCount: 0, turnCount: 0, createdAt: "2026-07-22T12:00:00.000Z", updatedAt: "2026-07-22T12:00:00.000Z" });
  const messages: WorkflowMessage[] = [];
  const service = new WorkflowService({ get: () => { throw new Error("No worker grant required"); } },
    { findBySessionId: async () => undefined }, {
      putRun: async (value) => { run = value; }, getRun: async () => run, listRuns: async () => [run],
      putMessage: async (message) => { messages.push(message); }, listMessages: async () => messages,
    }, { enqueue: vi.fn() });
  const catalog = await names({ identity, transport: { request: (async () => ({ status: "unbound", sessionKind: "worker" })) as never } });
  const authorized = [];
  await expect(service.list(actorSessionId)).resolves.toEqual([run]); authorized.push("cyberdeck_workflow_status");
  await expect(service.changes(actorSessionId, run.id)).resolves.toEqual([]); authorized.push("cyberdeck_workflow_changes");
  await expect(service.send(SendWorkflowMessageParamsSchema.parse({ actorSessionId, runId: run.id, targetSessionId: ownerSessionId, text: "done" }))).resolves.toMatchObject({ fromSessionId: actorSessionId, wake: false });
  authorized.push("cyberdeck_workflow_send");
  await expect(service.cancel(actorSessionId, run.id)).rejects.toMatchObject({ code: "WORKFLOW_OWNER_REQUIRED" });
  await expect(service.create({ actorSessionId, name: "denied", participantSessionIds: [ownerSessionId] })).rejects.toMatchObject({ code: "ACTOR_NOT_AUTHORIZED" });
  await expect(service.cancel(ownerSessionId, run.id)).resolves.toMatchObject({ status: "cancelled" });
  expect(catalog.filter((name) => name.startsWith("cyberdeck_workflow_"))).toEqual(authorized.sort());
});
