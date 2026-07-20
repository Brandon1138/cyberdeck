import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PtyProcess } from "../../src/runtime/pty-process.js";

const fixturePath = fileURLToPath(new URL("../fixtures/fake-agent.mjs", import.meta.url));

function waitForOutput(process: PtyProcess, expected: string): Promise<string> {
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
