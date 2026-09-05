import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WorkerEventSubmitParamsSchema, type WorkerEventChannel } from "./worker-event-channel.js";

interface Grant { digest: Buffer; workerId: string; executionId: string; generation: number }
export interface GatewayBinding { workerId: string; executionId: string; generation: number }
/** A report-only boundary. No generic broker proxy, operator calls or controller derivation. */
export class WorkerGateway {
  private readonly grants = new Map<string, Grant>();
  private readonly server: Server;
  constructor(private readonly events: Pick<WorkerEventChannel, "submit">,
    private readonly active: (binding: GatewayBinding) => boolean,
  ) {
    this.server = createServer((request, response) => {
      const respond = (status: number, body: unknown) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
      void (async () => {
        if (request.method !== "POST" || request.url !== "/v1/report" || request.headers.origin !== undefined
          || request.headers["content-type"] !== "application/json") return respond(404, { code: "GATEWAY_METHOD_REFUSED" });
        const bearer = request.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
        const digest = createHash("sha256").update(bearer ?? "").digest();
        const grant = [...this.grants.values()].find((entry) => timingSafeEqual(entry.digest, digest));
        if (grant === undefined || !this.active(grant)) return respond(401, { code: "GATEWAY_UNAUTHORIZED" });
        let body = Buffer.alloc(0);
        for await (const chunk of request) {
          if (body.length + chunk.length > 64 * 1024) { respond(413, { code: "GATEWAY_BODY_LIMIT" }); request.destroy(); return; }
          body = Buffer.concat([body, chunk]);
        }
        const value: unknown = JSON.parse(body.toString());
        const input = WorkerEventSubmitParamsSchema.strict().parse(value);
        if (input.workerId !== grant.workerId || input.eventId === undefined || !this.active(grant)) return respond(403, { code: "GATEWAY_SCOPE_REFUSED" });
        // Existing facade retains canonical capability/lease checks and durable event idempotency.
        return respond(200, await this.events.submit(input));
      })().catch(() => { if (!response.headersSent) respond(400, { code: "GATEWAY_REQUEST_FAILED" }); });
    });
    this.server.requestTimeout = 10_000;
    this.server.headersTimeout = 5_000;
    this.server.maxConnections = 16;
  }
  issue(binding: GatewayBinding): string {
    const token = randomBytes(32).toString("hex");
    this.grants.set(binding.executionId, { ...binding, digest: createHash("sha256").update(token).digest() });
    return token;
  }
  revoke(executionId: string): void { this.grants.delete(executionId); }
  async listen(): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => { this.server.off("error", reject); resolve(); });
    });
    return (this.server.address() as AddressInfo).port;
  }
  async close(): Promise<void> {
    this.grants.clear();
    if (!this.server.listening) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()));
  }
}
