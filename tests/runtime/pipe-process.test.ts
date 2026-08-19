import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { SessionRuntime } from "../../src/domain/session-runtime.js";
import { PipeProcess } from "../../src/runtime/pipe-process.js";

describe("PipeProcess", () => {
  it("captures stdout and stderr and settles only after the one-shot process closes", async () => {
    const processHandle: SessionRuntime = new PipeProcess({
      executable: process.execPath,
      args: [
        "-e",
        "process.stdout.write('frame-one\\n'); process.stderr.write('diagnostic\\n')",
      ],
      cwd: tmpdir(),
      env: process.env,
      transport: "pipe",
    }, 4 * 1024);
    const chunks: string[] = [];
    processHandle.onOutput((chunk) => chunks.push(chunk.toString("utf8")));
    const exitCode = await new Promise<number>((resolve) => {
      processHandle.onExit(resolve);
    });

    expect(exitCode).toBe(0);
    expect(chunks.join("")).toContain("frame-one");
    expect(chunks.join("")).toContain("cyberdeck_stderr");
    expect(processHandle.snapshot().toString("utf8")).toContain("diagnostic");
    expect(() => processHandle.write(Buffer.from("input"))).toThrow(
      "do not accept interactive input",
    );
  });
});
