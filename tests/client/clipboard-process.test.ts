import { describe, expect, it } from "vitest";
import { runClipboardCommand } from "../../src/client/clipboard-process.js";

describe("bounded clipboard reader processes", () => {
  it("preserves binary PNG bytes without decoding or adding a newline", async () => {
    const result = await runClipboardCommand(process.execPath, ["-e", "process.stdout.write(Buffer.from([137,80,78,71,13,10,26,10,0,255]))"], {
      env: {}, maxBytes: 32, timeoutMs: 2_000,
    });
    expect(result).toEqual({ status: "ok", stdout: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255]) });
  });

  it("returns a bounded failure for a stalled clipboard reader", async () => {
    const start = performance.now();
    const result = await runClipboardCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      env: {}, maxBytes: 32, timeoutMs: 100,
    });
    expect(result).toMatchObject({ status: "failed", failure: "timeout" });
    expect(performance.now() - start).toBeLessThan(2_000);
  });

  it.each(["stdout", "stderr"])("bounds oversized %s without retaining clipboard content", async (pipe) => {
    const result = await runClipboardCommand(process.execPath, ["-e", `process.${pipe}.write(Buffer.alloc(65536, 65))`], {
      env: {}, maxBytes: 32, timeoutMs: 2_000,
    });
    expect(result).toEqual({ status: "failed", failure: "too-large", stderr: Buffer.alloc(0) });
  });

  it("distinguishes missing binaries from an empty clipboard", async () => {
    const result = await runClipboardCommand("/nonexistent/cyberdeck-clipboard-reader", [], { env: {}, maxBytes: 32, timeoutMs: 1_000 });
    expect(result).toEqual({ status: "failed", failure: "missing", stderr: Buffer.alloc(0) });
  });

  it("retains a nonzero exit code for the Windows no-image protocol", async () => {
    const result = await runClipboardCommand(process.execPath, ["-e", "process.exit(3)"], { env: {}, maxBytes: 32, timeoutMs: 2_000 });
    expect(result).toEqual({ status: "failed", failure: "exit", exitCode: 3, stderr: Buffer.alloc(0) });
  });
});
