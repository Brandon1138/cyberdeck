import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { SessionRuntime } from "../../src/domain/session-runtime.js";
import { PipeProcess } from "../../src/runtime/pipe-process.js";
import { PtyProcess } from "../../src/runtime/pty-process.js";
import { createSessionRuntime } from "../../src/runtime/session-runtime-adapter.js";

function sleepingSpec(transport?: "pty" | "pipe") {
  return {
    executable: process.execPath,
    args: ["-e", "setInterval(() => {}, 1_000)"],
    cwd: tmpdir(),
    env: process.env,
    ...(transport === undefined ? {} : { transport }),
  };
}

describe("createSessionRuntime", () => {
  it("adapts terminal launches to the session-runtime port", () => {
    const runtime: SessionRuntime = createSessionRuntime(sleepingSpec(), 4 * 1024);
    try {
      expect(runtime).toBeInstanceOf(PtyProcess);
    } finally {
      runtime.kill();
    }
  });

  it("adapts pipe launches to the same session-runtime port", () => {
    const runtime: SessionRuntime = createSessionRuntime(sleepingSpec("pipe"), 4 * 1024);
    try {
      expect(runtime).toBeInstanceOf(PipeProcess);
    } finally {
      runtime.kill();
    }
  });
});
