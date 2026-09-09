import { afterEach, expect, it, vi } from "vitest";
import { BoundedExportQueue } from "../../src/observability/bounded-export-queue.js";
afterEach(() => { vi.useRealTimers(); });

it.each([429, 503, "offline"])("retries %s and drains batches without new activity", async (failure) => {
  vi.useFakeTimers();
  let failing = true;
  const send = vi.fn(async (_body: string) => {
    if (failing && failure === "offline") throw new Error("offline");
    return { status: failing ? Number(failure) : 200 };
  });
  const queue = new BoundedExportQueue(send);
  try {
    for (let i = 0; i < 25; i++) queue.enqueue(`envelope:${i}`);
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(queue.health().queued).toBe(25);
    failing = false;
    await vi.advanceTimersByTimeAsync(59_999);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3);
    expect(send).toHaveBeenCalledTimes(26);
    expect(send.mock.calls.slice(1).map(([body]) => body)).toEqual(Array.from({ length: 25 }, (_, i) => `envelope:${i}`));
    expect(queue.health()).toEqual({ queued: 0, dropped: 0 });
  } finally { queue.close(); }
});

it("bounds hung transport, queue size and shutdown retries", async () => {
  vi.useFakeTimers();
  const send = vi.fn(() => new Promise<{ status: number }>(() => {}));
  const queue = new BoundedExportQueue(send);
  for (let i = 0; i < 125; i++) queue.enqueue(`envelope:${i}`);
  await vi.advanceTimersByTimeAsync(62_000);
  expect(send).toHaveBeenCalledTimes(2);
  expect(queue.health()).toEqual({ queued: 100, dropped: 25 });
  queue.close();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(send).toHaveBeenCalledTimes(2);
});

it("drops permanent refusals and continues with the next envelope", async () => {
  vi.useFakeTimers();
  const send = vi.fn().mockResolvedValueOnce({ status: 400 }).mockResolvedValue({ status: 200 });
  const queue = new BoundedExportQueue(send);
  try {
    queue.enqueue("refused"); queue.enqueue("accepted");
    await vi.advanceTimersByTimeAsync(0);
    expect(queue.health()).toEqual({ queued: 0, dropped: 1 });
    expect(send).toHaveBeenCalledTimes(2);
  } finally { queue.close(); }
});
