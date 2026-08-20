import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { SessionRuntime } from "../../src/domain/session-runtime.js";
import { PtyProcess, PtyReplayBuffer } from "../../src/runtime/pty-process.js";

const fixturePath = fileURLToPath(new URL("../fixtures/fake-agent.mjs", import.meta.url));

function waitForOutput(process: SessionRuntime, expected: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for ${expected}; received ${output}`));
    }, 2_000);
    const unsubscribe = process.onOutput((chunk) => {
      output += chunk.toString("utf8");
      if (output.includes(expected)) {
        clearTimeout(timer);
        unsubscribe();
        resolve(output);
      }
    });
  });
}

describe("PtyProcess", () => {
  it("retains byte-identical replay across partial and whole-chunk trims", () => {
    const chunks = [
      Buffer.from("first"),
      Buffer.from("\u754c", "utf8"),
      Buffer.from([0, 1, 2, 255]),
      Buffer.from("trailing output"),
    ];

    for (const capacity of [0, 1, 4, 8, 16, 1_024]) {
      const replay = new PtyReplayBuffer(capacity);
      let previous = Buffer.alloc(0);
      for (const chunk of chunks) {
        replay.append(chunk);
        previous = Buffer.concat([previous, chunk]);
        if (previous.length > capacity) {
          previous = previous.subarray(previous.length - capacity);
        }
        expect(replay.snapshot()).toEqual(previous);
      }
      const callerCopy = replay.snapshot();
      callerCopy.fill(0);
      expect(replay.snapshot()).toEqual(previous);
    }
  });

  it("coalesces one-byte appends into fixed-size retained blocks", () => {
    const capacity = 128 * 1024;
    const replay = new PtyReplayBuffer(capacity);
    const byte = Buffer.alloc(1, 0x61);
    const allocation = vi.spyOn(Buffer, "allocUnsafe");

    try {
      for (let index = 0; index < capacity; index += 1) replay.append(byte);
      byte[0] = 0x62;
      for (let index = 0; index < capacity; index += 1) replay.append(byte);

      expect(allocation).toHaveBeenCalledTimes(16);
      expect(allocation.mock.calls.every(([size]) => size === 16 * 1024)).toBe(true);
    } finally {
      allocation.mockRestore();
    }

    expect(replay.snapshot()).toEqual(Buffer.alloc(capacity, 0x62));
  });

  it("skips an oversized input prefix before allocating replay blocks", () => {
    const replay = new PtyReplayBuffer(1);
    const input = Buffer.alloc(128 * 1024, 0x61);
    input[input.length - 1] = 0x7a;
    const allocation = vi.spyOn(Buffer, "allocUnsafe");

    try {
      replay.append(input);
      expect(allocation).toHaveBeenCalledOnce();
      expect(allocation).toHaveBeenCalledWith(1);
    } finally {
      allocation.mockRestore();
    }

    expect(replay.snapshot()).toEqual(Buffer.from("z"));
  });

  it("keeps append cost flat as retained replay grows", () => {
    const chunk = Buffer.alloc(4 * 1024, 0x61);
    const measure = (capacity: number): number => {
      const replay = new PtyReplayBuffer(capacity);
      for (let retained = 0; retained < capacity; retained += chunk.length) {
        replay.append(chunk);
      }
      const started = process.hrtime.bigint();
      for (let index = 0; index < 1_000; index += 1) replay.append(chunk);
      return Number(process.hrtime.bigint() - started) / 1_000;
    };

    const bestOfFive = (capacity: number): number => Math.min(
      ...Array.from({ length: 5 }, () => measure(capacity)),
    );
    const smallReplayNs = bestOfFive(100 * 1024);
    const largeReplayNs = bestOfFive(10 * 1024 * 1024);

    console.info(
      `PTY replay append: 100 KiB ${smallReplayNs.toFixed(0)} ns/chunk; `
      + `10 MiB ${largeReplayNs.toFixed(0)} ns/chunk`,
    );
    expect(largeReplayNs).toBeLessThan(Math.max(smallReplayNs * 8, 5_000));
  });

  it("isolates replay from synchronous listener mutation", async () => {
    const process = new PtyProcess(
      {
        executable: globalThis.process.execPath,
        args: [fixturePath],
        cwd: "/tmp",
        env: { ...globalThis.process.env },
      },
      16 * 1024,
    );

    try {
      await waitForOutput(process, "READY");
      const echo = waitForOutput(process, "ECHO:mutate-now");
      const unsubscribe = process.onOutput((chunk) => chunk.fill(0));
      process.write(Buffer.from("mutate-now\n"));
      await echo;
      unsubscribe();

      expect(process.snapshot().toString("utf8")).toContain("ECHO:mutate-now");
    } finally {
      process.kill();
    }
  });

  it("isolates replay from later mutation of listener-retained buffers", async () => {
    const process = new PtyProcess(
      {
        executable: globalThis.process.execPath,
        args: [fixturePath],
        cwd: "/tmp",
        env: { ...globalThis.process.env },
      },
      16 * 1024,
    );

    try {
      await waitForOutput(process, "READY");
      const retained: Buffer[] = [];
      const echo = waitForOutput(process, "ECHO:mutate-later");
      const unsubscribe = process.onOutput((chunk) => retained.push(chunk));
      process.write(Buffer.from("mutate-later\n"));
      await echo;
      unsubscribe();

      await new Promise<void>((resolve) => setImmediate(resolve));
      for (const chunk of retained) chunk.fill(0);

      expect(process.snapshot().toString("utf8")).toContain("ECHO:mutate-later");
    } finally {
      process.kill();
    }
  });

  it("keeps working without listeners and retains replay output", async () => {
    const process = new PtyProcess(
      {
        executable: globalThis.process.execPath,
        args: [fixturePath],
        cwd: "/tmp",
        env: { ...globalThis.process.env },
      },
      16 * 1024,
    );

    try {
      await waitForOutput(process, "READY");
      const echo = waitForOutput(process, "ECHO:hello");
      process.write(Buffer.from("hello\n"));
      await echo;

      const firstWork = waitForOutput(process, "WORK:1");
      process.write(Buffer.from("/work\n"));
      await firstWork;
      await new Promise((resolve) => setTimeout(resolve, 180));

      expect(process.snapshot().toString("utf8")).toContain("WORK:DONE");
      expect(() => process.resize(100, 30)).not.toThrow();

      let exitEvents = 0;
      const exited = new Promise<number>((resolve) => {
        process.onExit((exitCode) => {
          exitEvents += 1;
          resolve(exitCode);
        });
      });
      process.write(Buffer.from("/exit\n"));
      await expect(exited).resolves.toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(exitEvents).toBe(1);
    } finally {
      process.kill();
    }
  });
});
