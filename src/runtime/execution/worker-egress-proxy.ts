import { lookup } from "node:dns/promises";
import { createServer } from "node:http";
import { connect, isIP, type AddressInfo, type Socket } from "node:net";

/** Exact destinations used by the pinned Claude/Codex CLIs. No wildcard domains or generic web access. */
export const WORKER_HTTPS_HOSTS = new Set(["api.anthropic.com", "chatgpt.com", "api.openai.com", "auth.openai.com"]);
export function permittedConnectTarget(authority: string): string | undefined {
  const match = /^([a-z0-9.-]+):443$/.exec(authority);
  return match && WORKER_HTTPS_HOSTS.has(match[1]!) ? match[1] : undefined;
}
/** IPv4 only, fail closed for special-use, private, loopback, link-local and IPv6/mapped addresses. */
export function publicWorkerAddress(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split(".").map(Number) as [number, number, number];
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 192 && b === 0) || (a === 192 && b === 88 && c === 99)
    || (a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)) || (a === 203 && b === 0 && c === 113));
}
export async function resolveWorkerDestination(hostname: string,
  resolve: (hostname: string) => Promise<Array<{ address: string }>> = (name) => lookup(name, { family: 4, all: true }),
): Promise<string> {
  if (!WORKER_HTTPS_HOSTS.has(hostname)) throw new Error("WORKER_EGRESS_DESTINATION_REFUSED");
  const addresses = await resolve(hostname);
  if (!addresses.length || addresses.some(({ address }) => !publicWorkerAddress(address))) throw new Error("WORKER_EGRESS_ADDRESS_REFUSED");
  return addresses[0]!.address;
}

/** TLS passes through unchanged. No credentials, HTTP bodies or URLs are logged or persisted. */
export class WorkerEgressProxy {
  private readonly sockets = new Set<Socket>();
  private closed = false;
  private readonly server = createServer((_request, response) => { response.writeHead(403); response.end(); });
  constructor() {
    this.server.maxConnections = 64;
    this.server.headersTimeout = 5000;
    this.server.requestTimeout = 5000;
    this.server.on("connection", (socket) => { this.track(socket); socket.setTimeout(120_000, () => socket.destroy()); });
    this.server.on("connect", (request, stream, head) => {
      const socket = stream as Socket;
      const hostname = permittedConnectTarget(request.url ?? "");
      const refuse = () => { if (!socket.destroyed) socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); };
      if (!hostname || request.headers.origin !== undefined || head.length) { refuse(); return; }
      void resolveWorkerDestination(hostname).then((address) => {
        if (this.closed || socket.destroyed) return;
        // Pin the validated numeric address: never perform a second DNS lookup at connect time.
        const upstream = connect({ host: address, port: 443, family: 4 });
        this.track(upstream);
        upstream.setTimeout(120_000, () => upstream.destroy());
        const deadline = setTimeout(() => upstream.destroy(), 5000).unref();
        upstream.once("connect", () => {
          clearTimeout(deadline);
          socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          socket.pipe(upstream); upstream.pipe(socket);
        });
        upstream.on("error", () => socket.destroy());
        upstream.on("close", () => { clearTimeout(deadline); socket.destroy(); });
        socket.on("close", () => upstream.destroy());
      }).catch(refuse);
    });
  }
  private track(socket: Socket): void {
    this.sockets.add(socket); socket.on("error", () => {});
    socket.once("close", () => this.sockets.delete(socket));
  }
  async listen(): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => { this.server.off("error", reject); resolve(); });
    });
    return (this.server.address() as AddressInfo).port;
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const socket of this.sockets) socket.destroy();
    if (this.server.listening) await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
