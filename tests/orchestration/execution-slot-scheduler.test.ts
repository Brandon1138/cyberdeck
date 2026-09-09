import { expect, it } from "vitest";
import { ExecutionSlotScheduler } from "../../src/orchestration/execution-slot-scheduler.js";
it("queues five workers FIFO under two physical slots and releases exactly once", async () => {
  const scheduler = new ExecutionSlotScheduler(2);
  const first = await scheduler.reserve("a"), second = await scheduler.reserve("b");
  const third = scheduler.reserve("c"), fourth = scheduler.reserve("d"), fifth = scheduler.reserve("e");
  expect(scheduler.snapshot()).toEqual({ running: ["a", "b"], queued: ["c", "d", "e"], capacity: 2 });
  const cancelled = expect(fourth).rejects.toThrow("EXECUTION_QUEUE_CANCELLED"); scheduler.cancel("d"); await cancelled;
  first(); first(); const releaseThird = await third;
  expect(scheduler.snapshot().running).toEqual(["b", "c"]);
  second(); const releaseFifth = await fifth;
  releaseThird(); releaseFifth(); expect(scheduler.snapshot().running).toEqual([]);
});
it("reconstructs occupancy before admitting replacements", async () => {
  const scheduler = new ExecutionSlotScheduler(1); scheduler.recover(["old"]);
  const queued = scheduler.reserve("new"); expect(scheduler.snapshot().queued).toEqual(["new"]);
  scheduler.release("old"); const release = await queued; release();
  expect(() => new ExecutionSlotScheduler(0)).toThrow("EXECUTION_CAPACITY_INVALID");
});
