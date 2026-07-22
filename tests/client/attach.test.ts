import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { attachSession, type AttachTransport } from "../../src/client/attach.js";
import type { ClientFrame, ServerFrame } from "../../src/protocol/frames.js";

class FakeInput extends EventEmitter {
  isTTY = true;
  isRaw = false;
  readonly setRawMode = vi.fn((raw: boolean) => { this.isRaw = raw; return this; });
  readonly resume = vi.fn();
  readonly pause = vi.fn();
}

class FakeOutput {
  isTTY = true;
  columns = 120;
  rows = 40;
  readonly chunks: Buffer[] = [];
  write(chunk: string | Uint8Array): boolean {
    this.chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
    return true;
  }
}

class FakeTransport implements AttachTransport {
  readonly sent: ClientFrame[] = [];
  readonly close = vi.fn();
  private readonly frameListeners = new Set<(frame: ServerFrame) => void>();
  private readonly closeListeners = new Set<() => void>();

  constructor(private readonly sessionKind?: "worker" | "orchestrator") {}

  async request<T>(): Promise<T> {
    this.emitFrame({
      type: "output",
      sessionId: TEST_SESSION_ID,
      data: Buffer.from("LIVE").toString("base64"),
    });
    return {
      data: Buffer.from("REPLAY").toString("base64"),
      ...(this.sessionKind === undefined ? {} : { session: { kind: this.sessionKind } }),
    } as T;
  }
  sendFrame(frame: ClientFrame): void { this.sent.push(frame); }
  onFrame(listener: (frame: ServerFrame) => void): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }
  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }
  emitFrame(frame: ServerFrame): void { for (const listener of this.frameListeners) listener(frame); }
  emitClose(): void { for (const listener of this.closeListeners) listener(); }
}

const TEST_SESSION_ID = "11111111-1111-4111-8111-111111111111";

describe("attachSession", () => {
  it("bridges control input, replay, resize, and Ctrl-] with raw-mode cleanup", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const signals = new EventEmitter();
    const transport = new FakeTransport();
    const attached = attachSession({
      sessionId: TEST_SESSION_ID,
      mode: "control",
      transport,
      input,
      output,
      signals,
    });
    await new Promise((resolve) => setImmediate(resolve));

    input.emit("data", Buffer.from("hello"));
    signals.emit("SIGWINCH");
    input.emit("data", Buffer.from([0x1d]));

    await expect(attached).resolves.toBe(0);
    expect(Buffer.concat(output.chunks).toString()).toBe("REPLAYLIVE");
    expect(transport.sent).toContainEqual({
      type: "input", sessionId: TEST_SESSION_ID, data: Buffer.from("hello").toString("base64"),
    });
    expect(transport.sent).toContainEqual({
      type: "resize", sessionId: TEST_SESSION_ID, cols: 120, rows: 40,
    });
    expect(transport.sent).toContainEqual({ type: "detach", sessionId: TEST_SESSION_ID });
    expect(transport.sent.some((frame) => frame.type === "input" && Buffer.from(frame.data, "base64").includes(0x1d))).toBe(false);
    expect(input.setRawMode).toHaveBeenNthCalledWith(1, true);
    expect(input.setRawMode).toHaveBeenLastCalledWith(false);
  });

  it("keeps watch mode read-only and reports socket closure as non-zero", async () => {
    const input = new FakeInput();
    const transport = new FakeTransport();
    const attached = attachSession({
      sessionId: TEST_SESSION_ID,
      mode: "watch",
      transport,
      input,
      output: new FakeOutput(),
      signals: new EventEmitter(),
    });
    await new Promise((resolve) => setImmediate(resolve));
    input.emit("data", Buffer.from("must-not-send"));
    transport.emitClose();
    await expect(attached).resolves.toBe(1);
    expect(transport.sent).toEqual([]);
    expect(input.setRawMode).not.toHaveBeenCalled();
  });

  it("requires a TTY for control mode", async () => {
    const input = new FakeInput();
    input.isTTY = false;
    await expect(attachSession({
      sessionId: TEST_SESSION_ID,
      mode: "control",
      transport: new FakeTransport(),
      input,
      output: new FakeOutput(),
      signals: new EventEmitter(),
    })).rejects.toThrow("TTY");
  });

  it("can detach back to an enclosing fleet without closing its shared transport", async () => {
    const input = new FakeInput();
    const transport = new FakeTransport();
    const attached = attachSession({
      sessionId: TEST_SESSION_ID,
      mode: "control",
      transport,
      input,
      output: new FakeOutput(),
      signals: new EventEmitter(),
      closeTransport: false,
    });
    await new Promise((resolve) => setImmediate(resolve));
    input.emit("data", Buffer.from([0x1d]));

    await expect(attached).resolves.toBe(0);
    expect(transport.close).not.toHaveBeenCalled();
  });

  it("uses Left Arrow as the directional return from a provider thread to the fleet", async () => {
    const input = new FakeInput();
    const transport = new FakeTransport();
    const attached = attachSession({
      sessionId: TEST_SESSION_ID,
      mode: "control",
      transport,
      input,
      output: new FakeOutput(),
      signals: new EventEmitter(),
      closeTransport: false,
    });
    await new Promise((resolve) => setImmediate(resolve));
    input.emit("data", Buffer.from("\u001b[D"));

    await expect(attached).resolves.toBe(0);
    expect(transport.sent).toContainEqual({ type: "detach", sessionId: TEST_SESSION_ID });
    expect(transport.sent.some((frame) => frame.type === "input")).toBe(false);
  });

  it("forwards Left Arrow inside an orchestrator and keeps Ctrl-] as its detach key", async () => {
    const input = new FakeInput();
    const transport = new FakeTransport("orchestrator");
    const attached = attachSession({
      sessionId: TEST_SESSION_ID,
      mode: "control",
      transport,
      input,
      output: new FakeOutput(),
      signals: new EventEmitter(),
      closeTransport: false,
    });
    await new Promise((resolve) => setImmediate(resolve));
    input.emit("data", Buffer.from("\u001b[D"));
    await new Promise((resolve) => setImmediate(resolve));

    expect(transport.sent).toContainEqual({
      type: "input",
      sessionId: TEST_SESSION_ID,
      data: Buffer.from("\u001b[D").toString("base64"),
    });
    expect(transport.sent.some((frame) => frame.type === "detach")).toBe(false);

    input.emit("data", Buffer.from([0x1d]));
    await expect(attached).resolves.toBe(0);
    expect(transport.sent).toContainEqual({ type: "detach", sessionId: TEST_SESSION_ID });
  });

  it("returns and cleans up raw mode when the provider exits while attached", async () => {
    const input = new FakeInput();
    const transport = new FakeTransport();
    const attached = attachSession({
      sessionId: TEST_SESSION_ID,
      mode: "control",
      transport,
      input,
      output: new FakeOutput(),
      signals: new EventEmitter(),
      closeTransport: false,
    });
    await new Promise((resolve) => setImmediate(resolve));
    transport.emitFrame({ type: "session-ended", sessionId: TEST_SESSION_ID, exitCode: 0 });

    await expect(attached).resolves.toBe(0);
    expect(input.setRawMode).toHaveBeenLastCalledWith(false);
    expect(transport.close).not.toHaveBeenCalled();
  });

  it("detaches a claimed controller if rendering the replay fails", async () => {
    const transport = new FakeTransport();
    const attached = attachSession({
      sessionId: TEST_SESSION_ID,
      mode: "control",
      transport,
      input: new FakeInput(),
      output: { write: () => { throw new Error("terminal write failed"); } },
      signals: new EventEmitter(),
      closeTransport: false,
    });

    await expect(attached).rejects.toThrow("terminal write failed");
    expect(transport.sent).toContainEqual({ type: "detach", sessionId: TEST_SESSION_ID });
  });
});
