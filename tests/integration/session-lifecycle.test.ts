import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { BrokerServer } from "../../src/broker/server.js";
import { SessionRegistry } from "../../src/broker/session-registry.js";
import { RpcClient } from "../../src/client/rpc-client.js";
import { BrokerRuntimeConfigSchema } from "../../src/config.js";
import type { SessionRecord } from "../../src/domain/session.js";
import type { ProviderAdapter } from "../../src/providers/provider.js";
import { PtyProcess } from "../../src/runtime/pty-process.js";

const fixturePath = fileURLToPath(new URL("../fixtures/fake-agent.mjs", import.meta.url));

function fakeAdapter(id: "codex" | "claude"): ProviderAdapter {
  return {
    id,
    buildLaunchSpec: (session) => ({
      executable: process.execPath,
      args: [fixturePath],
      cwd: session.cwd,
      env: { ...process.env },
    }),
    buildResumeSpec: (session) => ({
      executable: process.execPath,
      args: [fixturePath],
      cwd: session.cwd,
      env: { ...process.env },
    }),
  };
}

function waitForOutput(client: RpcClient, sessionId: string, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for ${expected}; received ${output}`));
    }, 2_000);
    const unsubscribe = client.onFrame((frame) => {
      if (frame.type !== "output" || frame.sessionId !== sessionId) return;
      output += Buffer.from(frame.data, "base64").toString("utf8");
      if (output.includes(expected)) {
        clearTimeout(timer);
        unsubscribe();
        resolve();
      }
    });
  });
}

describe("complete session lifecycle", () => {
  it.each(Array.from({ length: 10 }, (_, index) => index))(
    "keeps work alive through detach and replay (case %i)",
    async () => {
      const socketPath = `/tmp/cyberdeck-int-${randomUUID().slice(0, 8)}.sock`;
      const ptyFactory = vi.fn((spec, replayBytes: number) => new PtyProcess(spec, replayBytes));
      const registry = new SessionRegistry({
        adapters: { codex: fakeAdapter("codex"), claude: fakeAdapter("claude") },
        ptyFactory,
        journal: { append: async () => {} },
        config: BrokerRuntimeConfigSchema.parse({ maxConcurrentSessions: 8 }),
      });
      const server = new BrokerServer({ socketPath, registry });
      await server.listen();
      const admin = await RpcClient.connect(socketPath);
      const controller = await RpcClient.connect(socketPath);
      const watcher = await RpcClient.connect(socketPath);
      let reattached: RpcClient | undefined;

      try {
        const codex = await admin.request<SessionRecord>("session.start", {
          provider: "codex", cwd: "/tmp", detached: true, sandbox: "read-only",
        });
        const claude = await admin.request<SessionRecord>("session.start", {
          provider: "claude", cwd: "/tmp", detached: true, sandbox: "read-only",
        });
        await controller.request("session.attach", { sessionId: codex.id });
        await watcher.request("session.watch", { sessionId: claude.id });

        const firstWork = waitForOutput(controller, codex.id, "WORK:1");
        await controller.request("session.send", {
          sessionId: codex.id,
          data: Buffer.from("/work\n").toString("base64"),
        });
        await firstWork;
        const disconnected = new Promise<void>((resolve) => controller.onClose(resolve));
        controller.close();
        await disconnected;
        await new Promise((resolve) => setTimeout(resolve, 220));

        reattached = await RpcClient.connect(socketPath);
        const replay = await reattached.request<{ data: string }>("session.attach", { sessionId: codex.id });
        expect(Buffer.from(replay.data, "base64").toString("utf8")).toContain("WORK:DONE");

        const child = await admin.request<SessionRecord>("session.start", {
          provider: "claude",
          cwd: "/tmp",
          detached: true,
          sandbox: "read-only",
          role: "luna-high-scout",
          parentSessionId: codex.id,
        });
        expect(child.role).toBe("luna-high-scout");
        expect(ptyFactory).toHaveBeenCalledTimes(3);

        await expect(admin.request("session.start", {
          provider: "claude",
          cwd: "/tmp",
          detached: true,
          sandbox: "read-only",
          model: "fable",
          parentSessionId: codex.id,
        })).rejects.toMatchObject({ code: "FABLE_REQUIRES_EXPLICIT_HUMAN_START" });
        expect(ptyFactory).toHaveBeenCalledTimes(3);

        await admin.request("session.stop", { sessionId: child.id });
        await admin.request("session.stop", { sessionId: codex.id });
        await admin.request("session.stop", { sessionId: claude.id });
      } finally {
        reattached?.close();
        watcher.close();
        admin.close();
        await registry.stopAll();
        await server.close();
      }
    },
  );
});
