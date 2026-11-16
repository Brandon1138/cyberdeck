import { afterEach, expect, it, vi } from "vitest";
import { composeStrigoiRuntime } from "../../src/broker/strigoi-runtime.js";
import { StrigoiLifecycle } from "../../src/orchestration/strigoi-lifecycle.js";

function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function tick() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
afterEach(() => vi.restoreAllMocks());
async function fixture() {
  let update!: () => void;
  const flush = vi.fn(async () => {}), report = vi.fn();
  vi.spyOn(StrigoiLifecycle.prototype, "quiesce").mockResolvedValue();
  const reconcile = vi.spyOn(StrigoiLifecycle.prototype, "reconcile").mockResolvedValue();
  const runtime = await composeStrigoiRuntime({ registry: {
    setResidentLifecycle: () => {}, onSessionUpdate: (fn: () => void) => { update = fn; return () => {}; },
  }, continuity: {}, succession: { delivery: { flush } }, onError: report } as unknown as Parameters<typeof composeStrigoiRuntime>[0]);
  return { runtime, flush, reconcile, report, update: () => update() };
}

it("coalesces lifecycle and delivery bursts into one trailing pass without overlapping flushes", async () => {
  const f = await fixture(), lifecycle = gate(), delivery = gate();
  f.reconcile.mockReturnValueOnce(lifecycle.promise);
  f.flush.mockReturnValueOnce(delivery.promise);
  f.runtime.start(); await tick();
  for (let i = 0; i < 100; i++) f.update();
  lifecycle.resolve(); await tick();
  expect(f.flush).toHaveBeenCalledTimes(1);
  for (let i = 0; i < 100; i++) f.update();
  await tick(); expect(f.flush).toHaveBeenCalledTimes(1);
  delivery.resolve(); await tick();
  expect(f.reconcile).toHaveBeenCalledTimes(2);
  expect(f.flush).toHaveBeenCalledTimes(2);
  f.runtime.dispose();
});

it.each(["lifecycle", "delivery"])("a failed %s pass releases ownership for a later update", async phase => {
  const f = await fixture(), failure = new Error("transient read failure");
  (phase === "lifecycle" ? f.reconcile : f.flush).mockRejectedValueOnce(failure);
  f.runtime.start(); await tick();
  expect(f.report).toHaveBeenCalledWith(failure);
  f.update(); await tick();
  expect(f.reconcile).toHaveBeenCalledTimes(2);
  expect(f.flush).toHaveBeenCalledTimes(phase === "lifecycle" ? 1 : 2);
  f.runtime.dispose();
});

it("does not start delivery or a trailing pass after disposal during lifecycle work", async () => {
  const f = await fixture(), pending = gate();
  f.reconcile.mockReturnValueOnce(pending.promise);
  f.runtime.start(); await tick(); f.update(); f.runtime.dispose();
  pending.resolve(); await tick();
  expect(f.flush).not.toHaveBeenCalled();
  expect(f.reconcile).toHaveBeenCalledOnce();
});
