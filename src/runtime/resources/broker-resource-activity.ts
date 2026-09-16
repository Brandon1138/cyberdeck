import { join } from "node:path";
import type { AgentActivityPort } from "../../orchestration/agent-activity-port.js";
import type { ResourceSummary } from "../../domain/resource-summary.js";
import type { brokerResourceRuntime } from "./broker-resource-runtime.js";
import { ResourceActivityBridge } from "./resource-activity-bridge.js";

/** Measurement projection only: no sampling commands, worker input or arbitrary exporter fields. */
export async function brokerResourceActivity(options: {
  directory: string; installationId: string; brokerId: string; activity: AgentActivityPort;
  resource: NonNullable<Awaited<ReturnType<typeof brokerResourceRuntime>>>; parked(): number;
}) {
  let peak: number | null = null;
  const bridge = await ResourceActivityBridge.open({ path: join(options.directory, "resource-activity.json"),
    installationId: options.installationId, brokerId: options.brokerId, activity: options.activity,
    assertOwner: options.resource.assertOwner,
    readSummary: () => {
      const health = options.resource.health(), now = Date.now(), admission = health.admission;
      const fresh = "observedAt" in health && now - Date.parse(health.observedAt) <= 15000;
      const observed = fresh && "conservativePhysicalUpperBytes" in health ? health.conservativePhysicalUpperBytes : null;
      if (observed !== null) peak = Math.max(peak ?? 0, observed);
      const reason: ResourceSummary["reason"] = observed === null ? "metrics-unavailable"
        : observed > admission.policy.totalBytes ? "budget-breach"
        : "pressure" in health && health.pressure !== "normal" ? "host-pressure"
        : admission.hold?.includes("capture-gap") ? "capture-gap"
        : admission.queue.length ? "waiting-capacity" : "healthy";
      return { observedBytes: observed, reservedBytes: admission.reservedBytes, limitBytes: admission.policy.totalBytes,
        peakBytes: peak, uncertainBytes: admission.policy.uncertainBytes,
        active: fresh && "activeWorkloads" in health ? health.activeWorkloads : null, parked: options.parked(), queued: admission.queue.length,
        queueDelayMs: Math.min(86400000, Math.max(0, ...admission.queue.map(q => now - Date.parse(q.queuedAt)))),
        eventLoopP99Ms: fresh && "eventLoopP99Ms" in health ? Math.min(86400000, health.eventLoopP99Ms) : null,
        sampleDurationMs: fresh && "sampleDurationMs" in health ? Math.min(86400000, health.sampleDurationMs) : null,
        enforcement: "operational", reason };
    },
  });
  await bridge.tick();
  const timer = setInterval(() => { void bridge.tick(); }, 5000).unref();
  return { health: () => bridge.health(), close: async () => { clearInterval(timer); await bridge.close(); } };
}
