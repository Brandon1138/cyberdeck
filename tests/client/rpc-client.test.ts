import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { RpcClient } from "../../src/client/rpc-client.js";
import { ClientFrameSchema } from "../../src/protocol/frames.js";
import { encodeFrame, JsonlDecoder } from "../../src/protocol/jsonl.js";

describe("RpcClient", () => {
  it("correlates concurrent responses, streams output, and rejects failures and closure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cyberdeck-rpc-"));
    const socketPath = join(directory, "rpc.sock");
    const server = createServer((socket) => {
      const requests: Array<{ id: number; method: string }> = [];
      const decoder = new JsonlDecoder(ClientFrameSchema);
      socket.on("data", (chunk) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        for (const frame of decoder.push(bytes)) {
          if (frame.type !== "request") continue;
          requests.push(frame);
          if (requests.length === 2) {
            socket.write(encodeFrame({ type: "response", id: requests[1]!.id, ok: true, result: "second" }));
            socket.write(encodeFrame({ type: "output", sessionId: crypto.randomUUID(), data: "aGk=" }));
            socket.write(encodeFrame({ type: "response", id: requests[0]!.id, ok: true, result: "first" }));
          }
          if (frame.method === "fail") {
            socket.write(encodeFrame({
              type: "response", id: frame.id, ok: false,
              error: { code: "EXACT_FAILURE", message: "failed exactly" },
            }));
          }
          if (frame.method === "hang") setImmediate(() => socket.destroy());
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const client = await RpcClient.connect(socketPath);
    const streamed: unknown[] = [];
    client.onFrame((frame) => streamed.push(frame));

    try {
      const first = client.request<string>("first", {});
      const second = client.request<string>("second", {});
      await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
      expect(streamed).toHaveLength(1);
      await expect(client.request("fail", {})).rejects.toMatchObject({ code: "EXACT_FAILURE" });
      await expect(client.request("hang", {})).rejects.toMatchObject({ code: "BROKER_DISCONNECTED" });
    } finally {
      client.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
