import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { WorkerGateway } from "../../src/broker/worker-gateway.js";

const gateways: WorkerGateway[] = [];
afterEach(async () => { for (const gateway of gateways.splice(0)) await gateway.close(); });
it("authenticates report-only traffic, binds worker and generation, and revokes tokens", async () => {
  const binding = { workerId: randomUUID(), executionId: randomUUID(), generation: 1 };
  let active = true;
  const submit = vi.fn(async () => ({ code: "accepted" as const, eventId: "test" }));
  const gateway = new WorkerGateway({ submit }, () => active); gateways.push(gateway);
  const port = await gateway.listen(), token = gateway.issue(binding);
  const report = { workerId: binding.workerId, eventId: "test", kind: "PROGRESS", summary: "fixture" };
  const send = (body: unknown, bearer = token, path = "/v1/report") => fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` }, body: JSON.stringify(body),
  });
  expect((await send(report, "wrong")).status).toBe(401);
  expect((await send(report, token, "/operator/handoff")).status).toBe(404);
  expect((await send({ ...report, workerId: randomUUID() })).status).toBe(403);
  expect((await send({ ...report, method: "session.stop" })).status).toBe(400);
  expect((await send(report)).status).toBe(200);
  expect(submit).toHaveBeenCalledTimes(1);
  active = false;
  const ready = () => fetch(`http://127.0.0.1:${port}/v1/ready`, { headers: { authorization: `Bearer ${token}` } });
  expect((await ready()).status).toBe(409);
  expect((await send(report)).status).toBe(401);
  active = true; expect((await ready()).status).toBe(200); gateway.revoke(binding.executionId);
  expect((await send(report)).status).toBe(401);
  expect(submit).toHaveBeenCalledTimes(1);
});
it("binds fixed profile requests to authenticated execution and refuses injected authority/commands", async () => {
  const binding = { workerId: randomUUID(), executionId: randomUUID(), generation: 2 };
  let active = true;
  const profile = vi.fn(async () => ({ state: "waiting-capacity" }));
  const gateway = new WorkerGateway({ submit: vi.fn() }, () => active, profile); gateways.push(gateway);
  const port = await gateway.listen(), token = gateway.issue(binding);
  const input = { requestId: randomUUID(), attemptId: randomUUID(), profile: "integration", recipeId: "postgres-fixture-v1" };
  const send = (body: unknown, bearer = token) => fetch(`http://127.0.0.1:${port}/v1/profile`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` }, body: JSON.stringify(body),
  });
  for (const injected of [{ workerId: randomUUID() }, { generation: 99 }, { command: "sh" }, { image: "host" }, { mounts: ["/"] }])
    expect((await send({ ...input, ...injected })).status).toBe(400);
  expect((await send(input, "0".repeat(64))).status).toBe(401);
  expect((await send(input)).status).toBe(200);
  expect(profile).toHaveBeenCalledWith(binding, input);
  active = false; expect((await send(input)).status).toBe(401);
  expect(profile).toHaveBeenCalledTimes(1);
});
