import { afterEach, describe, expect, it } from "vitest";
import { agentMethods } from "../../src/broker/server/agent-methods.js";
import type { BrokerMethodContext } from "../../src/broker/server/method-context.js";
import type { ConnectionContext } from "../../src/broker/server/options.js";
import type { OrchestratorAttention } from "../../src/domain/orchestrator-attention.js";
import { ACTOR, OTHER, attentionHarness, cleanupAttentionHarnesses } from "../support/attention-harness.js";

afterEach(cleanupAttentionHarnesses);

describe("attention broker methods", () => {
  it("routes authorized arm, non-consuming read, explicit receipt ack and epoch cancellation", async () => {
    const f = await attentionHarness(); await f.complete("BROKER-RESULT");
    const server = { options: { attention: f.attention, notifications: f.notifications } } as unknown as BrokerMethodContext;
    const invoke = (method: string, params: unknown) => agentMethods[method]!(server, {} as ConnectionContext,
      { type: "request", id: 1, method, params });
    const armed = await invoke("agent.attention.arm", f.request()) as OrchestratorAttention;
    const page = await invoke("agent.notifications.read", { actorSessionId: ACTOR, attentionEpoch: armed.epoch }) as
      Awaited<ReturnType<typeof f.notifications.read>>;
    expect(page.attention!.workers[0]!.completion!.text).toBe("BROKER-RESULT");
    expect((await f.store.get(armed.controllerId))!.coverage.consumed).toEqual([]);
    await invoke("agent.notifications.read", { actorSessionId: ACTOR, attentionEpoch: armed.epoch, attentionReceiptId: page.attention!.receiptId });
    expect((await f.store.get(armed.controllerId))!.coverage.consumed[0]!.completionTurn).toBe(1);
    expect(await invoke("agent.attention.cancel", { actorSessionId: ACTOR, epoch: armed.epoch })).toMatchObject({ status: "cancelled" });
    await expect(invoke("agent.attention.arm", f.request({ actorSessionId: OTHER }))).rejects.toMatchObject({ code: "ACTOR_NOT_AUTHORIZED" });
  });

  it("refuses unavailable attention and malformed arm requests before writing state", async () => {
    const f = await attentionHarness(); const context = {} as ConnectionContext;
    const empty = { options: {} } as BrokerMethodContext;
    await expect(agentMethods["agent.attention.arm"]!(empty, context, { type: "request", id: 1, method: "agent.attention.arm", params: f.request() }))
      .rejects.toMatchObject({ code: "METHOD_NOT_FOUND" });
    const server = { options: { attention: f.attention } } as unknown as BrokerMethodContext;
    await expect(agentMethods["agent.attention.arm"]!(server, context,
      { type: "request", id: 1, method: "agent.attention.arm", params: f.request({ targets: [] }) })).rejects.toThrow();
    expect(await f.store.list()).toEqual([]);
  });
});
