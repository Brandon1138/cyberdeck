import * as Sentry from "@sentry/node";
import { SentryPropagator, SentrySampler, SentrySpanProcessor } from "@sentry/opentelemetry";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { AgentActivity } from "../domain/agent-activity.js";
import { projectActivity, sanitizeSentryEnvelope } from "./activity-projection.js";
import { BoundedExportQueue } from "./bounded-export-queue.js";
import { TelemetryBudget } from "./telemetry-budget.js";

export interface SentrySinkOptions {
  dsn: string; dailyCap: number; sampleRate: number;
  /** Required explicit activation; a DSN's presence is never authorization. */
  enabled: true;
  budgetStateFile?: string;
  send?: (body: string) => Promise<{ status: number }>;
}
/** Optional bounded metadata sink. SDK automatic integrations and ambient event forwarding are disabled. */
export class SentrySink {
  private readonly provider: NodeTracerProvider;
  private readonly budget: TelemetryBudget;
  private readonly queue: BoundedExportQueue;
  private closed = false;
  private dropped = 0;
  constructor(options: SentrySinkOptions) {
    if (options.enabled !== true || Sentry.isInitialized()) throw new Error("TELEMETRY_SETUP_REFUSED");
    const dsn = new URL(options.dsn);
    if (dsn.protocol !== "https:" || !/^[a-f0-9]+$/.test(dsn.username) || !/^\/\d+$/.test(dsn.pathname) || dsn.password) throw new Error("SENTRY_DSN_INVALID");
    const endpoint = `https://${dsn.host}/api${dsn.pathname}/envelope/`;
    this.queue = new BoundedExportQueue(options.send ?? (async (body) => {
      const response = await fetch(endpoint, { method: "POST", redirect: "error", signal: AbortSignal.timeout(2000),
        headers: { "content-type": "application/x-sentry-envelope", "x-sentry-auth": `Sentry sentry_version=7,sentry_key=${dsn.username}` }, body });
      await response.body?.cancel(); return { status: response.status };
    }));
    if (options.send === undefined && options.budgetStateFile === undefined) throw new Error("TELEMETRY_DURABLE_BUDGET_REQUIRED");
    this.budget = new TelemetryBudget(options.dailyCap, options.sampleRate, Date.now, options.budgetStateFile);
    const client = Sentry.init({ dsn: options.dsn, skipOpenTelemetrySetup: true, defaultIntegrations: false,
      registerEsmLoaderHooks: false, tracesSampleRate: 1, sendDefaultPii: false, sendClientReports: false,
      transport: () => ({
        send: async (envelope) => {
          const body = sanitizeSentryEnvelope(envelope);
          if (body === undefined || this.closed) { this.dropped += 1; return { statusCode: 200 }; }
          this.queue.enqueue(body); return { statusCode: 200 };
        },
        flush: async () => { await this.queue.pump(); return this.queue.health().queued === 0; },
      }),
    });
    if (!client) throw new Error("SENTRY_INITIALIZATION_FAILED");
    this.provider = new NodeTracerProvider({ sampler: new SentrySampler(client), spanProcessors: [new SentrySpanProcessor()] });
    this.provider.register({ propagator: new SentryPropagator(), contextManager: new Sentry.SentryContextManager() });
    Sentry.validateOpenTelemetrySetup();
  }
  record(event: AgentActivity): void {
    if (this.closed) return;
    try {
      if (!this.budget.admit(event.runId, event.eventId)) return;
      const projection = projectActivity(event);
      Sentry.startNewTrace(() => Sentry.startSpan({ name: projection.operation, op: projection.operation,
        attributes: { "cyberdeck.projection": JSON.stringify(projection) } }, () => {}));
    } catch { this.dropped += 1; }
  }
  health(): { queued: number; dropped: number; budget: ReturnType<TelemetryBudget["health"]> } {
    return { queued: this.queue.health().queued, dropped: this.dropped + this.queue.health().dropped, budget: this.budget.health() };
  }
  async flush(): Promise<void> { await this.provider.forceFlush(); await Sentry.flush(2000); await this.queue.pump(); }
  async close(): Promise<void> {
    await this.flush().catch(() => undefined); this.closed = true; this.queue.close();
    await this.provider.shutdown().catch(() => undefined); await Sentry.close(2000).catch(() => undefined);
  }
}
