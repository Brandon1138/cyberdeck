import { expect, it } from "vitest";
import { TelemetryBudget } from "../../src/observability/telemetry-budget.js";
import { BoundedExportQueue } from "../../src/observability/bounded-export-queue.js";
it("distinguishes sampling, cap and duplicate exclusion", () => {
  const sampled = new TelemetryBudget(10, 0); sampled.admit("a", "event");
  expect(sampled.health()).toMatchObject({ sampledOut: 1, capped: 0, used: 0 });
  const capped = new TelemetryBudget(1, 1); capped.admit("a", "one"); capped.admit("a", "one"); capped.admit("a", "two");
  expect(capped.health()).toMatchObject({ sampledOut: 0, duplicates: 1, capped: 1, used: 1 });
});
it("does not infer remote success from an empty queue after permanent rejection", async () => {
  const queue = new BoundedExportQueue(async () => ({ status: 403 }));
  queue.enqueue("sanitized"); await new Promise(r => setTimeout(r, 0));
  expect(queue.health().queued).toBe(0);
  expect(queue.transportHealth()).toMatchObject({ accepted: 0, transportFailed: 1, lastFailure: "rejected" });
  queue.close();
});
it("keeps exporter outage and queue overflow separately visible", async () => {
  const queue = new BoundedExportQueue(async () => ({ status: 429 }));
  for (let i = 0; i < 101; i++) queue.enqueue("sanitized");
  await new Promise(r => setTimeout(r, 0));
  expect(queue.transportHealth()).toMatchObject({ queueDropped: 1, transportFailed: 1, accepted: 0, lastFailure: "rate-limited" });
  queue.close();
});
