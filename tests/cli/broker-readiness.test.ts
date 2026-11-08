import { afterEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("../../src/client/rpc-client.js", () => ({ RpcClient: { connect: fixture.connect } }));
import { waitForBroker } from "../../src/cli/broker-process.js";

afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

it("explains that a readiness timeout can leave a starting broker alive", async () => {
  vi.useFakeTimers();
  fixture.connect.mockRejectedValue(new Error("connect ENOENT /test/broker.sock"));
  const result = expect(waitForBroker(100, () => false)).rejects.toThrow(
    "Broker readiness timed out after 100ms. The broker may still be starting; run `cyberdeck broker status` before retrying. Last connection error: connect ENOENT /test/broker.sock",
  );
  await vi.advanceTimersByTimeAsync(100);
  await result;
});

it("fails promptly when the child exits rather than calling it a timeout", async () => {
  fixture.connect.mockRejectedValue(new Error("connect ENOENT /test/broker.sock"));
  await expect(waitForBroker(90_000, () => true)).rejects.toThrow("Broker exited during startup");
  expect(fixture.connect).toHaveBeenCalledTimes(1);
});

it("waits for a recovering broker and closes the successful probe", async () => {
  vi.useFakeTimers();
  const client = { request: vi.fn().mockResolvedValue({ healthy: true }), close: vi.fn() };
  fixture.connect.mockRejectedValueOnce(new Error("connect ENOENT /test/broker.sock")).mockResolvedValue(client);
  const result = waitForBroker(100);
  await vi.advanceTimersByTimeAsync(50);
  await result;
  expect(client.request).toHaveBeenCalledWith("broker.status", {});
  expect(client.close).toHaveBeenCalledOnce();
});
