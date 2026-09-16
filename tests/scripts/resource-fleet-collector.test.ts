import { describe, it, expect } from "vitest";
import { CollectorConfigSchema, preflight, collectSequence, bounded } from "../../scripts/resource-fleet/collector.js";
describe("resource fleet fail-closed collector", () => {
  it("only requests allowlisted read-only health and never trusts healthy payload as acceptance", async () => {
    const calls: string[] = [];
    const result = await preflight(async method => { calls.push(method); return { configured: true, secret: "not-for-evidence", brokerId: "claimed" }; }, 100);
    expect(calls).toEqual(["resource.health", "execution.health", "evaluation.health", "activity.health"]);
    expect(result.status).toBe("unverified"); expect(result.launches).toBe(0);
    expect(JSON.stringify(result)).not.toContain("not-for-evidence"); expect(result.blockers).toHaveLength(4);
  });
  it("retains unavailable health without guessing zero usage", async () => {
    const result = await preflight(async () => { throw new Error("secret"); }, 100);
    expect(result.observations.every(row => !row.received && row.configured === null)).toBe(true);
  });
  it("aborts bounded work", async () => {
    let aborted = false;
    await expect(bounded(signal => new Promise(() => signal.addEventListener("abort", () => { aborted = true; })), 5)).rejects.toThrow("collector-timeout");
    expect(aborted).toBe(true);
  });
  it("runs one warmup and three measured runs sequentially with cleanup and preserved failure", async () => {
    const order: string[] = [], rows: any[] = [];
    await collectSequence({ run: async input => {
      order.push(input.phase); expect(input.workerCount).toBe(8);
      if (order.length === 1) throw new Error("warmup-failure");
      return { captureComplete: true, dispositions: 8, terminalAttempts: 8, failures: [] };
    }, cleanup: async () => { order.push("cleanup"); return { complete: true, unexplained: 0 }; } }, 100, async row => { rows.push(row); });
    expect(order).toEqual(["warmup", "cleanup", "measured", "cleanup", "measured", "cleanup", "measured", "cleanup"]);
    expect(rows).toHaveLength(8); expect(rows[1].failure).toBe("run-failed-or-timeout");
    expect(rows.every(row => row.status === "unverified")).toBe(true);
  });
  it("stops after uncertain teardown and keeps intent and disposition", async () => {
    const rows: object[] = [];
    await collectSequence({ run: async () => { throw new Error("failed"); }, cleanup: async () => ({ complete: false, unexplained: 1 }) }, 100, async row => { rows.push(row); });
    expect(rows).toHaveLength(2);
  });
  it("rejects arbitrary timestamp evidence and API choices", () => {
    const choice = { provider: "codex", model: "explicit-model", effort: "high", authMode: "subscription" };
    const valid = { candidate: { sourceSha: "a".repeat(40), dirty: false, configSha256: "b".repeat(64), profileSha256: "c".repeat(64), imageDigest: "sha256:" + "d".repeat(64) },
      brokerId: "11111111-1111-4111-8111-111111111111", installationId: "22222222-2222-4222-8222-222222222222",
      socket: "/private/tmp/cd-resource-test.sock", configFile: "/private/config", profileFile: "/private/profile",
      workers: Array.from({ length: 8 }, (_, i) => ({ ...choice, provider: i % 2 ? "codex" : "claude" })),
      orchestrator: { ...choice, runtime: "first-party-codex" }, timeoutMs: 1000, sampleIntervalMs: 1000 };
    expect(CollectorConfigSchema.safeParse(valid).success).toBe(true);
    expect(CollectorConfigSchema.safeParse({ ...valid, readyAt: new Date().toISOString() }).success).toBe(false);
    expect(CollectorConfigSchema.safeParse({ ...valid, orchestrator: { ...valid.orchestrator, authMode: "api" } }).success).toBe(false);
    expect(CollectorConfigSchema.safeParse({ ...valid, socket: "/tmp/main.sock" }).success).toBe(false);
    expect(CollectorConfigSchema.safeParse({ ...valid, workers: Array(8).fill(choice) }).success).toBe(false);
  });
});
