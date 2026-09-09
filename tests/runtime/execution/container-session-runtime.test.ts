import { describe, expect, it, vi } from "vitest";
import { ContainerSessionRuntime } from "../../../src/runtime/execution/container-session-runtime.js";
import type { OrbStackClient, ContainerInspection } from "../../../src/runtime/execution/orbstack-client.js";
import type { ExecutionRef } from "../../../src/domain/worker-execution.js";

describe("container stop confirmation", () => {
  it("escalates a pending graceful stop and publishes exactly one confirmed exit", async () => {
    let finishGraceful!: (inspection: ContainerInspection) => void;
    const inspected = { State: { Running: false, ExitCode: 137 } } as ContainerInspection;
    const stop = vi.fn((_ref, force) => force ? Promise.resolve(inspected) : new Promise<ContainerInspection>((resolve) => { finishGraceful = resolve; }));
    const release = vi.fn(), failure = vi.fn(), exit = vi.fn();
    const runtime = new ContainerSessionRuntime({ pid: 1, write: vi.fn(), resize: vi.fn(), snapshot: () => Buffer.alloc(0),
      kill: vi.fn(), onOutput: () => () => {}, onExit: () => () => {},
    }, { stop } as unknown as OrbStackClient, {} as ExecutionRef, release, failure);
    runtime.onExit(exit);
    runtime.kill("SIGTERM");
    runtime.kill("SIGKILL");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(137));
    expect(stop.mock.calls.map((call) => call[1])).toEqual([false, true]);
    finishGraceful(inspected);
    await new Promise((resolve) => setImmediate(resolve));
    expect(release).toHaveBeenCalledOnce(); expect(exit).toHaveBeenCalledOnce(); expect(failure).not.toHaveBeenCalled();
  });
});
